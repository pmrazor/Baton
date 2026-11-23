//! The hub owns running agent processes and bridges them to the webview.
//!
//! A *runtime* is one agent process. Most agents need one process for
//! everything; agents with `processPerWorkspace` or launch options get one per
//! (workspace, launch values) combination. Each runtime hosts many ACP
//! sessions, and the hub remembers which runtime a session lives in.
//!
//! Agent → client traffic is turned into Tauri events:
//!   - `acp-update`      every `session/update` notification
//!   - `acp-permission`  a `session/request_permission` waiting for the user
//!   - `agent-status`    starting / ready / exited / error
//!   - `agent-log`       agent stderr, for the debug panel
//!   - `agent-auth`      the logged-in account of one profile (Claude only)

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::acp::{self, AcpConnection, Incoming, RpcError, SpawnSpec};
use crate::agents::{AgentDef, LaunchOption};
use crate::profiles::{Profiles, DEFAULT_PROFILE, PROFILE_KEY};

/// ACP's `authRequired` error code.
const AUTH_REQUIRED: i64 = -32000;
/// First `npx` launch may download the adapter, so be generous.
const INIT_TIMEOUT: Duration = Duration::from_secs(180);

pub type Launch = HashMap<String, String>;

pub struct AgentRuntime {
    pub conn: Arc<AcpConnection>,
    pub init: Value,
    /// Sessions this process has created or resumed. The webview can reload
    /// while the process lives on, so it may ask to resume one of these.
    active_sessions: std::sync::Mutex<HashSet<String>>,
}

type Slot = Arc<Mutex<Option<Arc<AgentRuntime>>>>;

/// Where a session lives, so it can be found (or revived) by id alone.
#[derive(Clone)]
struct SessionHome {
    runtime_key: String,
    cwd: String,
    launch: Launch,
}

struct PendingPermission {
    agent_id: String,
    session_id: String,
    runtime_key: String,
    reply: oneshot::Sender<Value>,
}

pub struct Hub {
    app: AppHandle,
    defs: Vec<AgentDef>,
    profiles: Arc<Profiles>,
    /// runtime key → process slot
    slots: std::sync::Mutex<HashMap<String, Slot>>,
    /// (agent id, session id) → home
    homes: std::sync::Mutex<HashMap<(String, String), SessionHome>>,
    permissions: std::sync::Mutex<HashMap<String, PendingPermission>>,
    next_permission: AtomicU64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubError {
    pub message: String,
    pub auth_required: bool,
    /// The agent's advertised `authMethods`, when login is needed.
    pub auth_methods: Value,
}

impl HubError {
    fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), auth_required: false, auth_methods: Value::Null }
    }

    fn with_auth(e: RpcError, rt: &AgentRuntime) -> Self {
        let mut err = HubError::from(e);
        if err.auth_required {
            err.auth_methods = rt.init.get("authMethods").cloned().unwrap_or(Value::Null);
        }
        err
    }
}

impl From<RpcError> for HubError {
    fn from(e: RpcError) -> Self {
        Self { auth_required: e.code == AUTH_REQUIRED, message: e.message, auth_methods: Value::Null }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub login_hint: String,
    pub running: bool,
    pub launch_options: Vec<LaunchOption>,
    /// Supports several accounts (has a `profileEnv`).
    pub multi_account: bool,
    pub login_note: String,
}

impl Hub {
    pub fn new(app: AppHandle, defs: Vec<AgentDef>, profiles: Arc<Profiles>) -> Self {
        Self {
            app,
            defs,
            profiles,
            slots: Default::default(),
            homes: Default::default(),
            permissions: Default::default(),
            next_permission: AtomicU64::new(1),
        }
    }

    pub fn def(&self, agent_id: &str) -> Result<&AgentDef, HubError> {
        self.defs
            .iter()
            .find(|d| d.id == agent_id)
            .ok_or_else(|| HubError::plain(format!("unknown agent: {agent_id}")))
    }

    pub async fn list(&self) -> Vec<AgentInfo> {
        let mut out = Vec::with_capacity(self.defs.len());
        for def in &self.defs {
            let mut running = false;
            for slot in self.agent_slots(&def.id) {
                running |= slot.lock().await.is_some();
            }
            out.push(AgentInfo {
                id: def.id.clone(),
                name: def.name.clone(),
                description: def.description.clone(),
                login_hint: def.login_hint.clone(),
                running,
                launch_options: def.launch_options.clone(),
                multi_account: def.profile_env.is_some(),
                login_note: def.login_note.clone(),
            });
        }
        out
    }

    /// Identity of the process a session with these settings should run in.
    fn runtime_key(&self, def: &AgentDef, cwd: &str, launch: &Launch) -> String {
        let mut key = def.id.clone();
        if def.process_per_workspace {
            key.push('|');
            key.push_str(cwd);
        }
        for (id, _, value) in def.resolve_launch(launch) {
            key.push_str(&format!("|{id}={value}"));
        }
        let profile = self.profile_of(def, launch);
        if profile != DEFAULT_PROFILE {
            key.push_str(&format!("|{PROFILE_KEY}={profile}"));
        }
        key
    }

    /// The session's account; anything unusable falls back to the default login.
    fn profile_of(&self, def: &AgentDef, launch: &Launch) -> String {
        launch
            .get(PROFILE_KEY)
            .filter(|p| def.profile_env.is_some() && self.profiles.home(&def.id, p).is_some())
            .cloned()
            .unwrap_or_else(|| DEFAULT_PROFILE.to_string())
    }

    /// (env var, home folder) that selects this profile's account.
    pub fn profile_env(&self, def: &AgentDef, profile_id: &str) -> Option<(String, std::path::PathBuf)> {
        let var = def.profile_env.clone()?;
        Some((var, self.profiles.home(&def.id, profile_id)?))
    }

    fn slot(&self, key: &str) -> Slot {
        self.slots.lock().unwrap().entry(key.to_string()).or_default().clone()
    }

    fn agent_slots(&self, agent_id: &str) -> Vec<Slot> {
        let prefix = format!("{agent_id}|");
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| *k == agent_id || k.starts_with(&prefix))
            .map(|(_, s)| s.clone())
            .collect()
    }

    /// Get the runtime for these settings, starting it if needed.
    async fn runtime(&self, agent_id: &str, cwd: &str, launch: &Launch) -> Result<(String, Arc<AgentRuntime>), HubError> {
        let def = self.def(agent_id)?.clone();
        let resolved = def.resolve_launch(launch);
        let key = self.runtime_key(&def, cwd, launch);
        let slot = self.slot(&key);
        let mut guard = slot.lock().await;
        if let Some(rt) = guard.as_ref() {
            return Ok((key, rt.clone()));
        }

        let mut env = def.env.clone();
        for (_, var, value) in &resolved {
            env.insert(var.clone(), value.clone());
        }
        let profile_id = self.profile_of(&def, launch);
        if let Some((var, home)) = self.profile_env(&def, &profile_id) {
            std::fs::create_dir_all(&home).map_err(|e| HubError::plain(format!("계정 폴더 생성 실패: {e}")))?;
            env.insert(var, home.display().to_string());
        }

        self.emit_status(agent_id, "starting", None);
        let (conn, incoming) = AcpConnection::spawn(SpawnSpec {
            command: &def.command,
            args: &def.args,
            env: &env,
            cwd: def.process_per_workspace.then_some(cwd),
        })
        .map_err(|e| {
            let msg = format!("`{}` 실행 실패: {e}", def.command);
            self.emit_status(agent_id, "error", Some(&msg));
            HubError::plain(msg)
        })?;

        tokio::spawn(pump_incoming(
            self.app.clone(),
            agent_id.to_string(),
            profile_id,
            key.clone(),
            conn.clone(),
            incoming,
        ));

        let params = json!({
            "protocolVersion": acp::PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false,
                "auth": { "terminal": true }
            },
            "clientInfo": { "name": "baton", "version": env!("CARGO_PKG_VERSION") }
        });
        let init = match tokio::time::timeout(INIT_TIMEOUT, conn.request("initialize", params)).await {
            Ok(Ok(init)) => init,
            Ok(Err(e)) => {
                conn.kill();
                self.emit_status(agent_id, "error", Some(&e.message));
                return Err(e.into());
            }
            Err(_) => {
                conn.kill();
                let msg = "에이전트 초기화 시간 초과";
                self.emit_status(agent_id, "error", Some(msg));
                return Err(HubError::plain(msg));
            }
        };

        let rt = Arc::new(AgentRuntime { conn, init, active_sessions: Default::default() });
        *guard = Some(rt.clone());
        self.emit_status(agent_id, "ready", None);
        Ok((key, rt))
    }

    fn remember(&self, agent_id: &str, session_id: &str, home: SessionHome, rt: &AgentRuntime) {
        rt.active_sessions.lock().unwrap().insert(session_id.to_string());
        self.homes.lock().unwrap().insert((agent_id.to_string(), session_id.to_string()), home);
    }

    pub async fn new_session(&self, agent_id: &str, cwd: &str, launch: &Launch) -> Result<Value, HubError> {
        let (key, rt) = self.runtime(agent_id, cwd, launch).await?;
        let params = json!({ "cwd": cwd, "mcpServers": [] });
        let mut session = rt
            .conn
            .request("session/new", params)
            .await
            .map_err(|e| HubError::with_auth(e, &rt))?;

        let session_id = session.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
        let home = SessionHome { runtime_key: key, cwd: cwd.to_string(), launch: launch.clone() };
        self.remember(agent_id, &session_id, home, &rt);

        for (config_id, value) in &self.def(agent_id)?.default_config {
            let params = json!({ "sessionId": session_id, "configId": config_id, "value": value });
            match rt.conn.request("session/set_config_option", params).await {
                Ok(res) => {
                    if let Some(opts) = res.get("configOptions") {
                        session["configOptions"] = opts.clone();
                    }
                }
                Err(e) => self.emit_log(agent_id, &format!("[hub] default config {config_id} 적용 실패: {e}")),
            }
        }
        Ok(session)
    }

    /// Reattach a persisted session. Already-live sessions (e.g. after a
    /// webview reload) succeed with `{ "alreadyActive": true }`.
    pub async fn resume_session(
        &self,
        agent_id: &str,
        session_id: &str,
        cwd: &str,
        launch: &Launch,
    ) -> Result<Value, HubError> {
        let (key, rt) = self.runtime(agent_id, cwd, launch).await?;
        let home = SessionHome { runtime_key: key, cwd: cwd.to_string(), launch: launch.clone() };
        if rt.active_sessions.lock().unwrap().contains(session_id) {
            self.remember(agent_id, session_id, home, &rt);
            return Ok(json!({ "alreadyActive": true }));
        }
        let params = json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] });
        let res = match rt.conn.request("session/resume", params).await {
            Ok(res) => res,
            // Live in this process but unknown to us (e.g. created before a hub restart).
            Err(e) if e.message.contains("already active") => json!({ "alreadyActive": true }),
            Err(e) => return Err(HubError::with_auth(e, &rt)),
        };
        self.remember(agent_id, session_id, home, &rt);
        Ok(res)
    }

    /// The runtime hosting a session; restarts and resumes it if its process
    /// has exited since.
    async fn session_runtime(&self, agent_id: &str, session_id: &str) -> Result<Arc<AgentRuntime>, HubError> {
        let home = self
            .homes
            .lock()
            .unwrap()
            .get(&(agent_id.to_string(), session_id.to_string()))
            .cloned()
            .ok_or_else(|| HubError::plain("연결되지 않은 대화예요. 대화를 다시 열어 주세요."))?;
        let live = self.slot(&home.runtime_key).lock().await.clone();
        match live {
            Some(rt) if rt.active_sessions.lock().unwrap().contains(session_id) => Ok(rt),
            _ => {
                self.resume_session(agent_id, session_id, &home.cwd, &home.launch).await?;
                let rt = self.slot(&home.runtime_key).lock().await.clone();
                rt.ok_or_else(|| HubError::plain("에이전트를 다시 시작하지 못했어요"))
            }
        }
    }

    pub async fn prompt(&self, agent_id: &str, session_id: &str, text: &str) -> Result<Value, HubError> {
        let rt = self.session_runtime(agent_id, session_id).await?;
        let params = json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }]
        });
        rt.conn
            .request("session/prompt", params)
            .await
            .map_err(|e| HubError::with_auth(e, &rt))
    }

    pub async fn cancel(&self, agent_id: &str, session_id: &str) -> Result<(), HubError> {
        // ACP requires answering outstanding permission prompts with `cancelled`.
        let cancelled: Vec<_> = {
            let mut perms = self.permissions.lock().unwrap();
            let keys: Vec<_> = perms
                .iter()
                .filter(|(_, p)| p.agent_id == agent_id && p.session_id == session_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter().filter_map(|k| perms.remove(&k)).collect()
        };
        for p in cancelled {
            let _ = p.reply.send(json!({ "outcome": "cancelled" }));
        }

        let key = self
            .homes
            .lock()
            .unwrap()
            .get(&(agent_id.to_string(), session_id.to_string()))
            .map(|h| h.runtime_key.clone());
        let Some(key) = key else { return Ok(()) };
        let Some(rt) = self.slot(&key).lock().await.clone() else { return Ok(()) };
        rt.conn
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .await
            .map_err(|e| HubError::plain(e.to_string()))
    }

    /// Send a session-scoped request (`params.sessionId` must be set).
    pub async fn call_session(&self, agent_id: &str, session_id: &str, method: &str, params: Value) -> Result<Value, HubError> {
        let rt = self.session_runtime(agent_id, session_id).await?;
        Ok(rt.conn.request(method, params).await?)
    }

    pub fn respond_permission(&self, key: &str, option_id: Option<String>) -> Result<(), HubError> {
        let pending = self
            .permissions
            .lock()
            .unwrap()
            .remove(key)
            .ok_or_else(|| HubError::plain("이미 처리된 권한 요청입니다"))?;
        let outcome = match option_id {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let _ = pending.reply.send(outcome);
        Ok(())
    }

    /// Stop every process running under one account (e.g. before deleting it).
    pub async fn stop_profile(&self, agent_id: &str, profile_id: &str) {
        let marker = format!("|{PROFILE_KEY}={profile_id}");
        let slots: Vec<Slot> = self
            .slots
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{agent_id}|")) && k.ends_with(&marker))
            .map(|(_, s)| s.clone())
            .collect();
        for slot in slots {
            if let Some(rt) = slot.lock().await.take() {
                rt.conn.kill();
            }
        }
    }

    /// Stop every process of this agent.
    pub async fn stop(&self, agent_id: &str) {
        for slot in self.agent_slots(agent_id) {
            if let Some(rt) = slot.lock().await.take() {
                rt.conn.kill();
            }
        }
    }

    fn register_permission(&self, agent_id: &str, session_id: &str, runtime_key: &str) -> (String, oneshot::Receiver<Value>) {
        let key = format!("perm-{}", self.next_permission.fetch_add(1, Ordering::Relaxed));
        let (reply, rx) = oneshot::channel();
        self.permissions.lock().unwrap().insert(
            key.clone(),
            PendingPermission {
                agent_id: agent_id.into(),
                session_id: session_id.into(),
                runtime_key: runtime_key.into(),
                reply,
            },
        );
        (key, rx)
    }

    async fn on_exit(&self, agent_id: &str, runtime_key: &str, conn: &Arc<AcpConnection>, code: Option<i32>) {
        // Only clear the slot if it still holds this process; a restart may
        // already have replaced it.
        let slot = self.slot(runtime_key);
        let mut guard = slot.lock().await;
        if guard.as_ref().is_some_and(|rt| Arc::ptr_eq(&rt.conn, conn)) {
            *guard = None;
        }
        drop(guard);
        self.permissions.lock().unwrap().retain(|_, p| p.runtime_key != runtime_key);
        let msg = code.map(|c| format!("exit code {c}"));
        self.emit_status(agent_id, "exited", msg.as_deref());
    }

    fn emit_log(&self, agent_id: &str, line: &str) {
        let _ = self.app.emit("agent-log", json!({ "agentId": agent_id, "line": line }));
    }

    fn emit_status(&self, agent_id: &str, status: &str, message: Option<&str>) {
        let _ = self
            .app
            .emit("agent-status", json!({ "agentId": agent_id, "status": status, "message": message }));
    }
}

async fn pump_incoming(
    app: AppHandle,
    agent_id: String,
    profile_id: String,
    runtime_key: String,
    conn: Arc<AcpConnection>,
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
) {
    use tauri::Manager;

    while let Some(msg) = incoming.recv().await {
        match msg {
            Incoming::Notification { method, params } if method == "session/update" => {
                let _ = app.emit(
                    "acp-update",
                    json!({
                        "agentId": agent_id,
                        "profileId": profile_id,
                        "sessionId": params.get("sessionId"),
                        "update": params.get("update"),
                    }),
                );
            }
            // Claude adapter extension: who is logged in for this process.
            Incoming::Notification { method, params } if method == "_auth/status_update" => {
                let _ = app.emit(
                    "agent-auth",
                    json!({ "agentId": agent_id, "profileId": profile_id, "authStatus": params.get("authStatus") }),
                );
            }
            Incoming::Notification { .. } => {}
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                let hub = app.state::<Hub>();
                let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
                let (key, reply) = hub.register_permission(&agent_id, session_id, &runtime_key);
                let _ = app.emit(
                    "acp-permission",
                    json!({
                        "key": key,
                        "agentId": agent_id,
                        "sessionId": session_id,
                        "toolCall": params.get("toolCall"),
                        "options": params.get("options"),
                    }),
                );
                let conn = conn.clone();
                tokio::spawn(async move {
                    let outcome = reply.await.unwrap_or_else(|_| json!({ "outcome": "cancelled" }));
                    let _ = conn.respond(id, Ok(json!({ "outcome": outcome }))).await;
                });
            }
            Incoming::Request { id, method, .. } => {
                let _ = conn.respond(id, Err(RpcError::method_not_found(&method))).await;
            }
            Incoming::Stderr(line) => {
                let _ = app.emit("agent-log", json!({ "agentId": agent_id, "line": line }));
            }
            Incoming::Exited(code) => {
                app.state::<Hub>().on_exit(&agent_id, &runtime_key, &conn, code).await;
                break;
            }
        }
    }
}
