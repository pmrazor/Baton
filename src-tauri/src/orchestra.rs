//! Agent mode: a lead agent delegates tasks to team members.
//!
//! Baton serves a small MCP server on 127.0.0.1. Each lead session gets its
//! own bearer token, so a tool call is attributed to the lead that made it.
//! A delegated task is an ordinary ACP session created through the hub; its
//! progress streams to the UI like any chat, and this module tracks status,
//! the final answer, and serialises file-writing tasks per workspace.
//!
//! Events for the UI:
//!   - `task-update`      a task's status changed (TaskInfo)
//!   - `task-session`     a task's session exists (so the UI can list it)
//!   - `task-brief`       the lead sent a follow-up instruction to a task
//!   - `inbox-delivered`  queued user messages were delivered in a tool result

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::hub::{Hub, Launch};
use crate::profiles::{Profiles, DEFAULT_PROFILE, PROFILE_KEY};
use crate::teams::{pick_fallback, Member, Team, Teams};
use crate::worktree::{self, Sandbox};

const SERVER_NAME: &str = "baton";
/// Longest single `wait`. Claude Code's MCP client gives up on a tool call
/// after about a minute (a 90 s wait still timed out), so return well before
/// that and let the lead call again.
const MAX_WAIT: Duration = Duration::from_secs(40);
/// Results handed back to the lead are clipped to keep its context small.
const MAX_RESULT_CHARS: usize = 8000;
/// Most files a lead can hand a member in one delegate or follow-up.
const MAX_TASK_ATTACHMENTS: usize = 10;
/// How long a member stays out after a limit error whose reset time is unknown.
const LIMIT_BACKOFF: Duration = Duration::from_secs(30 * 60);
/// Most times one task moves to another member after hitting a limit.
const MAX_REASSIGN: usize = 2;
/// A running task with no session update for this long is flagged as stalled.
const STALL_AFTER: Duration = Duration::from_secs(4 * 60);
/// How often running tasks are checked for stalling.
const STALL_CHECK_EVERY: Duration = Duration::from_secs(15);

const INSTRUCTIONS: &str = "\
You are the lead agent in Baton, a desktop workspace where several coding agents work together.
You can hand work to team members with the baton tools:
- Call list_agents first: it shows the team, what each member is good at, and how much of its usage limit is left.
- Split the request into self-contained tasks. Members cannot see this conversation, so each task message must carry
  everything needed: goal, relevant files, constraints, and what to report back.
- When delegating, name the relevant files, functions, and exact checks to run so members don't have to explore.
- Choose the member whose role fits. Prefer members with more usage left, and give simple work to cheaper members.
- Members with \"available\": false hit their usage limit until limited_until; delegate to someone else meanwhile.
- Set writes_files=false for read-only tasks (research, review, analysis); they run in parallel in the workspace.
  File-writing tasks depend on the team's isolation (see list_agents):
  - \"worktree\": each runs in parallel in its own copy of the workspace. Its changes reach the workspace only when you
    call merge_task, so review them first (the report lists changed files and the copy's path), merge accepted tasks
    one at a time, fix any conflicts merge_task reports, and discard_task the rest. To keep only some of a task's
    files, pass them in merge_task's files; the rest stay in the worktree for a later merge_task or discard_task.
  - \"shared\": they run one at a time directly in the workspace.
- When a task adds, removes or moves files or changes commands or conventions, tell that member to update AGENTS.md (if the repo has one) in the same task.
- Use wait to collect results, then check and integrate them before answering.
- Files the user attached are listed after their message; pass the ones a member needs in delegate's attachments.
- Delegating is the default: the user turned on agent mode to have the team do the work. Do a task yourself only
  when the whole request is a quick question or a one-line change.
- The user can message a member directly; those messages come back to you as user_notes.
- Tool results may carry user_messages the user typed meanwhile; follow them.
- If a task report says it is stalled, cancel it and delegate it to another member (or use the same brief).
- Answer the user in the language they used.";

/// Sent ahead of each user message to a lead (not shown in the UI). Server
/// instructions alone don't reliably make the lead use its tools.
const LEAD_PREAMBLE: &str = "\
[Baton agent mode — note from the app, not from the user]
The user turned on agent mode: split the work across your team instead of doing it all yourself.
1. Call the baton list_agents tool (if the baton tools are not loaded yet, search for them first).
2. Hand out the implementation work with baton delegate, choosing members by role and remaining usage. Read-only
   tasks run in parallel; file-writing tasks run one at a time.
3. Use baton wait to collect results, review them (read the changed files), follow up or fix, then report back.
When delegating, name the relevant files, functions, and exact checks to run so members don't have to explore.
Tool results may carry user_messages the user typed meanwhile; follow them.
Work alone only if the whole request is a quick question or a one-line change.
If a task report says it is stalled, cancel it and delegate it to another member (or use the same brief).
When a task adds, removes or moves files or changes commands or conventions, tell that member to update AGENTS.md (if the repo has one) in the same task.
";

const USER_MESSAGES_NOTE: &str = "The user sent these messages while you were working. Read them now and adjust your plan; they will not be sent again.";

/// Heads the list of a lead message's attachments. The UI strips it from
/// replayed messages, so keep the two in sync (`cleanReplay` in store.ts).
const ATTACHMENTS_NOTE: &str = "[Attached files — note from the app]";

const SUBTASK_PREAMBLE: &str = "\
[Baton] A lead agent assigned you the task below; work in the current workspace. \
Start from the files and symbols the task names and read only what you need. \
Use targeted search (rg / grep) instead of listing or reading whole directories. \
If the repo has AGENTS.md or CLAUDE.md, rely on it for the project layout instead of re-exploring. \
If your change adds, removes or moves files or changes commands, update AGENTS.md accordingly when it exists. \
Finish with a short report: what you did, files you changed, and anything left undone or uncertain.";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone)]
struct Lead {
    agent_id: String,
    session_id: Option<String>,
    cwd: String,
    team_id: String,
    slots: Arc<Semaphore>,
    /// The project guide was checked (and the lead told) already.
    guide_checked: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    /// Input not served from the prompt cache (ACP `inputTokens`).
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    pub cached_write_tokens: u64,
}

impl TaskUsage {
    /// Everything the model read: fresh input plus cache reads and writes.
    fn read_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.cached_read_tokens).saturating_add(self.cached_write_tokens)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub lead_agent_id: String,
    pub lead_session_id: String,
    pub title: String,
    pub member_id: String,
    pub member_name: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    /// queued | starting | waiting_lock | running | done | failed | cancelled
    pub status: String,
    pub writes: bool,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub error: Option<String>,
    /// Runs in its own git worktree and is merged back on request.
    pub isolated: bool,
    /// Files the task changed ("M src/a.rs"); isolated tasks only.
    pub changes: Vec<String>,
    /// none | pending | merged | conflict | discarded; isolated tasks only.
    pub merge_state: Option<String>,
    pub conflicts: Vec<String>,
    /// Files already brought into the workspace by partial merges (conflicted
    /// ones included); `changes` then lists only what is left.
    pub merged: Vec<String>,
    /// Member switches after a limit error, e.g. "a → b (usage limit)".
    pub reassigned: Vec<String>,
    /// True when the task ended or was moved because of a usage limit.
    pub limit_hit: bool,
    /// Cumulative token usage across every turn this task has run.
    pub usage: Option<TaskUsage>,
    /// Since when (ms) a running task has had no activity; set once it has been
    /// silent for `STALL_AFTER`, cleared when it speaks again or moves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalled_since: Option<u64>,
}

struct Task {
    info: TaskInfo,
    member: Member,
    cwd: String,
    /// Final message of the latest turn.
    result: String,
    /// Text of the current turn since its last tool call.
    answer: String,
    after_tool: bool,
    notes: Vec<String>,
    cancel_requested: bool,
    sandbox: Option<Sandbox>,
    /// Files sent with the next turn: the brief's, then each follow-up's own.
    attachments: Vec<String>,
    /// Last moment (ms) the task showed life: turn start or any session update.
    last_activity_ms: u64,
    /// The running turn is the task's first, so it may still move to another member.
    movable: bool,
    /// Member the user asked to move the task to; picked up by `run_turn`.
    reassign_to: Option<Member>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub text: String,
    pub attachments: Vec<String>,
}

/// Per-session queue of user messages typed while an agent is busy.
#[derive(Default)]
struct Inbox {
    items: Mutex<HashMap<(String, String), Vec<InboxItem>>>,
}

impl Inbox {
    fn push(&self, agent_id: &str, session_id: &str, item: InboxItem) {
        self.items
            .lock()
            .unwrap()
            .entry((agent_id.into(), session_id.into()))
            .or_default()
            .push(item);
    }

    fn remove(&self, agent_id: &str, session_id: &str, id: &str) -> bool {
        let mut map = self.items.lock().unwrap();
        let key = (agent_id.to_string(), session_id.to_string());
        let Some(list) = map.get_mut(&key) else { return false };
        let Some(pos) = list.iter().position(|it| it.id == id) else { return false };
        list.remove(pos);
        if list.is_empty() {
            map.remove(&key);
        }
        true
    }

    fn take(&self, agent_id: &str, session_id: &str) -> Vec<InboxItem> {
        self.items
            .lock()
            .unwrap()
            .remove(&(agent_id.to_string(), session_id.to_string()))
            .unwrap_or_default()
    }
}

pub struct Orchestra {
    app: AppHandle,
    port: u16,
    leads: Mutex<HashMap<String, Lead>>,
    tasks: Mutex<HashMap<String, Task>>,
    by_session: Mutex<HashMap<(String, String), String>>,
    inbox: Inbox,
    write_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Unix seconds until which an (agent, profile, model) can't run, from
    /// limit errors: plan-limit reports can lag behind.
    limits: Mutex<HashMap<(String, String, String), u64>>,
    next_task: AtomicU64,
    /// Per-run prefix for task ids. Leads keep their task lists across restarts,
    /// so a bare counter would hand out "t1" again and collide with old tasks.
    run_id: String,
    /// This run's worktrees; earlier runs' leftovers are cleaned up at start.
    worktrees_dir: std::path::PathBuf,
    /// Held while the app runs so other instances don't clean up our worktrees.
    _run_lock: Option<std::fs::File>,
}

impl Orchestra {
    /// Bind the MCP endpoint and start serving it.
    pub fn start(app: AppHandle) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let router = Router::new().route("/mcp", post(handle_mcp).get(method_not_allowed)).with_state(app.clone());
        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => {
                    if let Err(e) = axum::serve(listener, router).await {
                        eprintln!("baton MCP server stopped: {e}");
                    }
                }
                Err(e) => eprintln!("baton MCP server failed to start: {e}"),
            }
        });
        let ticker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(STALL_CHECK_EVERY).await;
                ticker_app.state::<Orchestra>().check_stalls();
            }
        });
        let root = app
            .path()
            .app_data_dir()
            .map(|d| d.join("worktrees"))
            .unwrap_or_else(|_| std::env::temp_dir().join("baton-worktrees"));
        let run_id = random_token()[..4].to_string();
        let (worktrees_dir, run_lock) = match worktree::claim_run_dir(&root, &run_id) {
            Ok((dir, lock)) => (dir, Some(lock)),
            Err(e) => {
                eprintln!("worktree folder lock failed: {e}");
                (root.join(&run_id), None)
            }
        };
        let keep = worktrees_dir.clone();
        std::thread::spawn(move || {
            for patch in worktree::cleanup_orphans(&root, &keep) {
                eprintln!("saved unmerged task changes to {}", patch.display());
            }
        });
        Ok(Self {
            app,
            port,
            worktrees_dir,
            _run_lock: run_lock,
            leads: Default::default(),
            tasks: Default::default(),
            by_session: Default::default(),
            inbox: Default::default(),
            write_locks: Default::default(),
            limits: Default::default(),
            next_task: AtomicU64::new(1),
            run_id,
        })
    }

    /// Register a lead before its session exists. Returns the token and the
    /// ACP `mcpServers` entry to create (or resume) the session with.
    pub fn register_lead(&self, agent_id: &str, cwd: &str, team_id: &str, session_id: Option<String>) -> (String, Value) {
        let token = random_token();
        let team = self.app.state::<Teams>().get(team_id);
        self.leads.lock().unwrap().insert(
            token.clone(),
            Lead {
                agent_id: agent_id.into(),
                session_id,
                cwd: cwd.into(),
                team_id: team.id.clone(),
                slots: Arc::new(Semaphore::new(team.max_parallel.max(1))),
                guide_checked: false,
            },
        );
        let server = json!([{
            "type": "http",
            "name": SERVER_NAME,
            "url": format!("http://127.0.0.1:{}/mcp", self.port),
            "headers": [{ "name": "Authorization", "value": format!("Bearer {token}") }],
        }]);
        (token, server)
    }

    pub fn bind_lead(&self, token: &str, session_id: &str) {
        if let Some(lead) = self.leads.lock().unwrap().get_mut(token) {
            lead.session_id = Some(session_id.into());
        }
    }

    pub fn forget_lead(&self, token: &str) {
        self.leads.lock().unwrap().remove(token);
    }

    /// Drop every lead registration of a session (switching back to chat).
    pub fn forget_session(&self, agent_id: &str, session_id: &str) {
        self.leads
            .lock()
            .unwrap()
            .retain(|_, l| !(l.agent_id == agent_id && l.session_id.as_deref() == Some(session_id)));
    }

    /// The text to send for a user message: leads get the agent-mode note in front,
    /// naming the current team so a lead notices when the user switched it.
    /// `attachments` are listed after the text so the lead can pass them on.
    /// For a lead's first real message (not a slash command): marks its guide
    /// as checked and returns the folder to check. None afterwards or for non-leads.
    pub fn take_guide_check(&self, agent_id: &str, session_id: &str, text: &str) -> Option<String> {
        if text.trim_start().starts_with('/') {
            return None;
        }
        let mut leads = self.leads.lock().unwrap();
        let lead = leads
            .values_mut()
            .find(|l| l.agent_id == agent_id && l.session_id.as_deref() == Some(session_id))?;
        if lead.guide_checked {
            return None;
        }
        lead.guide_checked = true;
        Some(lead.cwd.clone())
    }

    /// `guide_note` is an extra paragraph for the preamble (see `guide::guide_note`).
    pub fn lead_prompt(
        &self,
        agent_id: &str,
        session_id: &str,
        text: &str,
        attachments: &[String],
        guide_note: Option<&str>,
    ) -> String {
        let team_id = self
            .leads
            .lock()
            .unwrap()
            .values()
            .find(|l| l.agent_id == agent_id && l.session_id.as_deref() == Some(session_id))
            .map(|l| l.team_id.clone());
        let team = team_id.map(|id| self.app.state::<Teams>().get(&id).name);
        let wrapped = wrap_lead_text(text, team.as_deref(), attachments);
        match (guide_note, wrapped.strip_prefix(LEAD_PREAMBLE)) {
            (Some(note), Some(rest)) => format!("{LEAD_PREAMBLE}{note}\n{rest}"),
            _ => wrapped,
        }
    }

    /// Switch a lead's team; applies to its next delegations.
    pub fn set_team(&self, agent_id: &str, session_id: &str, team_id: &str) -> bool {
        let team = self.app.state::<Teams>().get(team_id);
        let mut found = false;
        for lead in self.leads.lock().unwrap().values_mut() {
            if lead.agent_id == agent_id && lead.session_id.as_deref() == Some(session_id) {
                lead.team_id = team.id.clone();
                // Running tasks keep their permits from the old limit.
                lead.slots = Arc::new(Semaphore::new(team.max_parallel.max(1)));
                found = true;
            }
        }
        found
    }

    /// Whether this session is a lead (agent mode).
    pub fn is_lead(&self, agent_id: &str, session_id: &str) -> bool {
        self.leads.lock().unwrap().values().any(|l| l.agent_id == agent_id && l.session_id.as_deref() == Some(session_id))
    }

    /// Lead-only ACP `_meta`: let the lead call baton tools without prompting.
    /// Only Claude takes this; other agents ask, and `baton_tool_approval`
    /// answers for them.
    pub fn lead_meta(agent_id: &str) -> Value {
        if agent_id == "claude" {
            json!({ "claudeCode": { "options": { "allowedTools": [format!("mcp__{SERVER_NAME}")] } } })
        } else {
            Value::Null
        }
    }

    /// Feed every session update through here to capture task answers.
    pub fn observe(&self, agent_id: &str, session_id: &str, update: &Value) {
        let Some(task_id) = self.by_session.lock().unwrap().get(&(agent_id.into(), session_id.into())).cloned() else {
            return;
        };
        let mut tasks = self.tasks.lock().unwrap();
        let Some(task) = tasks.get_mut(&task_id) else { return };
        task.last_activity_ms = now_ms();
        let resumed = task.info.stalled_since.take().is_some().then(|| task.info.clone());
        if let Some(info) = resumed {
            let _ = self.app.emit("task-update", info);
        }
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    // Keep only the text after the last tool call: the final report.
                    if task.after_tool {
                        task.answer.clear();
                        task.after_tool = false;
                    }
                    task.answer.push_str(text);
                }
            }
            Some("tool_call") => task.after_tool = true,
            _ => {}
        }
    }

    /// Flag running tasks that went silent. A task waiting on a permission prompt
    /// the user hasn't answered isn't stalled: its idle clock restarts instead.
    fn check_stalls(&self) {
        let hub = self.app.state::<Hub>();
        let now = now_ms();
        let mut flagged = Vec::new();
        {
            let mut tasks = self.tasks.lock().unwrap();
            for task in tasks.values_mut() {
                if task.info.status != "running" || task.info.stalled_since.is_some() {
                    continue;
                }
                if !is_stalled(task.last_activity_ms, now) {
                    continue;
                }
                let waiting = task.info.session_id.as_deref().is_some_and(|s| hub.has_pending_permission(&task.info.agent_id, s));
                if waiting {
                    task.last_activity_ms = now;
                    continue;
                }
                task.info.stalled_since = Some(task.last_activity_ms);
                flagged.push(task.info.clone());
            }
        }
        for info in flagged {
            let _ = self.app.emit("task-update", info);
        }
    }

    /// Move a running task (first turn only) to another member: `member_id` from
    /// its lead's team, else the usual fallback pick. The running prompt is
    /// cancelled and `run_turn` restarts the task on the new member.
    pub async fn reassign_task(&self, task_id: &str, member_id: Option<String>) -> Result<(), String> {
        let hub = self.app.state::<Hub>();
        let (current, lead_agent, lead_session, target) = {
            let tasks = self.tasks.lock().unwrap();
            let task = tasks.get(task_id).ok_or("작업을 찾을 수 없어요.")?;
            if task.info.status != "running" || !task.movable || task.cancel_requested {
                return Err("실행 중인 작업만 다른 팀원에게 넘길 수 있어요.".into());
            }
            let session = task.info.session_id.clone().ok_or("작업이 아직 시작되지 않았어요.")?;
            (task.member.clone(), task.info.lead_agent_id.clone(), task.info.lead_session_id.clone(), (task.info.agent_id.clone(), session))
        };
        let team_id = self
            .leads
            .lock()
            .unwrap()
            .values()
            .find(|l| l.agent_id == lead_agent && l.session_id.as_deref() == Some(lead_session.as_str()))
            .map(|l| l.team_id.clone())
            .ok_or("이 작업을 맡긴 리드를 찾을 수 없어요.")?;
        let team = self.app.state::<Teams>().get(&team_id);
        let next = pick_reassign_target(&team, &current, member_id.as_deref(), |m| self.limited_until(&hub, m).is_some(), |a| installed(&hub, a))
            .ok_or("넘길 수 있는 다른 팀원이 없어요.")?;
        {
            let mut tasks = self.tasks.lock().unwrap();
            let task = tasks.get_mut(task_id).ok_or("작업을 찾을 수 없어요.")?;
            if task.info.status != "running" {
                return Err("실행 중인 작업만 다른 팀원에게 넘길 수 있어요.".into());
            }
            task.reassign_to = Some(next);
        }
        let _ = hub.cancel(&target.0, &target.1).await;
        Ok(())
    }

    /// A user message typed into a task's own chat; reported back to the lead.
    pub fn add_note(&self, task_id: &str, text: &str) {
        if let Some(task) = self.tasks.lock().unwrap().get_mut(task_id) {
            task.notes.push(text.to_string());
        }
    }

    pub fn inbox_push(&self, agent_id: &str, session_id: &str, item: InboxItem) {
        self.inbox.push(agent_id, session_id, item);
    }

    pub fn inbox_remove(&self, agent_id: &str, session_id: &str, id: &str) -> bool {
        self.inbox.remove(agent_id, session_id, id)
    }

    pub fn inbox_take(&self, agent_id: &str, session_id: &str) -> Vec<InboxItem> {
        self.inbox.take(agent_id, session_id)
    }

    /// Stop everything a lead started (when the user stops the lead).
    pub async fn cancel_lead_tasks(&self, lead_agent_id: &str, lead_session_id: &str) {
        let ids: Vec<String> = self
            .tasks
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.info.lead_agent_id == lead_agent_id && t.info.lead_session_id == lead_session_id)
            .map(|t| t.info.id.clone())
            .collect();
        for id in ids {
            self.cancel(&id).await;
        }
    }

    /// Reassign every task owned by one lead session to a replacement lead,
    /// emitting `task-update` for each moved task.
    pub fn handoff_lead(
        &self,
        from_agent_id: &str,
        from_session_id: &str,
        to_agent_id: &str,
        to_session_id: &str,
    ) -> usize {
        let moved = {
            let mut tasks = self.tasks.lock().unwrap();
            Self::reassign_tasks(&mut tasks, from_agent_id, from_session_id, to_agent_id, to_session_id)
        };
        for info in &moved {
            let _ = self.app.emit("task-update", info);
        }
        moved.len()
    }

    fn reassign_tasks(
        tasks: &mut HashMap<String, Task>,
        from_agent_id: &str,
        from_session_id: &str,
        to_agent_id: &str,
        to_session_id: &str,
    ) -> Vec<TaskInfo> {
        let mut moved = Vec::new();
        for task in tasks.values_mut() {
            if task.info.lead_agent_id == from_agent_id && task.info.lead_session_id == from_session_id {
                task.info.lead_agent_id = to_agent_id.into();
                task.info.lead_session_id = to_session_id.into();
                moved.push(task.info.clone());
            }
        }
        moved
    }

    fn lead(&self, token: &str) -> Option<Lead> {
        self.leads.lock().unwrap().get(token).cloned()
    }

    fn emit_task(&self, task_id: &str) {
        if let Some(task) = self.tasks.lock().unwrap().get(task_id) {
            let _ = self.app.emit("task-update", &task.info);
        }
    }

    fn set_status(&self, task_id: &str, status: &str) {
        if let Some(task) = self.tasks.lock().unwrap().get_mut(task_id) {
            task.info.status = status.into();
            task.info.stalled_since = None;
            task.last_activity_ms = now_ms();
            if status == "running" && task.info.started_at.is_none() {
                task.info.started_at = Some(now_ms());
            }
            if matches!(status, "done" | "failed" | "cancelled") {
                task.info.ended_at = Some(now_ms());
            }
        }
        self.emit_task(task_id);
    }

    fn is_terminal(status: &str) -> bool {
        matches!(status, "done" | "failed" | "cancelled")
    }

    fn write_lock(&self, cwd: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.write_locks.lock().unwrap().entry(cwd.into()).or_default().clone()
    }

    /// Until when `m` can't run (Unix seconds, 0 if unknown), from its plan
    /// limits or a limit error seen earlier; None if it can run now.
    fn limited_until(&self, hub: &Hub, m: &Member) -> Option<u64> {
        let now = now_secs();
        let seen = {
            let mut limits = self.limits.lock().unwrap();
            limits.retain(|_, until| *until > now);
            limits.get(&limit_key(m)).copied()
        };
        let reported = hub.quota(&m.agent_id, &m.profile_id).and_then(|q| limit_state(&q, member_model(m), now));
        seen.max(reported)
    }

    /// Keep `m` out after a limit error: until its reported reset, or for
    /// LIMIT_BACKOFF when none is known. Returns the time recorded.
    fn record_limit(&self, hub: &Hub, m: &Member) -> u64 {
        let now = now_secs();
        let until = hub
            .quota(&m.agent_id, &m.profile_id)
            .and_then(|q| limit_state(&q, member_model(m), now))
            .filter(|&u| u > now)
            .unwrap_or(now + LIMIT_BACKOFF.as_secs());
        self.limits.lock().unwrap().insert(limit_key(m), until);
        until
    }

    /// Who could take `member`'s work now (see `pick_fallback`).
    fn fallback_for(&self, hub: &Hub, team: &Team, member: &Member) -> Option<Member> {
        pick_fallback(team, member, |m| self.limited_until(hub, m).is_some(), |agent| installed(hub, agent))
    }

    // ---------- tools ----------

    fn list_agents(&self, lead: &Lead) -> Value {
        let team = self.app.state::<Teams>().get(&lead.team_id);
        let hub = self.app.state::<Hub>();
        let profiles = self.app.state::<Arc<Profiles>>();
        let tasks = self.tasks.lock().unwrap();
        let now = now_secs();
        let members: Vec<Value> = team
            .members
            .iter()
            .filter(|m| installed(&hub, &m.agent_id))
            .map(|m| {
                let account = if m.profile_id == DEFAULT_PROFILE {
                    "default".to_string()
                } else {
                    profiles.list().into_iter().find(|p| p.id == m.profile_id).map(|p| p.name).unwrap_or(m.profile_id.clone())
                };
                let active = tasks.values().filter(|t| t.member.id == m.id && !Self::is_terminal(&t.info.status)).count();
                let mut entry = json!({
                    "id": m.id,
                    "name": m.name,
                    "role": m.role,
                    "agent": m.agent_id,
                    "account": account,
                    "settings": { "launch": m.launch, "config": m.config },
                    "usage": usage_summary(hub.quota(&m.agent_id, &m.profile_id)),
                    "active_tasks": active,
                });
                if let Some(until) = self.limited_until(&hub, m) {
                    entry["available"] = json!(false);
                    entry["limited_until"] = json!(limit_text(now, until));
                }
                entry
            })
            .collect();
        let git = worktree::repo_root(std::path::Path::new(&lead.cwd)).is_some();
        let isolation = if team.isolation == "worktree" && git { "worktree" } else { "shared" };
        json!({ "team": team.name, "max_parallel_tasks": team.max_parallel, "isolation": isolation, "members": members })
    }

    fn delegate(&self, token: &str, lead: &Lead, args: &Value) -> Result<Value, String> {
        let team: Team = self.app.state::<Teams>().get(&lead.team_id);
        let member_id = args.get("member").and_then(Value::as_str).ok_or("member is required")?;
        let member = team
            .members
            .iter()
            .find(|m| m.id == member_id)
            .cloned()
            .ok_or_else(|| format!("unknown member '{member_id}'; call list_agents for valid ids"))?;
        let hub = self.app.state::<Hub>();
        if !installed(&hub, &member.agent_id) {
            return Err(format!("member '{member_id}' is not available: its agent is not installed on this computer"));
        }
        if let Some(until) = self.limited_until(&hub, &member) {
            let hint = match self.fallback_for(&hub, &team, &member) {
                Some(m) => format!("Delegate to '{}' instead; it can run now.", m.id),
                None => "No other member of the team can run right now: wait for the reset or tell the user.".into(),
            };
            return Err(format!(
                "member '{member_id}' is not available: it hit its usage limit (resets {}). {hint}",
                limit_text(now_secs(), until)
            ));
        }
        let task_text = args.get("task").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).ok_or("task is required")?;
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| task_text.chars().take(40).collect());
        let writes = args.get("writes_files").and_then(Value::as_bool).unwrap_or(true);
        let attachments = task_attachments(args)?;
        let lead_session_id = lead.session_id.clone().ok_or("lead session is not ready yet")?;
        let isolated =
            writes && team.isolation == "worktree" && worktree::repo_root(std::path::Path::new(&lead.cwd)).is_some();

        let id = format!("{}-{}", self.run_id, self.next_task.fetch_add(1, Ordering::Relaxed));
        let info = TaskInfo {
            id: id.clone(),
            lead_agent_id: lead.agent_id.clone(),
            lead_session_id,
            title,
            member_id: member.id.clone(),
            member_name: member.name.clone(),
            agent_id: member.agent_id.clone(),
            session_id: None,
            status: "queued".into(),
            writes,
            started_at: None,
            ended_at: None,
            error: None,
            isolated,
            changes: Vec::new(),
            merge_state: None,
            conflicts: Vec::new(),
            merged: Vec::new(),
            reassigned: Vec::new(),
            limit_hit: false,
            usage: None,
            stalled_since: None,
        };
        self.tasks.lock().unwrap().insert(
            id.clone(),
            Task {
                info,
                member,
                cwd: lead.cwd.clone(),
                result: String::new(),
                answer: String::new(),
                after_tool: false,
                notes: Vec::new(),
                cancel_requested: false,
                sandbox: None,
                attachments,
                last_activity_ms: now_ms(),
                movable: false,
                reassign_to: None,
            },
        );
        self.emit_task(&id);
        tauri::async_runtime::spawn(run_turn(self.app.clone(), token.to_string(), id.clone(), task_text.to_string(), writes, true));
        Ok(json!({ "task_id": id, "status": "queued" }))
    }

    fn followup(&self, token: &str, args: &Value) -> Result<Value, String> {
        let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
        let message = args.get("message").and_then(Value::as_str).ok_or("message is required")?;
        let writes = args.get("writes_files").and_then(Value::as_bool);
        let attachments = task_attachments(args)?;
        let writes = {
            let tasks = self.tasks.lock().unwrap();
            let task = tasks.get(id).ok_or("unknown task")?;
            if task.info.session_id.is_none() || !Self::is_terminal(&task.info.status) {
                return Err("task is still running; wait for it before sending a follow-up".into());
            }
            if task.info.isolated && task.sandbox.is_none() {
                return Err("this task was already merged or discarded; delegate a new task instead".into());
            }
            writes.unwrap_or(task.info.writes)
        };
        if let Some(task) = self.tasks.lock().unwrap().get_mut(id) {
            task.cancel_requested = false;
            task.info.error = None;
            task.attachments = attachments;
        }
        self.set_status(id, "queued");
        tauri::async_runtime::spawn(run_turn(self.app.clone(), token.to_string(), id.to_string(), message.to_string(), writes, false));
        Ok(json!({ "task_id": id, "status": "queued" }))
    }

    async fn cancel(&self, id: &str) -> Value {
        let target = {
            let mut tasks = self.tasks.lock().unwrap();
            let Some(task) = tasks.get_mut(id) else { return json!({ "error": "unknown task" }) };
            task.cancel_requested = true;
            (task.info.status == "running").then(|| (task.info.agent_id.clone(), task.info.session_id.clone()))
        };
        match target {
            Some((agent, Some(session))) => {
                let _ = self.app.state::<Hub>().cancel(&agent, &session).await;
            }
            // Not started yet: run_turn sees the flag and stops.
            _ => {}
        }
        json!({ "task_id": id, "status": "cancelling" })
    }

    fn report(&self, id: &str) -> Value {
        let tasks = self.tasks.lock().unwrap();
        let Some(task) = tasks.get(id) else { return json!({ "task_id": id, "error": "unknown task" }) };
        task_report(task, now_ms())
    }

    async fn wait(&self, args: &Value) -> Value {
        let ids: Vec<String> = args
            .get("task_ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let timeout = args
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .map(Duration::from_secs)
            .unwrap_or(MAX_WAIT)
            .min(MAX_WAIT);
        let deadline = Instant::now() + timeout;
        loop {
            let pending = {
                let tasks = self.tasks.lock().unwrap();
                ids.iter().any(|id| tasks.get(id).is_some_and(|t| !Self::is_terminal(&t.info.status)))
            };
            if !pending || Instant::now() >= deadline {
                let reports: Vec<Value> = ids.iter().map(|id| self.report(id)).collect();
                return json!({ "all_done": !pending, "tasks": reports });
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Bring an isolated task's changes into the workspace: all of them, or
    /// only `files`. The worktree is removed once nothing is left to merge.
    pub async fn merge(&self, id: &str, files: Option<Vec<String>>) -> Result<Value, String> {
        let sandbox = self.sandbox_of(id, true)?;
        let label = format!("{id}-merge");
        let (sb, l) = (sandbox.clone(), label.clone());
        let plan = tokio::task::spawn_blocking(move || plan_merge(&sb, &l, files.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
        if plan.remaining.is_empty() {
            // Shells first: on Windows a shell inside the worktree keeps it from being deleted.
            self.close_terminals_under(sandbox.path.clone()).await;
        }
        let task_id = id.to_string();
        let step = tokio::task::spawn_blocking(move || apply_merge(&sandbox, &task_id, &label, plan))
            .await
            .map_err(|e| e.to_string())??;
        if let Some(task) = self.tasks.lock().unwrap().get_mut(id) {
            record_merge(task, &step);
        }
        self.emit_task(id);
        let kept = step.sandbox.is_some();
        let mut note = match (kept, step.outcome.conflicts.is_empty()) {
            (false, true) => "All changes are in the workspace.".to_string(),
            (true, true) => "The chosen files are in the workspace.".to_string(),
            (_, false) => "Conflicting text files now contain <<<<<<< markers (binary files kept the workspace version); resolve them in the workspace.".to_string(),
        };
        if kept {
            note.push_str(&format!(
                " {} changed file(s) are still only in the worktree: merge_task again (all, or with files) or discard_task the rest.",
                step.remaining.len()
            ));
        }
        Ok(json!({
            "task_id": id,
            "merged_files": step.outcome.merged,
            "conflicts": step.outcome.conflicts,
            "remaining_files": step.remaining.iter().map(change_line).collect::<Vec<_>>(),
            "worktree_kept": kept,
            "note": note,
        }))
    }

    /// The task's unmerged changes, snapshotted into a result commit whose
    /// parent is the worktree's base (so a commit diff shows base → task).
    pub async fn task_changes(&self, id: &str) -> Result<Value, String> {
        let sb = self.sandbox_of(id, false)?;
        let label = format!("{id}-view{}", now_ms());
        tokio::task::spawn_blocking(move || changes_report(&sb, &label)).await.map_err(|e| e.to_string())?
    }

    /// The task's worktree; with `finished`, only once the task stopped running.
    fn sandbox_of(&self, id: &str, finished: bool) -> Result<Sandbox, String> {
        let tasks = self.tasks.lock().unwrap();
        let task = tasks.get(id).ok_or("unknown task")?;
        if finished && !Self::is_terminal(&task.info.status) {
            return Err("task is still running".into());
        }
        task.sandbox.clone().ok_or_else(|| "the task has no worktree (shared, already merged or discarded)".into())
    }

    /// Drop an isolated task's worktree without merging.
    pub async fn discard(&self, id: &str) -> Result<Value, String> {
        let sandbox = {
            let tasks = self.tasks.lock().unwrap();
            let task = tasks.get(id).ok_or("unknown task")?;
            task.sandbox.clone()
        };
        if let Some(sb) = sandbox {
            self.close_terminals_under(sb.path.clone()).await;
            let _ = tokio::task::spawn_blocking(move || worktree::remove(&sb)).await;
        }
        if let Some(task) = self.tasks.lock().unwrap().get_mut(id) {
            record_discard(task);
        }
        self.emit_task(id);
        Ok(json!({ "task_id": id, "merge_state": "discarded" }))
    }

    /// End the 터미널 tab's shells left in a removed worktree. Off the async
    /// runtime: closing a Windows pseudoconsole can wait on its output.
    async fn close_terminals_under(&self, path: std::path::PathBuf) {
        let app = self.app.clone();
        let _ = tokio::task::spawn_blocking(move || app.state::<crate::terminal::Terminals>().close_under(&path)).await;
    }

    async fn call_tool(&self, token: &str, lead: &Lead, name: &str, args: &Value) -> Result<Value, String> {
        let mut res = match name {
            "list_agents" => Ok(self.list_agents(lead)),
            "delegate" => self.delegate(token, lead, args),
            "wait" => Ok(self.wait(args).await),
            "get_result" => {
                let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
                Ok(self.report(id))
            }
            "send_followup" => self.followup(token, args),
            "cancel" => {
                let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
                Ok(self.cancel(id).await)
            }
            "merge_task" => {
                let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
                self.merge(id, merge_files_arg(args)?).await
            }
            "discard_task" => {
                let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
                self.discard(id).await
            }
            other => Err(format!("unknown tool '{other}'")),
        }?;
        let session_id = lead.session_id.clone().or_else(|| self.lead(token).and_then(|l| l.session_id));
        if let Some(session_id) = session_id {
            let items = self.inbox_take(&lead.agent_id, &session_id);
            if !items.is_empty() {
                res = inject_user_messages(res, &items);
                let _ = self.app.emit(
                    "inbox-delivered",
                    json!({
                        "agentId": lead.agent_id,
                        "sessionId": session_id,
                        "items": items,
                    }),
                );
            }
        }
        Ok(res)
    }
}

/// Sum token usage from one ACP `session/prompt` response into the task total.
/// Leaves `acc` unchanged when the response carries no `usage` numbers.
fn add_usage(acc: Option<TaskUsage>, response: &Value) -> Option<TaskUsage> {
    let Some(usage) = response.get("usage").and_then(Value::as_object) else {
        return acc;
    };
    let input = usage.get("inputTokens").and_then(Value::as_u64);
    let output = usage.get("outputTokens").and_then(Value::as_u64);
    let cached = usage.get("cachedReadTokens").and_then(Value::as_u64);
    let written = usage.get("cachedWriteTokens").and_then(Value::as_u64);
    if input.is_none() && output.is_none() && cached.is_none() && written.is_none() {
        return acc;
    }
    let mut total = acc.unwrap_or_default();
    total.input_tokens = total.input_tokens.saturating_add(input.unwrap_or(0));
    total.output_tokens = total.output_tokens.saturating_add(output.unwrap_or(0));
    total.cached_read_tokens = total.cached_read_tokens.saturating_add(cached.unwrap_or(0));
    total.cached_write_tokens = total.cached_write_tokens.saturating_add(written.unwrap_or(0));
    Some(total)
}

/// Compact token count: `<1000` as is, then `"1.2k"`, `"120k"`, `"1.3M"`.
fn format_tokens(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    if n < 999_500 {
        if n < 9_950 {
            let tenths = (n + 50) / 100;
            if tenths.is_multiple_of(10) {
                return format!("{}k", tenths / 10);
            }
            return format!("{}.{}k", tenths / 10, tenths % 10);
        }
        return format!("{}k", (n + 500) / 1_000);
    }
    if n < 9_950_000 {
        let tenths = (n + 50_000) / 100_000;
        if tenths.is_multiple_of(10) {
            return format!("{}M", tenths / 10);
        }
        return format!("{}.{}M", tenths / 10, tenths % 10);
    }
    format!("{}M", n.saturating_add(500_000) / 1_000_000)
}

/// Compact one-line token summary for the lead's MCP task report.
/// `read` counts cache hits too: Claude reports most of a turn's input as cache reads.
fn format_tokens_report(u: TaskUsage) -> String {
    let mut out = format!("read {}", format_tokens(u.read_tokens()));
    if u.cached_read_tokens > 0 {
        out.push_str(&format!(" (cached {})", format_tokens(u.cached_read_tokens)));
    }
    out.push_str(&format!(" · out {}", format_tokens(u.output_tokens)));
    out
}

/// True when a running task's last activity (ms) is at least `STALL_AFTER` ago.
fn is_stalled(last_activity_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) >= STALL_AFTER.as_millis() as u64
}

/// Who a stalled `current` member's task moves to: the requested member of the
/// team if it can take it, else the usual fallback pick.
fn pick_reassign_target(
    team: &Team,
    current: &Member,
    requested: Option<&str>,
    is_limited: impl Fn(&Member) -> bool,
    installed: impl Fn(&str) -> bool,
) -> Option<Member> {
    if let Some(id) = requested {
        return team.members.iter().find(|m| m.id == id && m.id != current.id && installed(&m.agent_id)).cloned();
    }
    pick_fallback(team, current, is_limited, installed)
}

fn task_report(task: &Task, now: u64) -> Value {
    let elapsed = task.info.started_at.map(|s| task.info.ended_at.unwrap_or(now).saturating_sub(s) / 1000);
    let mut result: String = task.result.chars().take(MAX_RESULT_CHARS).collect();
    if task.result.chars().count() > MAX_RESULT_CHARS {
        result.push_str("\n[…truncated]");
    }
    let mut out = json!({
        "task_id": task.info.id,
        "title": task.info.title,
        "member": task.info.member_id,
        "status": task.info.status,
        "elapsed_seconds": elapsed,
        "result": if Orchestra::is_terminal(&task.info.status) { Value::String(result) } else { Value::Null },
        "error": task.info.error,
        "user_notes": task.notes,
        "isolated": task.info.isolated,
        "worktree_path": task.sandbox.as_ref().map(|s| s.path.display().to_string()),
        "changed_files": task.info.changes,
        "merged_files": task.info.merged,
        "merge_state": task.info.merge_state,
        "conflicts": task.info.conflicts,
    });
    if !task.info.reassigned.is_empty() {
        out["reassigned"] = json!(task.info.reassigned.join("; "));
    }
    if let Some(since) = task.info.stalled_since.filter(|_| task.info.status == "running") {
        out["stalled"] = json!(format!(
            "no activity for {}m — consider cancel + delegate to another member",
            now.saturating_sub(since) / 60_000
        ));
    }
    if let Some(usage) = task.info.usage {
        out["tokens"] = json!(format_tokens_report(usage));
    }
    out
}

/// Attach mid-turn queued user messages to a Baton MCP tool result.
/// Non-object results are wrapped in `{ "result": ... }` so the fields fit.
fn inject_user_messages(result: Value, items: &[InboxItem]) -> Value {
    if items.is_empty() {
        return result;
    }
    let messages: Vec<Value> = items
        .iter()
        .map(|it| json!({ "text": it.text, "attachments": it.attachments }))
        .collect();
    match result {
        Value::Object(mut map) => {
            map.insert("user_messages".into(), Value::Array(messages));
            map.insert("user_messages_note".into(), Value::String(USER_MESSAGES_NOTE.into()));
            Value::Object(map)
        }
        other => json!({
            "result": other,
            "user_messages": messages,
            "user_messages_note": USER_MESSAGES_NOTE,
        }),
    }
}

/// "M src/a.rs", as listed in `TaskInfo::changes`.
fn change_line(c: &worktree::Change) -> String {
    format!("{} {}", c.status, c.path)
}

/// merge_task's optional `files`: absent or null merges everything.
fn merge_files_arg(args: &Value) -> Result<Option<Vec<String>>, String> {
    match args.get("files") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| "files must be an array of paths".to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err("files must be an array of paths".into()),
    }
}

/// `{ result, files: [{ status, path }] }` for the task's worktree now.
fn changes_report(sb: &Sandbox, label: &str) -> Result<Value, String> {
    let (result, files) = worktree::changes(sb, label)?;
    Ok(json!({ "result": result, "files": files }))
}

/// What a merge will take from the worktree, decided before anything is written.
struct MergePlan {
    result: String,
    picked: Vec<worktree::Change>,
    /// Changes that stay in the worktree afterwards.
    remaining: Vec<worktree::Change>,
}

/// What one merge did.
struct MergeStep {
    outcome: worktree::MergeOutcome,
    remaining: Vec<worktree::Change>,
    /// The worktree with its base moved past the merged files; None once removed.
    sandbox: Option<Sandbox>,
}

/// Snapshot the worktree and pick every change, or just `files` (each must be
/// one of the unmerged changes).
fn plan_merge(sb: &Sandbox, label: &str, files: Option<&[String]>) -> Result<MergePlan, String> {
    let (result, list) = worktree::changes(sb, label)?;
    let Some(files) = files else { return Ok(MergePlan { result, picked: list, remaining: Vec::new() }) };
    if files.is_empty() {
        return Err("files is empty: list the paths to merge, or leave files out to merge everything".into());
    }
    let unknown: Vec<&str> =
        files.iter().filter(|f| !list.iter().any(|c| &c.path == *f)).map(String::as_str).collect();
    if !unknown.is_empty() {
        return Err(format!("not among the task's unmerged changes: {}", unknown.join(", ")));
    }
    let (picked, remaining) = list.into_iter().partition(|c| files.contains(&c.path));
    Ok(MergePlan { result, picked, remaining })
}

/// Merge the picked files into the workspace. With nothing left the worktree
/// is removed; otherwise its base moves past the merged files.
fn apply_merge(sb: &Sandbox, task_id: &str, label: &str, plan: MergePlan) -> Result<MergeStep, String> {
    // Built before the workspace is touched, so a failure leaves nothing half done.
    let next_base =
        if plan.remaining.is_empty() { None } else { Some(worktree::advance_base(sb, &plan.result, &plan.picked, label)?) };
    let outcome = worktree::merge(sb, &plan.result, &plan.picked, task_id)?;
    let sandbox = match next_base {
        None => {
            worktree::remove(sb);
            None
        }
        Some(base) => {
            let mut kept = sb.clone();
            worktree::set_base(&mut kept, base);
            Some(kept)
        }
    };
    Ok(MergeStep { outcome, remaining: plan.remaining, sandbox })
}

/// Note a merge on the task. Conflicts add up over partial merges, since the
/// workspace keeps their markers until someone resolves them.
fn record_merge(task: &mut Task, step: &MergeStep) {
    task.sandbox = step.sandbox.clone();
    let info = &mut task.info;
    for path in step.outcome.merged.iter().chain(&step.outcome.conflicts) {
        if !info.merged.contains(path) {
            info.merged.push(path.clone());
        }
    }
    for path in &step.outcome.conflicts {
        if !info.conflicts.contains(path) {
            info.conflicts.push(path.clone());
        }
    }
    info.changes = step.remaining.iter().map(change_line).collect();
    let state = if !info.conflicts.is_empty() {
        "conflict"
    } else if step.sandbox.is_some() {
        "pending"
    } else {
        "merged"
    };
    info.merge_state = Some(state.into());
}

/// Note a discard on the task. `changes` keeps what was thrown away; files
/// merged earlier stay in the workspace.
fn record_discard(task: &mut Task) {
    task.sandbox = None;
    if task.info.isolated {
        task.info.merge_state = Some("discarded".into());
    }
}

/// One turn of a task: start its session if needed, honour the parallel and
/// write limits, prompt, and record the final answer. If the member hits its
/// plan limit on the task's first turn, the task moves to a fallback member.
async fn run_turn(app: AppHandle, token: String, task_id: String, message: String, writes: bool, first: bool) {
    let orch = app.state::<Orchestra>();
    let hub = app.state::<Hub>();
    let Some(lead) = orch.lead(&token) else {
        fail(&orch, &task_id, "lead session is gone");
        return;
    };
    let cancelled = |o: &Orchestra| o.tasks.lock().unwrap().get(&task_id).is_some_and(|t| t.cancel_requested);

    let Ok(_slot) = lead.slots.clone().acquire_owned().await else { return };
    if cancelled(&orch) {
        orch.set_status(&task_id, "cancelled");
        return;
    }

    let (mut member, mut cwd, isolated, attachments) = {
        let tasks = orch.tasks.lock().unwrap();
        let Some(t) = tasks.get(&task_id) else { return };
        (t.member.clone(), t.cwd.clone(), t.info.isolated, t.attachments.clone())
    };

    if first {
        orch.set_status(&task_id, "starting");
        if isolated {
            // Give the task its own copy of the workspace, at the same subfolder.
            let workspace = std::path::PathBuf::from(&cwd);
            let dir = orch.worktrees_dir.clone();
            let id = task_id.clone();
            let created = tokio::task::spawn_blocking(move || worktree::create(&workspace, &dir, &id)).await;
            let sb = match created {
                Ok(Ok(sb)) => sb,
                Ok(Err(e)) => return fail(&orch, &task_id, &format!("작업 폴더(worktree)를 만들지 못했어요: {e}")),
                Err(e) => return fail(&orch, &task_id, &e.to_string()),
            };
            let rel = std::path::Path::new(&cwd).strip_prefix(&sb.repo).map(|p| p.to_path_buf()).unwrap_or_default();
            cwd = sb.path.join(rel).display().to_string();
            if let Some(t) = orch.tasks.lock().unwrap().get_mut(&task_id) {
                t.sandbox = Some(sb);
            }
        }
        if let Err(e) = start_session(&app, &task_id, &member, &cwd, &message, &attachments).await {
            return fail(&orch, &task_id, &e);
        }
    } else if let Some(info) = orch.tasks.lock().unwrap().get(&task_id).map(|t| t.info.clone()) {
        let _ = app.emit("task-brief", json!({ "task": info, "text": message, "attachments": attachments }));
    }

    // Tasks that change the shared workspace take turns; isolated ones have their own copy.
    let lock = orch.write_lock(&cwd);
    let _guard = if writes && !isolated {
        match lock.clone().try_lock_owned() {
            Ok(g) => Some(g),
            Err(_) => {
                orch.set_status(&task_id, "waiting_lock");
                Some(lock.lock_owned().await)
            }
        }
    } else {
        None
    };
    if cancelled(&orch) {
        orch.set_status(&task_id, "cancelled");
        return;
    }

    let prompt = if first { format!("{SUBTASK_PREAMBLE}\n\n{message}") } else { message.clone() };
    let mut switches = 0;
    let outcome = loop {
        let session_id = {
            let mut tasks = orch.tasks.lock().unwrap();
            let Some(t) = tasks.get_mut(&task_id) else { return };
            t.movable = first;
            t.reassign_to = None;
            t.answer.clear();
            t.after_tool = false;
            t.info.session_id.clone()
        };
        let Some(session_id) = session_id else { return fail(&orch, &task_id, "task has no session") };
        orch.set_status(&task_id, "running");

        // Absolute paths, so they still resolve from a worktree task's copy of the workspace.
        let mut outcome = hub.prompt(&member.agent_id, &session_id, &prompt, &attachments).await.map_err(|e| e.message);
        // Some agents (Antigravity) report a used-up quota as an ordinary reply.
        if let Ok(res) = &outcome {
            let answer = {
                let mut tasks = orch.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task_id) {
                    t.info.usage = add_usage(t.info.usage, res);
                    t.answer.clone()
                } else {
                    String::new()
                }
            };
            if is_limit_notice(&answer) {
                outcome = Err(answer.trim().to_string());
            }
        }
        // The user asked to move a stalled task: same restart path as a limit.
        let manual = orch
            .tasks
            .lock()
            .unwrap()
            .get_mut(&task_id)
            .and_then(|t| {
                t.movable = false;
                t.reassign_to.take()
            })
            .filter(|_| first && !cancelled(&orch));
        let (next, why, by_limit) = if let Some(next) = manual {
            (next, "stalled", false)
        } else {
        let error = match &outcome {
            Err(e) if is_limit_error(e) && !cancelled(&orch) => e.clone(),
            _ => break outcome,
        };
        let until = orch.record_limit(&hub, &member);
        let resets = limit_text(now_secs(), until);
        if !first {
            // A new member wouldn't have this task's context.
            break Err(format!(
                "member '{}' hit its usage limit (resets {resets}), so this follow-up didn't run. Delegate a new, \
                 self-contained task to an available member (see list_agents). Agent error: {error}",
                member.id
            ));
        }
        let team = app.state::<Teams>().get(&lead.team_id);
        let next = if switches < MAX_REASSIGN { orch.fallback_for(&hub, &team, &member) } else { None };
        let Some(next) = next else {
            let why = if switches < MAX_REASSIGN { "no other team member can take it now" } else { "it was already reassigned twice" };
            break Err(format!(
                "member '{}' hit its usage limit (resets {resets}) and the task wasn't moved: {why}. \
                 Delegate it again after the reset, or tell the user. Agent error: {error}",
                member.id
            ));
        };
        (next, "usage limit", true)
        };

        // Move the task, then start it afresh on the new member in the same folder.
        let note = format!("{} → {} ({why})", member.id, next.id);
        if let Some(t) = orch.tasks.lock().unwrap().get_mut(&task_id) {
            t.member = next.clone();
            t.info.member_id = next.id.clone();
            t.info.member_name = next.name.clone();
            t.info.agent_id = next.agent_id.clone();
            t.info.session_id = None;
            t.info.reassigned.push(note.clone());
            t.info.stalled_since = None;
            t.last_activity_ms = now_ms();
            if by_limit {
                t.info.limit_hit = true;
            }
        }
        // The old session's late updates must not end up in the new answer.
        orch.by_session.lock().unwrap().remove(&(member.agent_id.clone(), session_id));
        orch.set_status(&task_id, "starting");
        if let Err(e) = start_session(&app, &task_id, &next, &cwd, &message, &attachments).await {
            break Err(format!("reassigned {note}, but the new member failed to start: {e}"));
        }
        member = next;
        if by_limit {
            switches += 1;
        }
        if cancelled(&orch) {
            orch.set_status(&task_id, "cancelled");
            return;
        }
    };

    let status = {
        let mut tasks = orch.tasks.lock().unwrap();
        let Some(t) = tasks.get_mut(&task_id) else { return };
        t.result = std::mem::take(&mut t.answer);
        if !t.info.reassigned.is_empty() {
            t.result = format!(
                "[Baton] Reassigned {}; the report below is from '{}'.\n\n{}",
                t.info.reassigned.join(", then "),
                t.info.member_id,
                t.result
            );
        }
        let outcome_status = match &outcome {
            Ok(res) => match res.get("stopReason").and_then(Value::as_str) {
                Some("cancelled") => "cancelled",
                Some("refusal") => {
                    t.info.error = Some("the agent refused the task".into());
                    "failed"
                }
                _ => "done",
            },
            Err(e) => {
                t.info.error = Some(e.clone());
                if is_limit_error(e) {
                    t.info.limit_hit = true;
                }
                "failed"
            }
        };
        (outcome_status, t.sandbox.clone())
    };
    let (status, sandbox) = status;
    // Record what the task changed in its worktree, for the lead and the UI.
    if let Some(sb) = sandbox {
        let label = format!("{task_id}-r{}", now_ms());
        if let Ok(Ok((_, list))) = tokio::task::spawn_blocking(move || worktree::changes(&sb, &label)).await {
            if let Some(t) = orch.tasks.lock().unwrap().get_mut(&task_id) {
                t.info.changes = list.iter().map(change_line).collect();
                t.info.merge_state = Some(if list.is_empty() { "none" } else { "pending" }.into());
            }
        }
    }
    orch.set_status(&task_id, status);
}

/// Start `member`'s session for a task in `cwd`, link it to the task, and
/// tell the UI (`task-session`) so the task's chat appears with its brief.
async fn start_session(
    app: &AppHandle,
    task_id: &str,
    member: &Member,
    cwd: &str,
    brief: &str,
    attachments: &[String],
) -> Result<(), String> {
    let orch = app.state::<Orchestra>();
    let hub = app.state::<Hub>();
    let mut launch: Launch = member.launch.clone();
    launch.insert(PROFILE_KEY.into(), member.profile_id.clone());
    let session = hub
        .new_session(&member.agent_id, cwd, &launch, json!([]), &member.config, Value::Null)
        .await
        .map_err(|e| e.message)?;
    let session_id =
        session.get("sessionId").and_then(Value::as_str).map(str::to_owned).ok_or("agent returned no session id")?;
    orch.by_session.lock().unwrap().insert((member.agent_id.clone(), session_id.clone()), task_id.to_string());
    let info = {
        let mut tasks = orch.tasks.lock().unwrap();
        let t = tasks.get_mut(task_id).ok_or("task is gone")?;
        t.info.session_id = Some(session_id.clone());
        t.info.clone()
    };
    let _ = app.emit(
        "task-session",
        json!({
            "task": info,
            "session": {
                "agentId": member.agent_id,
                "sessionId": session_id,
                "cwd": cwd,
                "launch": launch,
                "configOptions": session.get("configOptions"),
                "modes": session.get("modes"),
            },
            "brief": brief,
            "attachments": attachments,
        }),
    );
    Ok(())
}

/// A lead's user message with the agent-mode note in front and its
/// attachments' paths after it; `team` is None for a session that isn't a lead.
fn wrap_lead_text(text: &str, team: Option<&str>, attachments: &[String]) -> String {
    // A slash command (/compact, …) only works as the very start of the
    // message; anything in front turns it into plain text.
    match team {
        Some(team) if !text.trim_start().starts_with('/') => {
            let mut out = format!(
                "{LEAD_PREAMBLE}Current team: \"{team}\". If it differs from the team you last listed, call list_agents again.\n[User message]\n{text}"
            );
            if !attachments.is_empty() {
                out.push_str(&format!(
                    "\n\n{ATTACHMENTS_NOTE}\nThe user attached these files. To give them to a member, pass their paths in delegate's attachments.\n"
                ));
                for path in attachments {
                    out.push_str(&format!("- {path}\n"));
                }
                out.pop();
            }
            out
        }
        _ => text.to_string(),
    }
}

/// The `attachments` of a delegate or send_followup call: absolute paths of
/// existing files, at most MAX_TASK_ATTACHMENTS. Missing or null means none.
fn task_attachments(args: &Value) -> Result<Vec<String>, String> {
    let list = match args.get("attachments") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("attachments must be an array of absolute file paths".into()),
    };
    if list.len() > MAX_TASK_ATTACHMENTS {
        return Err(format!(
            "too many attachments ({}); pass at most {MAX_TASK_ATTACHMENTS} files per task",
            list.len()
        ));
    }
    list.iter()
        .enumerate()
        .map(|(i, v)| {
            let path = v.as_str().ok_or_else(|| format!("attachments[{i}] must be a file path string"))?;
            let p = std::path::Path::new(path);
            if !p.is_absolute() {
                return Err(format!(
                    "attachment '{path}' is not an absolute path; use the full path (the user's attachments are listed after their message)"
                ));
            }
            if p.is_dir() {
                return Err(format!("attachment '{path}' is a folder; attach files only"));
            }
            if !p.is_file() {
                return Err(format!("attachment '{path}' does not exist; check the path"));
            }
            Ok(path.to_string())
        })
        .collect()
}

/// Whether a member's agent program exists here (teams may list agents the
/// user never installed, e.g. the auto team's Antigravity members).
fn installed(hub: &Hub, agent_id: &str) -> bool {
    hub.def(agent_id).is_ok_and(|d| crate::agents::command_exists(&d.command))
}

fn fail(orch: &Orchestra, task_id: &str, message: &str) {
    if let Some(t) = orch.tasks.lock().unwrap().get_mut(task_id) {
        t.info.error = Some(message.into());
        if is_limit_error(message) {
            t.info.limit_hit = true;
        }
    }
    orch.set_status(task_id, "failed");
}

/// Whether an agent's error means its account hit a plan or rate limit.
fn is_limit_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    (m.contains("hit your") && m.contains("limit"))
        || ["usage limit", "rate limit", "usagelimitexceeded", "ratelimitexceeded", "resource_exhausted", "quota exceeded", "quota reached", "429"]
            .iter()
            .any(|k| m.contains(k))
}

/// Whether a whole reply is just the agent saying its quota ran out, e.g.
/// Antigravity's "⚠ Individual quota reached. … Resets in 2h50m59s." Only
/// short replies count, so a member writing *about* rate limits isn't mistaken.
fn is_limit_notice(answer: &str) -> bool {
    let a = answer.trim();
    !a.is_empty() && a.chars().count() <= 300 && is_limit_error(a)
}

/// The model setting a member's limits are tracked under.
fn member_model(m: &Member) -> Option<&str> {
    m.config.get("model").and_then(Value::as_str)
}

fn limit_key(m: &Member) -> (String, String, String) {
    (m.agent_id.clone(), m.profile_id.clone(), member_model(m).unwrap_or_default().to_string())
}

/// When a member can't run now because of its plan limits: Some(reset in
/// Unix seconds, 0 if unknown), None if it can. `info` is a Claude
/// rate-limit report or a usage report with limit groups. Antigravity
/// groups are per model family, so `model` picks the group; with no clear
/// family (default model, Codex) only every group being spent counts.
fn limit_state(info: &Value, model: Option<&str>, now_secs: u64) -> Option<u64> {
    // A reset already past means that part of the report is stale.
    let open = |reset: Option<u64>| match reset {
        Some(r) if r <= now_secs => None,
        r => Some(r.unwrap_or(0)),
    };
    if let Some(groups) = info.get("groups").and_then(Value::as_array) {
        // A group is spent while any of its buckets is; free when all reset.
        let spent = |g: &Value| -> Option<u64> {
            g.get("buckets")?
                .as_array()?
                .iter()
                .filter(|b| b.get("remaining_fraction").and_then(Value::as_f64).is_some_and(|f| f <= 0.0))
                .filter_map(|b| open(bucket_reset(b)))
                .max()
        };
        let model = model.unwrap_or_default().to_lowercase();
        let family = if model.starts_with("gemini") {
            Some("gemini")
        } else if model.contains("claude") || model.contains("gpt") {
            Some("claude") // "Claude and GPT models"
        } else {
            None
        };
        let named = |g: &&Value| {
            family.is_some_and(|f| g.get("name").and_then(Value::as_str).is_some_and(|n| n.to_lowercase().contains(f)))
        };
        let own: Vec<&Value> = groups.iter().filter(named).collect();
        if !own.is_empty() {
            return own.into_iter().filter_map(spent).max();
        }
        let all: Vec<u64> = groups.iter().map(spent).collect::<Option<_>>()?;
        // Free again as soon as the first group resets.
        return if all.is_empty() { None } else { Some(all.iter().copied().filter(|&r| r > 0).min().unwrap_or(0)) };
    }
    let rejected = |v: &Value| v.get("status").and_then(Value::as_str) == Some("rejected");
    let mut until = None;
    if rejected(info) {
        until = open(info.get("resetsAt").and_then(Value::as_u64));
    }
    for w in info.get("unifiedWindows").and_then(Value::as_object).into_iter().flat_map(|w| w.values()) {
        if rejected(w) {
            until = until.max(open(w.get("resetsAt").and_then(Value::as_u64)));
        }
    }
    until
}

/// "14:30 UTC (in 2h 10m)" for a limit's reset; "unknown" for 0.
fn limit_text(now: u64, until: u64) -> String {
    if until == 0 {
        return "unknown".into();
    }
    let mins = until.saturating_sub(now) / 60;
    let day = until % 86400;
    format!("{:02}:{:02} UTC (in {}h {}m)", day / 3600, day % 3600 / 60, mins / 60, mins % 60)
}

/// A limit bucket's reset in Unix seconds (`resets_at` or RFC 3339 `reset_time`).
fn bucket_reset(b: &Value) -> Option<u64> {
    b.get("resets_at").and_then(Value::as_u64).or_else(|| b.get("reset_time").and_then(Value::as_str).and_then(parse_rfc3339))
}

/// "5h 10% used (resets in 2h 10m)" for a reset time in Unix seconds.
fn resets_in(now: u64, reset: u64) -> Option<String> {
    (reset > now).then(|| {
        let mins = (reset - now) / 60;
        format!(" (resets in {}h {}m)", mins / 60, mins % 60)
    })
}

/// One line per limit window for the lead, e.g. "five_hour 10% used (resets
/// in 2h 10m); seven_day 24% used", from Claude's rate-limit report or an
/// Antigravity usage report (limit groups with remaining fractions).
fn usage_summary(info: Option<Value>) -> Value {
    let Some(info) = info else { return Value::Null };
    if let Some(groups) = info.get("groups").and_then(Value::as_array) {
        let now = now_ms() / 1000;
        let parts: Vec<String> = groups
            .iter()
            .flat_map(|g| {
                let group = g.get("name").and_then(Value::as_str).unwrap_or("models").to_string();
                g.get("buckets").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(move |b| {
                    let window = b.get("window").and_then(Value::as_str).unwrap_or("limit");
                    let mut s = format!("{group} {window}");
                    if let Some(left) = b.get("remaining_fraction").and_then(Value::as_f64) {
                        s.push_str(&format!(" {:.0}% used", (1.0 - left).clamp(0.0, 1.0) * 100.0));
                    }
                    if let Some(text) = bucket_reset(&b).and_then(|r| resets_in(now, r)) {
                        s.push_str(&text);
                    }
                    s
                })
            })
            .collect();
        return Value::String(parts.join("; "));
    }
    let windows = info.get("unifiedWindows").and_then(Value::as_object);
    let Some(windows) = windows else {
        return info.get("status").cloned().unwrap_or(Value::Null);
    };
    let now = now_ms() / 1000;
    let parts: Vec<String> = windows
        .iter()
        .map(|(name, w)| {
            let mut s = name.clone();
            if let Some(u) = w.get("utilization").and_then(Value::as_f64) {
                let pct = if u <= 1.0 { u * 100.0 } else { u };
                s.push_str(&format!(" {pct:.0}% used"));
            }
            if let Some(status) = w.get("status").and_then(Value::as_str).filter(|s| *s != "allowed") {
                s.push_str(&format!(" [{status}]"));
            }
            if let Some(text) = w.get("resetsAt").and_then(Value::as_u64).and_then(|r| resets_in(now, r)) {
                s.push_str(&text);
            }
            s
        })
        .collect();
    Value::String(parts.join("; "))
}

const TOOL_NAMES: [&str; 8] =
    ["list_agents", "delegate", "wait", "get_result", "send_followup", "merge_task", "discard_task", "cancel"];

/// Whether `text` names one of Baton's own tools the way agents write MCP
/// tools: `mcp__baton__delegate` (Claude), `mcp_baton_delegate` (Antigravity),
/// `baton.delegate`, `baton/delegate`…
pub fn names_baton_tool(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(SERVER_NAME).any(|(i, _)| {
        if text[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric()) {
            return false; // part of a longer word
        }
        let after = &text[i + SERVER_NAME.len()..];
        let sep = after.chars().take_while(|c| !c.is_ascii_alphanumeric()).count();
        if sep == 0 || sep > 3 {
            return false;
        }
        let rest = &after[sep..];
        TOOL_NAMES.iter().any(|name| rest.starts_with(name) && !rest[name.len()..].starts_with(word))
    })
}

/// For a lead's permission request: the option that allows it, if it only
/// asks to run one of Baton's tools. `earlier` is what the agent reported
/// about the same tool call before asking (some put the tool name only there).
pub fn baton_tool_approval(params: &Value, earlier: Option<&str>) -> Option<String> {
    let call = params.get("toolCall")?;
    let mut text = call.to_string();
    if let Some(earlier) = earlier {
        text.push(' ');
        text.push_str(earlier);
    }
    let server = call.pointer("/input/serverName").or_else(|| call.pointer("/rawInput/serverName")).and_then(Value::as_str);
    let codex_mcp = params.pointer("/_meta/is_mcp_tool_approval") == Some(&Value::Bool(true)) && server == Some(SERVER_NAME);
    if !(codex_mcp || names_baton_tool(&text)) {
        return None;
    }
    let options = params.get("options")?.as_array()?;
    ["allow_once", "allow_always"]
        .iter()
        .find_map(|kind| options.iter().find(|o| o.get("kind").and_then(Value::as_str) == Some(kind)))
        .and_then(|o| o.get("optionId").and_then(Value::as_str))
        .map(str::to_owned)
}

/// Unix seconds of a UTC timestamp like "2026-11-24T12:04:30Z" (fractional
/// seconds ignored). Only the UTC "Z" form is accepted.
fn parse_rfc3339(text: &str) -> Option<u64> {
    let t = text.strip_suffix('Z')?;
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut c = time.split('.').next()?.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min, sec) = (c.next()??, c.next()??, c.next()??);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + min * 60 + sec).ok()
}

fn tool_list() -> Value {
    json!([
        {
            "name": "list_agents",
            "description": "List the team members you can delegate to: id, role, agent, account, settings, remaining usage, and how many tasks each is running.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "delegate",
            "description": "Start a task on a team member in this workspace. Returns a task_id immediately; use wait or get_result for the outcome.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "member": { "type": "string", "description": "Member id from list_agents." },
                    "title": { "type": "string", "description": "Short title shown to the user (a few words)." },
                    "task": { "type": "string", "description": "Complete, self-contained instructions. The member cannot see your conversation." },
                    "writes_files": { "type": "boolean", "description": "Whether the task modifies files. Read-only tasks run in parallel; writing tasks run one at a time. Default true." },
                    "attachments": { "type": "array", "items": { "type": "string", "description": "Absolute file path." }, "description": "Files to give the member (e.g. images the user attached); images are shown to it directly." }
                },
                "required": ["member", "task"]
            }
        },
        {
            "name": "wait",
            "description": "Wait up to 40 seconds for the given tasks to finish, then return their status and results. If all_done is false, call wait again (or do other work meanwhile).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_ids": { "type": "array", "items": { "type": "string" } },
                    "timeout_seconds": { "type": "integer", "description": "Max 40 (the default)." }
                },
                "required": ["task_ids"]
            }
        },
        {
            "name": "get_result",
            "description": "Current status of one task, with its final report once finished.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] }
        },
        {
            "name": "send_followup",
            "description": "Send another instruction to a finished task's member, keeping its context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "message": { "type": "string" },
                    "writes_files": { "type": "boolean" },
                    "attachments": { "type": "array", "items": { "type": "string", "description": "Absolute file path." }, "description": "Files to give the member (e.g. images the user attached); images are shown to it directly." }
                },
                "required": ["task_id", "message"]
            }
        },
        {
            "name": "merge_task",
            "description": "Bring a finished worktree task's changes into the workspace (three-way, file by file) and remove its worktree. Pass files to merge only some of them: the worktree then stays with the rest. Reports merged files, conflicts and what is left.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Repo-relative paths from the task's changed_files to merge now. Leave out to merge everything left." }
                },
                "required": ["task_id"]
            }
        },
        {
            "name": "discard_task",
            "description": "Throw away a worktree task's changes and remove its worktree.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] }
        },
        {
            "name": "cancel",
            "description": "Stop a queued or running task.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] }
        }
    ])
}

async fn method_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

/// MCP over streamable HTTP, answering every request with plain JSON.
async fn handle_mcp(State(app): State<AppHandle>, headers: HeaderMap, Json(msg): Json<Value>) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let orch = app.state::<Orchestra>();
    let Some(lead) = orch.lead(&token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // Notifications (no id) need no answer.
    let Some(id) = id.filter(|v| !v.is_null()) else {
        return StatusCode::ACCEPTED.into_response();
    };

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(match orch.call_tool(&token, &lead, name, &args).await {
                Ok(v) => json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }]
                }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            })
        }
        other => Err((-32601, format!("method not found: {other}"))),
    };

    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    Json(body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lead_messages_get_the_agent_mode_note() {
        let wrapped = wrap_lead_text("fix the login bug", Some("자동"), &[]);
        assert!(wrapped.starts_with(LEAD_PREAMBLE));
        assert!(wrapped.contains("Current team: \"자동\""));
        assert!(wrapped.ends_with("[User message]\nfix the login bug"));
        assert!(!wrapped.contains(ATTACHMENTS_NOTE));
    }

    #[test]
    fn lead_messages_list_their_attachments() {
        let files = ["/Users/me/Shot 1.png".to_string(), "/Users/me/spec.md".to_string()];
        let wrapped = wrap_lead_text("match this design", Some("자동"), &files);
        assert!(wrapped.starts_with(LEAD_PREAMBLE));
        let (before, after) = wrapped.split_once(&format!("\n\n{ATTACHMENTS_NOTE}\n")).unwrap();
        assert!(before.ends_with("[User message]\nmatch this design"));
        assert!(after.contains("delegate's attachments"));
        assert!(after.ends_with("\n- /Users/me/Shot 1.png\n- /Users/me/spec.md"), "{after}");
    }

    #[test]
    fn slash_commands_and_plain_chats_pass_through() {
        let files = ["/Users/me/Shot.png".to_string()];
        assert_eq!(wrap_lead_text("/compact", Some("자동"), &[]), "/compact");
        assert_eq!(wrap_lead_text("/compact", Some("자동"), &files), "/compact");
        assert_eq!(wrap_lead_text("  /compact keep the plan", Some("자동"), &files), "  /compact keep the plan");
        assert_eq!(wrap_lead_text("hello", None, &[]), "hello");
        assert_eq!(wrap_lead_text("hello", None, &files), "hello");
    }

    #[test]
    fn task_attachments_take_existing_absolute_files() {
        let dir = std::env::temp_dir().join(format!("baton-task-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shot.png");
        std::fs::write(&file, b"png").unwrap();
        let file = file.display().to_string();
        let dir_s = dir.display().to_string();
        let missing = dir.join("gone.png").display().to_string();

        assert_eq!(task_attachments(&json!({})), Ok(vec![]));
        assert_eq!(task_attachments(&json!({ "attachments": null })), Ok(vec![]));
        assert_eq!(task_attachments(&json!({ "attachments": [] })), Ok(vec![]));
        assert_eq!(task_attachments(&json!({ "attachments": [file] })), Ok(vec![file.clone()]));

        let err = |args: Value| task_attachments(&args).unwrap_err();
        assert!(err(json!({ "attachments": file })).contains("must be an array"));
        assert!(err(json!({ "attachments": [file, 3] })).contains("attachments[1] must be a file path"));
        assert!(err(json!({ "attachments": ["shot.png"] })).contains("'shot.png' is not an absolute path"));
        assert!(err(json!({ "attachments": [missing] })).contains("does not exist"));
        assert!(err(json!({ "attachments": [dir_s] })).contains("is a folder"));
        let ten = vec![file.clone(); MAX_TASK_ATTACHMENTS];
        assert_eq!(task_attachments(&json!({ "attachments": ten })).map(|v| v.len()), Ok(MAX_TASK_ATTACHMENTS));
        let eleven = vec![file.clone(); MAX_TASK_ATTACHMENTS + 1];
        assert!(err(json!({ "attachments": eleven })).contains("too many attachments (11)"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_summary_reads_claude_rate_limits() {
        assert_eq!(usage_summary(None), Value::Null);
        assert_eq!(usage_summary(Some(json!({ "status": "allowed" }))), json!("allowed"));

        let in_2h_10m = now_ms() / 1000 + 2 * 3600 + 10 * 60 + 30;
        let info = json!({ "unifiedWindows": {
            "five_hour": { "utilization": 0.1, "status": "allowed", "resetsAt": in_2h_10m },
            "seven_day": { "utilization": 87, "status": "allowed_warning", "resetsAt": 1 },
        }});
        let text = usage_summary(Some(info));
        let text = text.as_str().unwrap();
        assert!(text.contains("five_hour 10% used (resets in 2h 10m)"), "{text}");
        // Percent given as 0–100 stays as is; a reset in the past is dropped.
        assert!(text.contains("seven_day 87% used [allowed_warning]"), "{text}");
        assert!(!text.contains("seven_day 87% used [allowed_warning] (resets"), "{text}");
    }

    #[test]
    fn usage_summary_reads_antigravity_groups() {
        let soon = now_ms() / 1000 + 3600 + 5 * 60 + 30;
        let reset = |secs: u64| {
            // Format back to RFC 3339 through the parser's inverse: search the day.
            let days = secs / 86400;
            let rem = secs % 86400;
            let (y, m, d) = civil(days as i64);
            format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.5Z", rem / 3600, rem % 3600 / 60, rem % 60)
        };
        let info = json!({ "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.75, "reset_time": reset(soon) },
                { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 1.0, "reset_time": "2020-01-01T00:00:00Z" },
            ]},
            { "name": "Claude and GPT models", "buckets": [{ "id": "3p-5h", "window": "5h", "remaining_fraction": 0.0 }] },
            { "name": "codex", "buckets": [{ "id": "codex-primary", "window": "5h", "remaining_fraction": 0.5, "resets_at": soon }] },
        ]});
        assert_eq!(
            usage_summary(Some(info)),
            json!("Gemini Models 5h 25% used (resets in 1h 5m); Gemini Models weekly 0% used; Claude and GPT models 5h 100% used; codex 5h 50% used (resets in 1h 5m)")
        );
    }

    #[test]
    fn limit_state_reads_claude_windows() {
        let now = 1_000_000;
        let ok = json!({ "unifiedWindows": {
            "five_hour": { "status": "allowed_warning", "utilization": 0.95, "resetsAt": now + 600 },
        }});
        assert_eq!(limit_state(&ok, Some("sonnet"), now), None);
        let hit = json!({ "unifiedWindows": {
            "five_hour": { "status": "rejected", "utilization": 1.0, "resetsAt": now + 600 },
            "seven_day": { "status": "rejected", "utilization": 1.0, "resetsAt": now + 9000 },
            "seven_day_opus": { "status": "allowed", "utilization": 0.2 },
        }});
        assert_eq!(limit_state(&hit, None, now), Some(now + 9000), "free once every rejected window resets");
        let past = json!({ "unifiedWindows": { "five_hour": { "status": "rejected", "resetsAt": now - 1 } } });
        assert_eq!(limit_state(&past, None, now), None, "a reset in the past is stale");
        assert_eq!(limit_state(&json!({ "status": "rejected" }), None, now), Some(0), "reset unknown");
        assert_eq!(limit_state(&json!({ "status": "allowed" }), None, now), None);
    }

    #[test]
    fn limit_state_picks_the_antigravity_group_by_model() {
        let now = 1_000_000;
        let info = json!({ "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.4, "resets_at": now + 60 },
            ]},
            { "name": "Claude and GPT models", "buckets": [
                { "id": "3p-5h", "window": "5h", "remaining_fraction": 0.0, "reset_time": "1970-01-12T14:00:00Z" },
                { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.5 },
            ]},
        ]});
        let reset = parse_rfc3339("1970-01-12T14:00:00Z").unwrap();
        assert!(reset > now);
        assert_eq!(limit_state(&info, Some("gemini-3-pro"), now), None);
        assert_eq!(limit_state(&info, Some("claude-opus-5-5"), now), Some(reset));
        assert_eq!(limit_state(&info, Some("gpt-oss-120b"), now), Some(reset));
        // Default model: the family is unclear, so one spent group isn't enough.
        assert_eq!(limit_state(&info, None, now), None);
        assert_eq!(limit_state(&info, Some("whatever"), now), None);
        assert_eq!(limit_state(&info, Some("claude-opus-5-5"), reset), None, "reset has passed");

        let all_spent = json!({ "groups": [
            { "name": "Gemini Models", "buckets": [{ "remaining_fraction": 0.0, "resets_at": now + 500 }] },
            { "name": "Claude and GPT models", "buckets": [{ "remaining_fraction": -0.1, "resets_at": now + 100 }] },
        ]});
        assert_eq!(limit_state(&all_spent, None, now), Some(now + 100), "free once the first group resets");
        // Codex: one group, no family needed.
        let codex = json!({ "groups": [{ "name": "codex", "buckets": [
            { "id": "codex-primary", "window": "5h", "remaining_fraction": 0.0 },
            { "id": "codex-secondary", "window": "weekly", "remaining_fraction": 0.3, "resets_at": now + 5 },
        ]}]});
        assert_eq!(limit_state(&codex, Some("gpt-5.5-codex"), now), Some(0));
        assert_eq!(limit_state(&json!({ "groups": [] }), None, now), None);
    }

    #[test]
    fn deepseek_has_no_limits() {
        // dsh reports no plan limits, so there is no info to read.
        assert_eq!(None::<Value>.and_then(|q| limit_state(&q, Some("deepseek-flash"), 0)), None);
        assert_eq!(limit_state(&json!({}), Some(r#"["deepseek-account","deepseek-flash"]"#), 0), None);
    }

    #[test]
    fn recognises_limit_errors() {
        for yes in [
            "You've hit your 5-hour limit · resets 1:30am",
            "Claude AI usage limit reached|1795521870",
            "Rate limit exceeded, try again later",
            "UsageLimitExceeded: plan quota",
            "error: RateLimitExceeded",
            "RESOURCE_EXHAUSTED: quota for gemini-3-pro",
            "Quota exceeded for this project",
            "HTTP 429 Too Many Requests",
            "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h50m59s.",
        ] {
            assert!(is_limit_error(yes), "{yes}");
        }
        assert!(is_limit_notice("\n⚠ Individual quota reached. Please upgrade your subscription. Resets in 2h50m59s.\n"));
        let essay = format!("I added retry logic for the rate limit (HTTP 429) path. {}", "Details follow. ".repeat(30));
        assert!(!is_limit_notice(&essay), "a long report that mentions limits is a real answer");
        assert!(!is_limit_notice(""));
        for no in ["Internal error", "the agent refused the task", "You've hit your head", "connection reset", "lead session is gone"] {
            assert!(!is_limit_error(no), "{no}");
        }
    }

    #[test]
    fn limit_times_read_for_the_lead() {
        let until = 1795521870; // 2026-11-24T12:04:30Z
        assert_eq!(limit_text(until - (2 * 3600 + 10 * 60 + 5), until), "12:04 UTC (in 2h 10m)");
        assert_eq!(limit_text(until, 0), "unknown");
    }

    /// (year, month, day) of a day count since 1970-01-01, to check parse_rfc3339 against.
    fn civil(z: i64) -> (i64, i64, i64) {
        let z = z + 719468;
        let era = z.div_euclid(146097);
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (yoe + era * 400 + i64::from(m <= 2), m, d)
    }

    #[test]
    fn parses_utc_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-24T12:04:30Z"), Some(1795521870));
        assert_eq!(parse_rfc3339("2024-02-29T23:59:59.999Z"), Some(1709251199));
        assert_eq!(parse_rfc3339("2026-11-24T12:04:30+09:00"), None);
        assert_eq!(parse_rfc3339("tomorrow"), None);
    }

    #[test]
    fn recognises_baton_tool_names() {
        for yes in ["mcp__baton__delegate", "Run mcp_baton_list_agents", "baton.wait", "baton/get_result", "Baton: merge_task"] {
            assert!(names_baton_tool(yes), "{yes}");
        }
        for no in ["mcp_other_delegate", "rm -rf baton_wait_x", "mybaton_delegate", "baton_delegates", "baton", "delegate"] {
            assert!(!names_baton_tool(no), "{no}");
        }
    }

    #[test]
    fn approves_only_baton_tools() {
        let options = json!([
            { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
            { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
        ]);
        // Antigravity, as captured from agy 1.5.16.
        let agy = json!({ "sessionId": "s", "options": options, "toolCall": {
            "toolCallId": "call_1", "name": "mcp_baton_list_agents", "title": "Run mcp_baton_list_agents",
            "kind": "other", "rawInput": { "toolSummary": "List team members" } } });
        assert_eq!(baton_tool_approval(&agy, None).as_deref(), Some("allow"));

        // Codex: the request may carry only the call id; the name came earlier.
        let codex = json!({ "sessionId": "s", "options": options, "_meta": { "is_mcp_tool_approval": true },
            "toolCall": { "toolCallId": "c1", "kind": "execute", "status": "pending" } });
        assert_eq!(baton_tool_approval(&codex, Some(r#"{"title":"baton.delegate"}"#)).as_deref(), Some("allow"));
        assert_eq!(baton_tool_approval(&codex, Some(r#"{"title":"github.create_issue"}"#)), None);
        let standalone = json!({ "sessionId": "s", "options": options, "_meta": { "is_mcp_tool_approval": true },
            "toolCall": { "toolCallId": "c2", "title": "MCP tool call approval", "input": { "serverName": "baton" } } });
        assert_eq!(baton_tool_approval(&standalone, None).as_deref(), Some("allow"));

        // Anything else still goes to the user.
        let shell = json!({ "sessionId": "s", "options": options,
            "toolCall": { "toolCallId": "t", "title": "Run rm -rf build", "kind": "execute" } });
        assert_eq!(baton_tool_approval(&shell, None), None);
        let always_only = json!({ "options": [{ "optionId": "yes", "kind": "allow_always" }],
            "toolCall": { "title": "mcp__baton__wait" } });
        assert_eq!(baton_tool_approval(&always_only, None).as_deref(), Some("yes"));
    }

    #[test]
    fn every_listed_tool_has_a_schema() {
        let tools = tool_list();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["list_agents", "delegate", "wait", "get_result", "send_followup", "merge_task", "discard_task", "cancel"]
        );
        for tool in tools.as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object", "{}", tool["name"]);
            assert!(!tool["description"].as_str().unwrap().is_empty());
        }
        let merge = tools.as_array().unwrap().iter().find(|t| t["name"] == "merge_task").unwrap();
        assert_eq!(merge["inputSchema"]["properties"]["files"]["type"], "array");
        assert_eq!(merge["inputSchema"]["required"], json!(["task_id"]));
        for name in ["delegate", "send_followup"] {
            let tool = tools.as_array().unwrap().iter().find(|t| t["name"] == name).unwrap();
            let schema = &tool["inputSchema"];
            assert_eq!(schema["properties"]["attachments"]["type"], "array", "{name}");
            assert_eq!(schema["properties"]["attachments"]["items"]["type"], "string", "{name}");
            assert!(!schema["required"].as_array().unwrap().contains(&json!("attachments")), "{name}");
        }
    }

    fn test_task(id: &str, lead_agent: &str, lead_session: &str) -> Task {
        let member: Member =
            serde_json::from_value(json!({ "id": "m1", "name": "Member", "agentId": "dsh" })).unwrap();
        Task {
            info: TaskInfo {
                id: id.into(),
                lead_agent_id: lead_agent.into(),
                lead_session_id: lead_session.into(),
                title: format!("Task {id}"),
                member_id: member.id.clone(),
                member_name: member.name.clone(),
                agent_id: member.agent_id.clone(),
                session_id: Some(format!("sub-{id}")),
                status: "running".into(),
                writes: true,
                started_at: Some(100),
                ended_at: None,
                error: None,
                isolated: true,
                changes: Vec::new(),
                merge_state: None,
                conflicts: Vec::new(),
                merged: Vec::new(),
                reassigned: Vec::new(),
                limit_hit: false,
                usage: None,
                stalled_since: None,
            },
            member,
            cwd: "/work".into(),
            result: String::new(),
            answer: String::new(),
            after_tool: false,
            notes: Vec::new(),
            cancel_requested: false,
            sandbox: None,
            attachments: Vec::new(),
            last_activity_ms: 0,
            movable: false,
            reassign_to: None,
        }
    }

    /// A finished isolated task on a fresh worktree that changed a.txt and
    /// b.txt, deleted c.txt and added d.txt. Returns (root, repo, task).
    fn partial_setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf, Task) {
        let files = [("a.txt", "a1\na2\na3\n"), ("b.txt", "b1\nb2\nb3\n"), ("c.txt", "c\n")];
        let (root, repo) = crate::worktree::tests::test_repo(name, &files);
        let sb = worktree::create(&repo, &root.join("wts"), name).unwrap();
        std::fs::write(sb.path.join("a.txt"), "A1\na2\na3\n").unwrap();
        std::fs::write(sb.path.join("b.txt"), "B1\nb2\nb3\n").unwrap();
        std::fs::remove_file(sb.path.join("c.txt")).unwrap();
        std::fs::write(sb.path.join("d.txt"), "new\n").unwrap();
        let mut task = test_task(name, "claude", "lead");
        task.info.status = "done".into();
        task.info.changes = vec!["M a.txt".into(), "M b.txt".into(), "D c.txt".into(), "A d.txt".into()];
        task.info.merge_state = Some("pending".into());
        task.sandbox = Some(sb);
        (root, repo, task)
    }

    fn merge_into(task: &mut Task, files: Option<&[&str]>) -> Result<(), String> {
        let sb = task.sandbox.clone().unwrap();
        let files: Option<Vec<String>> = files.map(|f| f.iter().map(|p| p.to_string()).collect());
        // Labels name temp index files: keep them apart across parallel tests.
        let label = format!("{}-merge", task.info.id);
        let plan = plan_merge(&sb, &label, files.as_deref())?;
        let step = apply_merge(&sb, &task.info.id, &label, plan)?;
        record_merge(task, &step);
        Ok(())
    }

    fn read(repo: &std::path::Path, path: &str) -> Option<String> {
        std::fs::read_to_string(repo.join(path)).ok()
    }

    #[test]
    fn partial_merges_keep_the_worktree_until_nothing_is_left() {
        let (root, repo, mut task) = partial_setup("pm-keep");
        let path = task.sandbox.as_ref().unwrap().path.clone();

        merge_into(&mut task, Some(&["a.txt"])).unwrap();
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("A1\na2\na3\n"));
        assert_eq!(read(&repo, "b.txt").as_deref(), Some("b1\nb2\nb3\n"), "unpicked files stay as they were");
        assert!(read(&repo, "c.txt").is_some() && read(&repo, "d.txt").is_none());
        assert!(task.sandbox.is_some() && path.exists(), "the worktree stays for the rest");
        assert_eq!(task.info.changes, ["M b.txt", "D c.txt", "A d.txt"]);
        assert_eq!(task.info.merged, ["a.txt"]);
        assert_eq!(task.info.merge_state.as_deref(), Some("pending"));

        merge_into(&mut task, Some(&["b.txt", "c.txt"])).unwrap();
        assert_eq!(read(&repo, "b.txt").as_deref(), Some("B1\nb2\nb3\n"));
        assert!(read(&repo, "c.txt").is_none(), "the deletion is merged");
        assert!(task.sandbox.is_some() && path.exists());
        assert_eq!(task.info.changes, ["A d.txt"]);
        assert_eq!(task.info.merged, ["a.txt", "b.txt", "c.txt"]);

        merge_into(&mut task, Some(&["d.txt"])).unwrap();
        assert_eq!(read(&repo, "d.txt").as_deref(), Some("new\n"));
        assert!(task.sandbox.is_none() && !path.exists(), "merging the last file removes the worktree");
        assert!(task.info.changes.is_empty());
        assert_eq!(task.info.merged, ["a.txt", "b.txt", "c.txt", "d.txt"]);
        assert_eq!(task.info.merge_state.as_deref(), Some("merged"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_all_after_a_partial_merge_takes_the_rest() {
        let (root, repo, mut task) = partial_setup("pm-rest");
        merge_into(&mut task, Some(&["a.txt"])).unwrap();
        // The user edits a merged file afterwards: merging the rest must not touch it.
        std::fs::write(repo.join("a.txt"), "user\n").unwrap();
        merge_into(&mut task, None).unwrap();
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("user\n"));
        assert_eq!(read(&repo, "b.txt").as_deref(), Some("B1\nb2\nb3\n"));
        assert!(read(&repo, "c.txt").is_none());
        assert_eq!(read(&repo, "d.txt").as_deref(), Some("new\n"));
        assert!(task.sandbox.is_none());
        assert_eq!(task.info.merge_state.as_deref(), Some("merged"));
        assert!(task.info.conflicts.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn partial_merge_rejects_unknown_and_already_merged_paths() {
        let (root, repo, mut task) = partial_setup("pm-unknown");
        let sb = task.sandbox.clone().unwrap();
        let err = plan_merge(&sb, "pm-unknown-plan", Some(&["a.txt".into(), "nope.txt".into()])).err().unwrap();
        assert!(err.contains("nope.txt") && !err.contains("a.txt"), "{err}");
        assert!(plan_merge(&sb, "pm-unknown-plan", Some(&[])).is_err());
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a1\na2\na3\n"), "nothing is merged on a bad list");

        merge_into(&mut task, Some(&["a.txt"])).unwrap();
        let err = merge_into(&mut task, Some(&["a.txt"])).unwrap_err();
        assert!(err.contains("a.txt"), "{err}");
        assert_eq!(task.info.changes.len(), 3);

        assert_eq!(merge_files_arg(&json!({ "task_id": "t" })), Ok(None));
        assert_eq!(merge_files_arg(&json!({ "files": null })), Ok(None));
        assert_eq!(merge_files_arg(&json!({ "files": ["a.txt"] })), Ok(Some(vec!["a.txt".into()])));
        assert!(merge_files_arg(&json!({ "files": "a.txt" })).is_err());
        assert!(merge_files_arg(&json!({ "files": [1] })).is_err());
        remove_sandbox(&mut task);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn remove_sandbox(task: &mut Task) {
        if let Some(sb) = task.sandbox.take() {
            worktree::remove(&sb);
        }
    }

    #[test]
    fn discard_after_a_partial_merge_drops_only_the_rest() {
        let (root, repo, mut task) = partial_setup("pm-discard");
        merge_into(&mut task, Some(&["d.txt"])).unwrap();
        let sb = task.sandbox.clone().unwrap();
        worktree::remove(&sb);
        record_discard(&mut task);
        assert!(!sb.path.exists() && task.sandbox.is_none());
        assert_eq!(task.info.merge_state.as_deref(), Some("discarded"));
        assert_eq!(task.info.changes, ["M a.txt", "M b.txt", "D c.txt"], "what was thrown away");
        assert_eq!(read(&repo, "d.txt").as_deref(), Some("new\n"), "the merged file stays");
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a1\na2\na3\n"));
        assert!(read(&repo, "c.txt").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn partial_merge_conflicts_are_kept_across_merges() {
        let (root, repo, mut task) = partial_setup("pm-conflict");
        std::fs::write(repo.join("b.txt"), "WS\nb2\nb3\n").unwrap();
        merge_into(&mut task, Some(&["b.txt"])).unwrap();
        assert!(read(&repo, "b.txt").unwrap().contains("<<<<<<<"));
        assert!(task.sandbox.is_some());
        assert_eq!(task.info.conflicts, ["b.txt"]);
        assert_eq!(task.info.merged, ["b.txt"]);
        assert_eq!(task.info.merge_state.as_deref(), Some("conflict"));
        assert_eq!(task.info.changes, ["M a.txt", "D c.txt", "A d.txt"]);

        merge_into(&mut task, None).unwrap();
        assert!(task.sandbox.is_none());
        assert_eq!(task.info.conflicts, ["b.txt"], "its markers are still in the workspace");
        assert_eq!(task.info.merge_state.as_deref(), Some("conflict"));
        assert!(read(&repo, "b.txt").unwrap().contains("<<<<<<<"), "a merged file is not merged twice");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn task_changes_lists_whats_left_against_the_moved_base() {
        let (root, repo, mut task) = partial_setup("pm-view");
        let sb = task.sandbox.clone().unwrap();
        let report = changes_report(&sb, "pm-view-list").unwrap();
        assert_eq!(
            report["files"],
            json!([
                { "status": "M", "path": "a.txt" },
                { "status": "M", "path": "b.txt" },
                { "status": "D", "path": "c.txt" },
                { "status": "A", "path": "d.txt" },
            ])
        );
        let result = report["result"].as_str().unwrap().to_string();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        assert_eq!(git(&["rev-parse", &format!("{result}^1")]), sb.base, "a commit diff shows base → task");

        merge_into(&mut task, Some(&["a.txt", "c.txt"])).unwrap();
        let sb = task.sandbox.clone().unwrap();
        let report = changes_report(&sb, "pm-view-list").unwrap();
        assert_eq!(report["files"], json!([{ "status": "M", "path": "b.txt" }, { "status": "A", "path": "d.txt" }]));
        let result = report["result"].as_str().unwrap();
        assert_eq!(git(&["rev-parse", &format!("{result}^1")]), sb.base);
        assert_eq!(git(&["diff", "--name-only", &format!("{result}^1"), result]), "b.txt\nd.txt");

        // A follow-up turn edits a merged file again: it shows up as a change once more.
        std::fs::write(sb.path.join("a.txt"), "A1\na2\nA3\n").unwrap();
        let report = changes_report(&sb, "pm-view-list").unwrap();
        assert_eq!(report["files"][0], json!({ "status": "M", "path": "a.txt" }));
        merge_into(&mut task, Some(&["a.txt"])).unwrap();
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("A1\na2\nA3\n"), "merged against the moved base, no conflict");
        assert!(task.info.conflicts.is_empty());
        remove_sandbox(&mut task);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn handoff_reassigns_only_matching_lead_tasks() {
        let mut tasks = HashMap::from([
            ("t1".into(), test_task("t1", "claude", "old")),
            ("t2".into(), test_task("t2", "claude", "old")),
            ("t3".into(), test_task("t3", "claude", "other")),
            ("t4".into(), test_task("t4", "codex", "old")),
        ]);

        let moved = Orchestra::reassign_tasks(&mut tasks, "claude", "old", "codex", "new");
        let mut moved_ids: Vec<&str> = moved.iter().map(|t| t.id.as_str()).collect();
        moved_ids.sort();
        assert_eq!(moved_ids, ["t1", "t2"]);
        for info in &moved {
            assert_eq!(info.lead_agent_id, "codex");
            assert_eq!(info.lead_session_id, "new");
        }
        assert_eq!((tasks["t1"].info.lead_agent_id.as_str(), tasks["t1"].info.lead_session_id.as_str()), ("codex", "new"));
        assert_eq!((tasks["t2"].info.lead_agent_id.as_str(), tasks["t2"].info.lead_session_id.as_str()), ("codex", "new"));
        assert_eq!((tasks["t3"].info.lead_agent_id.as_str(), tasks["t3"].info.lead_session_id.as_str()), ("claude", "other"));
        assert_eq!((tasks["t4"].info.lead_agent_id.as_str(), tasks["t4"].info.lead_session_id.as_str()), ("codex", "old"));
    }

    #[test]
    fn task_info_serializes_reassigned_and_limit_hit() {
        let info = TaskInfo {
            id: "r1-1".into(),
            lead_agent_id: "claude".into(),
            lead_session_id: "lead".into(),
            title: "Fix bug".into(),
            member_id: "antigravity-claude-opus-5-5".into(),
            member_name: "Antigravity · Opus".into(),
            agent_id: "antigravity".into(),
            session_id: Some("sub-1".into()),
            status: "done".into(),
            writes: true,
            started_at: Some(100),
            ended_at: Some(200),
            error: None,
            isolated: true,
            changes: Vec::new(),
            merge_state: Some("none".into()),
            conflicts: Vec::new(),
            merged: Vec::new(),
            reassigned: vec!["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)".into()],
            limit_hit: true,
            usage: Some(TaskUsage {
                input_tokens: 120_000,
                output_tokens: 8_000,
                cached_read_tokens: 95_000,
                cached_write_tokens: 0,
            }),
            stalled_since: None,
        };
        let serialized = serde_json::to_value(&info).unwrap();
        assert_eq!(
            serialized["reassigned"],
            json!(["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)"])
        );
        assert_eq!(serialized["limitHit"], json!(true));
        assert_eq!(
            serialized["usage"],
            json!({ "inputTokens": 120_000, "outputTokens": 8_000, "cachedReadTokens": 95_000, "cachedWriteTokens": 0 })
        );
    }

    #[test]
    fn add_usage_accumulates_and_handles_missing_fields() {
        // No usage reported -> stays None.
        assert_eq!(add_usage(None, &json!({ "stopReason": "end_turn" })), None);
        assert_eq!(add_usage(None, &json!({ "stopReason": "end_turn", "usage": null })), None);
        assert_eq!(add_usage(None, &json!({ "stopReason": "end_turn", "usage": {} })), None);

        // Missing individual fields default to 0.
        let first = add_usage(
            None,
            &json!({ "stopReason": "end_turn", "usage": { "inputTokens": 40_000, "outputTokens": 2_500 } }),
        );
        assert_eq!(
            first,
            Some(TaskUsage { input_tokens: 40_000, output_tokens: 2_500, cached_read_tokens: 0, ..Default::default() })
        );

        // Follow-up or reassigned member's turn sums into the running total.
        let second = add_usage(
            first,
            &json!({ "stopReason": "end_turn", "usage": { "inputTokens": 80_000, "outputTokens": 5_500, "cachedReadTokens": 95_000 } }),
        );
        assert_eq!(
            second,
            Some(TaskUsage { input_tokens: 120_000, output_tokens: 8_000, cached_read_tokens: 95_000, ..Default::default() })
        );

        // A later turn that omits usage preserves the accumulated total.
        assert_eq!(add_usage(second, &json!({ "stopReason": "end_turn" })), second);
        assert_eq!(add_usage(second, &json!({ "stopReason": "end_turn", "usage": {} })), second);
    }

    #[test]
    fn task_report_formats_compact_tokens_field() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1_000), "1k");
        assert_eq!(format_tokens(1_200), "1.2k");
        assert_eq!(format_tokens(8_000), "8k");
        assert_eq!(format_tokens(120_000), "120k");
        assert_eq!(format_tokens(1_300_000), "1.3M");

        let mut task = test_task("t1", "claude", "lead");
        task.info.status = "done".into();
        let without = task_report(&task, 5000);
        assert!(without.get("tokens").is_none());

        task.info.usage = Some(TaskUsage { input_tokens: 120_000, output_tokens: 8_000, cached_read_tokens: 95_000, ..Default::default() });
        let with_cached = task_report(&task, 5000);
        assert_eq!(with_cached["tokens"], json!("read 215k (cached 95k) · out 8k"));

        task.info.usage = Some(TaskUsage { input_tokens: 850, output_tokens: 42, cached_read_tokens: 0, ..Default::default() });
        let without_cached = task_report(&task, 5000);
        assert_eq!(without_cached["tokens"], json!("read 850 · out 42"));
    }

    #[test]
    fn stall_detection_and_report_field() {
        let after = STALL_AFTER.as_millis() as u64;
        assert!(!is_stalled(1_000, 1_000 + after - 1));
        assert!(is_stalled(1_000, 1_000 + after));
        assert!(!is_stalled(5_000, 1_000));

        let mut task = test_task("t1", "claude", "lead");
        assert!(task_report(&task, 500_000).get("stalled").is_none());
        task.info.stalled_since = Some(100_000);
        assert_eq!(
            task_report(&task, 100_000 + 6 * 60_000)["stalled"],
            json!("no activity for 6m — consider cancel + delegate to another member")
        );
        task.info.status = "done".into();
        assert!(task_report(&task, 500_000).get("stalled").is_none());
        assert!(INSTRUCTIONS.contains("says it is stalled, cancel it"));
        assert!(LEAD_PREAMBLE.contains("says it is stalled, cancel it"));
    }

    #[test]
    fn reassign_target_prefers_requested_member() {
        let team: Team = serde_json::from_value(json!({
            "id": "t", "name": "T",
            "members": [
                { "id": "a", "name": "A", "agentId": "claude" },
                { "id": "b", "name": "B", "agentId": "codex" },
                { "id": "c", "name": "C", "agentId": "dsh" },
            ]
        }))
        .unwrap();
        let a = team.members[0].clone();
        let id = |m: Option<Member>| m.map(|m| m.id);
        let ok = |_: &str| true;
        assert_eq!(id(pick_reassign_target(&team, &a, Some("c"), |_| false, ok)), Some("c".into()));
        // Requested member is the same one, unknown, or not installed: no move.
        assert_eq!(id(pick_reassign_target(&team, &a, Some("a"), |_| false, ok)), None);
        assert_eq!(id(pick_reassign_target(&team, &a, Some("zzz"), |_| false, ok)), None);
        assert_eq!(id(pick_reassign_target(&team, &a, Some("c"), |_| false, |g| g != "dsh")), None);
        // No request: the usual fallback, never the member itself.
        let auto = id(pick_reassign_target(&team, &a, None, |_| false, ok));
        assert!(matches!(auto.as_deref(), Some("b" | "c")));
        assert_eq!(id(pick_reassign_target(&team, &a, None, |_| true, ok)), None);
    }

    #[test]
    fn prompt_constants_guide_targeted_work_and_keep_existing_rules() {
        assert!(SUBTASK_PREAMBLE.starts_with("[Baton] A lead agent"));
        assert!(SUBTASK_PREAMBLE.contains("rg / grep"));
        assert!(SUBTASK_PREAMBLE.contains("AGENTS.md"));
        assert!(SUBTASK_PREAMBLE.contains("CLAUDE.md"));
        assert!(SUBTASK_PREAMBLE.contains("Finish with a short report"));

        assert!(INSTRUCTIONS.contains("user_messages"));
        assert!(INSTRUCTIONS.contains("name the relevant files, functions, and exact checks"));

        assert!(LEAD_PREAMBLE.starts_with("[Baton agent mode"));
        assert!(LEAD_PREAMBLE.contains("user_messages"));
        assert!(LEAD_PREAMBLE.contains("update AGENTS.md (if the repo has one)"));
        assert!(INSTRUCTIONS.contains("update AGENTS.md (if the repo has one)"));
        assert!(SUBTASK_PREAMBLE.contains("update AGENTS.md accordingly"));
        assert!(LEAD_PREAMBLE.contains("name the relevant files, functions, and exact checks"));
    }

    #[test]
    fn inbox_push_remove_and_take_preserve_order_and_drain() {
        let inbox = Inbox::default();
        let item = |id: &str, text: &str, files: &[&str]| InboxItem {
            id: id.into(),
            text: text.into(),
            attachments: files.iter().map(|s| s.to_string()).collect(),
        };

        inbox.push("claude", "s1", item("1", "first", &[]));
        inbox.push("claude", "s1", item("2", "second", &["/a.png"]));
        inbox.push("claude", "s1", item("3", "third", &[]));
        inbox.push("claude", "s2", item("9", "other session", &[]));
        inbox.push("codex", "s1", item("8", "other agent", &[]));

        assert!(inbox.remove("claude", "s1", "2"));
        assert!(!inbox.remove("claude", "s1", "2"), "already removed");
        assert!(!inbox.remove("claude", "missing", "1"));

        let taken = inbox.take("claude", "s1");
        assert_eq!(taken, vec![item("1", "first", &[]), item("3", "third", &[])]);
        assert!(inbox.take("claude", "s1").is_empty(), "take drains the queue");

        assert_eq!(inbox.take("claude", "s2"), vec![item("9", "other session", &[])]);
        assert_eq!(inbox.take("codex", "s1"), vec![item("8", "other agent", &[])]);
    }

    #[test]
    fn inject_user_messages_attaches_fields_or_wraps_non_objects() {
        let items = vec![
            InboxItem { id: "1".into(), text: "change plan".into(), attachments: vec!["/spec.md".into()] },
            InboxItem { id: "2".into(), text: "also add tests".into(), attachments: vec![] },
        ];

        assert_eq!(inject_user_messages(json!({ "ok": true }), &[]), json!({ "ok": true }));

        let obj = inject_user_messages(json!({ "task_id": "t1", "status": "queued" }), &items);
        assert_eq!(obj["task_id"], json!("t1"));
        assert_eq!(obj["status"], json!("queued"));
        assert_eq!(
            obj["user_messages"],
            json!([
                { "text": "change plan", "attachments": ["/spec.md"] },
                { "text": "also add tests", "attachments": [] },
            ])
        );
        assert_eq!(obj["user_messages_note"], json!(USER_MESSAGES_NOTE));

        let wrapped_arr = inject_user_messages(json!([1, 2]), &items);
        assert_eq!(wrapped_arr["result"], json!([1, 2]));
        assert_eq!(wrapped_arr["user_messages"], obj["user_messages"]);
        assert_eq!(wrapped_arr["user_messages_note"], json!(USER_MESSAGES_NOTE));

        let wrapped_str = inject_user_messages(json!("done"), &items);
        assert_eq!(wrapped_str["result"], json!("done"));
        assert_eq!(wrapped_str["user_messages"], obj["user_messages"]);
        assert_eq!(wrapped_str["user_messages_note"], json!(USER_MESSAGES_NOTE));
    }
}
