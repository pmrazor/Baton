//! Agent mode: a lead agent delegates tasks to team members.
//!
//! Baton serves a small MCP server on 127.0.0.1. Each lead session gets its
//! own bearer token, so a tool call is attributed to the lead that made it.
//! A delegated task is an ordinary ACP session created through the hub; its
//! progress streams to the UI like any chat, and this module tracks status,
//! the final answer, and serialises file-writing tasks per workspace.
//!
//! Events for the UI:
//!   - `task-update`   a task's status changed (TaskInfo)
//!   - `task-session`  a task's session exists (so the UI can list it)
//!   - `task-brief`    the lead sent a follow-up instruction to a task

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
use crate::teams::{Member, Team, Teams};
use crate::worktree::{self, Sandbox};

const SERVER_NAME: &str = "baton";
/// Longest single `wait`. Claude Code's MCP client gives up on a tool call
/// after about a minute (a 90 s wait still timed out), so return well before
/// that and let the lead call again.
const MAX_WAIT: Duration = Duration::from_secs(40);
/// Results handed back to the lead are clipped to keep its context small.
const MAX_RESULT_CHARS: usize = 8000;

const INSTRUCTIONS: &str = "\
You are the lead agent in Baton, a desktop workspace where several coding agents work together.
You can hand work to team members with the baton tools:
- Call list_agents first: it shows the team, what each member is good at, and how much of its usage limit is left.
- Split the request into self-contained tasks. Members cannot see this conversation, so each task message must carry
  everything needed: goal, relevant files, constraints, and what to report back.
- Choose the member whose role fits. Prefer members with more usage left, and give simple work to cheaper members.
- Set writes_files=false for read-only tasks (research, review, analysis); they run in parallel in the workspace.
  File-writing tasks depend on the team's isolation (see list_agents):
  - \"worktree\": each runs in parallel in its own copy of the workspace. Its changes reach the workspace only when you
    call merge_task, so review them first (the report lists changed files and the copy's path), merge accepted tasks
    one at a time, fix any conflicts merge_task reports, and discard_task the rest.
  - \"shared\": they run one at a time directly in the workspace.
- Use wait to collect results, then check and integrate them before answering.
- Delegating is the default: the user turned on agent mode to have the team do the work. Do a task yourself only
  when the whole request is a quick question or a one-line change.
- The user can message a member directly; those messages come back to you as user_notes.
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
Work alone only if the whole request is a quick question or a one-line change.
";

const SUBTASK_PREAMBLE: &str = "\
[Baton] A lead agent assigned you the task below. Work in the current workspace. \
Finish with a short report: what you did, files you changed, and anything left undone or uncertain.";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
}

pub struct Orchestra {
    app: AppHandle,
    port: u16,
    leads: Mutex<HashMap<String, Lead>>,
    tasks: Mutex<HashMap<String, Task>>,
    by_session: Mutex<HashMap<(String, String), String>>,
    write_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_task: AtomicU64,
    worktrees_dir: std::path::PathBuf,
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
        let worktrees_dir = app
            .path()
            .app_data_dir()
            .map(|d| d.join("worktrees"))
            .unwrap_or_else(|_| std::env::temp_dir().join("baton-worktrees"));
        Ok(Self {
            app,
            port,
            worktrees_dir,
            leads: Default::default(),
            tasks: Default::default(),
            by_session: Default::default(),
            write_locks: Default::default(),
            next_task: AtomicU64::new(1),
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
    pub fn lead_prompt(&self, agent_id: &str, session_id: &str, text: &str) -> String {
        let team_id = self
            .leads
            .lock()
            .unwrap()
            .values()
            .find(|l| l.agent_id == agent_id && l.session_id.as_deref() == Some(session_id))
            .map(|l| l.team_id.clone());
        match team_id {
            Some(team_id) => {
                let team = self.app.state::<Teams>().get(&team_id);
                format!(
                    "{LEAD_PREAMBLE}Current team: \"{}\". If it differs from the team you last listed, call list_agents again.\n[User message]\n{text}",
                    team.name
                )
            }
            None => text.to_string(),
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

    /// Lead-only ACP `_meta`: let the lead call baton tools without prompting.
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

    /// A user message typed into a task's own chat; reported back to the lead.
    pub fn add_note(&self, task_id: &str, text: &str) {
        if let Some(task) = self.tasks.lock().unwrap().get_mut(task_id) {
            task.notes.push(text.to_string());
        }
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

    // ---------- tools ----------

    fn list_agents(&self, lead: &Lead) -> Value {
        let team = self.app.state::<Teams>().get(&lead.team_id);
        let hub = self.app.state::<Hub>();
        let profiles = self.app.state::<Arc<Profiles>>();
        let tasks = self.tasks.lock().unwrap();
        let members: Vec<Value> = team
            .members
            .iter()
            .map(|m| {
                let account = if m.profile_id == DEFAULT_PROFILE {
                    "default".to_string()
                } else {
                    profiles.list().into_iter().find(|p| p.id == m.profile_id).map(|p| p.name).unwrap_or(m.profile_id.clone())
                };
                let active = tasks.values().filter(|t| t.member.id == m.id && !Self::is_terminal(&t.info.status)).count();
                json!({
                    "id": m.id,
                    "name": m.name,
                    "role": m.role,
                    "agent": m.agent_id,
                    "account": account,
                    "settings": { "launch": m.launch, "config": m.config },
                    "usage": usage_summary(hub.quota(&m.agent_id, &m.profile_id)),
                    "active_tasks": active,
                })
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
        let task_text = args.get("task").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).ok_or("task is required")?;
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| task_text.chars().take(40).collect());
        let writes = args.get("writes_files").and_then(Value::as_bool).unwrap_or(true);
        let lead_session_id = lead.session_id.clone().ok_or("lead session is not ready yet")?;
        let isolated =
            writes && team.isolation == "worktree" && worktree::repo_root(std::path::Path::new(&lead.cwd)).is_some();

        let id = format!("t{}", self.next_task.fetch_add(1, Ordering::Relaxed));
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
        let elapsed = task.info.started_at.map(|s| (task.info.ended_at.unwrap_or_else(now_ms) - s) / 1000);
        let mut result: String = task.result.chars().take(MAX_RESULT_CHARS).collect();
        if task.result.chars().count() > MAX_RESULT_CHARS {
            result.push_str("\n[…truncated]");
        }
        json!({
            "task_id": id,
            "title": task.info.title,
            "member": task.info.member_id,
            "status": task.info.status,
            "elapsed_seconds": elapsed,
            "result": if Self::is_terminal(&task.info.status) { Value::String(result) } else { Value::Null },
            "error": task.info.error,
            "user_notes": task.notes,
            "isolated": task.info.isolated,
            "worktree_path": task.sandbox.as_ref().map(|s| s.path.display().to_string()),
            "changed_files": task.info.changes,
            "merge_state": task.info.merge_state,
            "conflicts": task.info.conflicts,
        })
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

    /// Bring an isolated task's changes into the workspace and drop its worktree.
    pub async fn merge(&self, id: &str) -> Result<Value, String> {
        let sandbox = {
            let tasks = self.tasks.lock().unwrap();
            let task = tasks.get(id).ok_or("unknown task")?;
            if !Self::is_terminal(&task.info.status) {
                return Err("task is still running".into());
            }
            task.sandbox.clone().ok_or("nothing to merge: the task has no worktree (shared, merged or discarded)")?
        };
        let label = format!("{id}-merge");
        let task_id = id.to_string();
        let sb = sandbox.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<worktree::MergeOutcome, String> {
            let (result, list) = worktree::changes(&sb, &label)?;
            let outcome = worktree::merge(&sb, &result, &list, &task_id)?;
            worktree::remove(&sb);
            Ok(outcome)
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(task) = self.tasks.lock().unwrap().get_mut(id) {
            task.sandbox = None;
            task.info.conflicts = outcome.conflicts.clone();
            task.info.merge_state = Some(if outcome.conflicts.is_empty() { "merged" } else { "conflict" }.into());
        }
        self.emit_task(id);
        Ok(json!({
            "task_id": id,
            "merged_files": outcome.merged,
            "conflicts": outcome.conflicts,
            "note": if outcome.conflicts.is_empty() { "All changes are in the workspace." } else {
                "Conflicting text files now contain <<<<<<< markers (binary files kept the workspace version); resolve them in the workspace."
            },
        }))
    }

    /// Drop an isolated task's worktree without merging.
    pub async fn discard(&self, id: &str) -> Result<Value, String> {
        let sandbox = {
            let tasks = self.tasks.lock().unwrap();
            let task = tasks.get(id).ok_or("unknown task")?;
            task.sandbox.clone()
        };
        if let Some(sb) = sandbox {
            let _ = tokio::task::spawn_blocking(move || worktree::remove(&sb)).await;
        }
        if let Some(task) = self.tasks.lock().unwrap().get_mut(id) {
            task.sandbox = None;
            if task.info.isolated {
                task.info.merge_state = Some("discarded".into());
            }
        }
        self.emit_task(id);
        Ok(json!({ "task_id": id, "merge_state": "discarded" }))
    }

    async fn call_tool(&self, token: &str, lead: &Lead, name: &str, args: &Value) -> Result<Value, String> {
        match name {
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
                self.merge(id).await
            }
            "discard_task" => {
                let id = args.get("task_id").and_then(Value::as_str).ok_or("task_id is required")?;
                self.discard(id).await
            }
            other => Err(format!("unknown tool '{other}'")),
        }
    }
}

/// One turn of a task: start its session if needed, honour the parallel and
/// write limits, prompt, and record the final answer.
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

    let (member, mut cwd, isolated) = {
        let tasks = orch.tasks.lock().unwrap();
        let Some(t) = tasks.get(&task_id) else { return };
        (t.member.clone(), t.cwd.clone(), t.info.isolated)
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
        let mut launch: Launch = member.launch.clone();
        launch.insert(PROFILE_KEY.into(), member.profile_id.clone());
        let session = match hub.new_session(&member.agent_id, &cwd, &launch, json!([]), &member.config, Value::Null).await {
            Ok(s) => s,
            Err(e) => return fail(&orch, &task_id, &e.message),
        };
        let Some(session_id) = session.get("sessionId").and_then(Value::as_str).map(str::to_owned) else {
            return fail(&orch, &task_id, "agent returned no session id");
        };
        orch.by_session.lock().unwrap().insert((member.agent_id.clone(), session_id.clone()), task_id.clone());
        let info = {
            let mut tasks = orch.tasks.lock().unwrap();
            let Some(t) = tasks.get_mut(&task_id) else { return };
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
                "brief": message,
            }),
        );
    } else if let Some(info) = orch.tasks.lock().unwrap().get(&task_id).map(|t| t.info.clone()) {
        let _ = app.emit("task-brief", json!({ "task": info, "text": message }));
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

    let session_id = {
        let mut tasks = orch.tasks.lock().unwrap();
        let Some(t) = tasks.get_mut(&task_id) else { return };
        t.answer.clear();
        t.after_tool = false;
        t.info.session_id.clone()
    };
    let Some(session_id) = session_id else { return fail(&orch, &task_id, "task has no session") };
    orch.set_status(&task_id, "running");

    let prompt = if first { format!("{SUBTASK_PREAMBLE}\n\n{message}") } else { message };
    let outcome = hub.prompt(&member.agent_id, &session_id, &prompt).await;
    let status = {
        let mut tasks = orch.tasks.lock().unwrap();
        let Some(t) = tasks.get_mut(&task_id) else { return };
        t.result = std::mem::take(&mut t.answer);
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
                t.info.error = Some(e.message.clone());
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
                t.info.changes = list.iter().map(|c| format!("{} {}", c.status, c.path)).collect();
                t.info.merge_state = Some(if list.is_empty() { "none" } else { "pending" }.into());
            }
        }
    }
    orch.set_status(&task_id, status);
}

fn fail(orch: &Orchestra, task_id: &str, message: &str) {
    if let Some(t) = orch.tasks.lock().unwrap().get_mut(task_id) {
        t.info.error = Some(message.into());
    }
    orch.set_status(task_id, "failed");
}

/// "five_hour 10% used (resets in 2h 10m); seven_day 24% used" from Claude's rate-limit report.
fn usage_summary(info: Option<Value>) -> Value {
    let Some(info) = info else { return Value::Null };
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
            if let Some(reset) = w.get("resetsAt").and_then(Value::as_u64).filter(|r| *r > now) {
                let mins = (reset - now) / 60;
                s.push_str(&format!(" (resets in {}h {}m)", mins / 60, mins % 60));
            }
            s
        })
        .collect();
    Value::String(parts.join("; "))
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
                    "writes_files": { "type": "boolean", "description": "Whether the task modifies files. Read-only tasks run in parallel; writing tasks run one at a time. Default true." }
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
                    "writes_files": { "type": "boolean" }
                },
                "required": ["task_id", "message"]
            }
        },
        {
            "name": "merge_task",
            "description": "Bring a finished worktree task's changes into the workspace (three-way, file by file) and remove its worktree. Reports merged files and conflicts.",
            "inputSchema": { "type": "object", "properties": { "task_id": { "type": "string" } }, "required": ["task_id"] }
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
