//! Minimal ACP (Agent Client Protocol) client transport.
//!
//! An agent runs as a child process and speaks newline-delimited JSON-RPC 2.0
//! over stdin/stdout. This module owns the process, matches responses to our
//! requests, and forwards everything the agent initiates (notifications and
//! requests such as `session/request_permission`) to an `Incoming` channel.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("method not found: {method}"))
    }

    fn from_value(v: &Value) -> Self {
        Self {
            code: v.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: v.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_string(),
            data: v.get("data").cloned(),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            v["data"] = data.clone();
        }
        v
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// Everything the agent sends, in the order it was sent. Responses travel
/// through here too (resolved with `AcpConnection::resolve`), so a turn's
/// final `session/update`s are always handled before its prompt response.
#[derive(Debug)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: i64, result: Result<Value, RpcError> },
    Stderr(String),
    Exited(Option<i32>),
}

pub struct SpawnSpec<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a HashMap<String, String>,
    pub cwd: Option<&'a str>,
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct AcpConnection {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicI64,
    pending: Pending,
}

impl AcpConnection {
    pub fn spawn(spec: SpawnSpec<'_>) -> std::io::Result<(Arc<Self>, mpsc::UnboundedReceiver<Incoming>)> {
        let mut cmd = platform_command(spec.command, spec.args);
        cmd.envs(spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = spec.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let (tx, rx) = mpsc::unbounded_channel();

        let conn = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicI64::new(1),
            pending: Pending::default(),
        });

        let stderr_tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stderr_tx.send(Incoming::Stderr(line));
            }
        });

        let reader_conn = conn.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(msg) => route_message(msg, &tx),
                    Err(_) => {
                        let _ = tx.send(Incoming::Stderr(format!("[non-JSON stdout] {line}")));
                    }
                }
            }

            // stdout closed: the agent is gone. The consumer fails whatever is
            // still pending once it reaches `Exited`, after any queued responses.
            let code = reader_conn.child.lock().await.wait().await.ok().and_then(|s| s.code());
            let _ = tx.send(Incoming::Exited(code));
        });

        Ok((conn, rx))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (waiter, result) = oneshot::channel();
        self.pending.lock().await.insert(id, waiter);

        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write(&msg).await {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::new(-32000, format!("failed to write to agent: {e}")));
        }

        result.await.unwrap_or_else(|_| Err(RpcError::new(-32000, "agent connection closed")))
    }

    pub async fn notify(&self, method: &str, params: Value) -> std::io::Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    pub async fn respond(&self, id: Value, result: Result<Value, RpcError>) -> std::io::Result<()> {
        let msg = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(err) => json!({ "jsonrpc": "2.0", "id": id, "error": err.to_value() }),
        };
        self.write(&msg).await
    }

    /// Fail every request still waiting; call on `Incoming::Exited`.
    pub async fn fail_pending(&self) {
        for (_, waiter) in self.pending.lock().await.drain() {
            let _ = waiter.send(Err(RpcError::new(-32000, "agent process exited")));
        }
    }

    /// Complete one of our requests. Call it from the `Incoming` consumer.
    pub async fn resolve(&self, id: i64, result: Result<Value, RpcError>) {
        if let Some(waiter) = self.pending.lock().await.remove(&id) {
            let _ = waiter.send(result);
        }
    }

    pub fn kill(&self) {
        // If the lock is held, the reader task is already waiting on exit.
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }

    async fn write(&self, msg: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await
    }
}

fn route_message(msg: Value, tx: &mpsc::UnboundedSender<Incoming>) {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
    let id = msg.get("id").cloned().filter(|id| !id.is_null());
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    match (method, id) {
        (Some(method), Some(id)) => {
            let _ = tx.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            let _ = tx.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let result = match msg.get("error") {
                Some(err) => Err(RpcError::from_value(err)),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(Incoming::Response { id, result });
        }
        (None, None) => {}
    }
}

/// Windows: hide the console window a GUI app's child would otherwise get.
/// The agent's own children (node → claude) inherit the hidden console.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// On Windows, `npx` and friends are `.cmd` shims that `CreateProcess` cannot
/// launch directly, so route everything through `cmd /C`, without a window.
pub(crate) fn platform_command(command: &str, args: &[String]) -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command).args(args);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    } else {
        let mut cmd = Command::new(command);
        cmd.args(args);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(msg: Value) -> Option<Incoming> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        route_message(msg, &tx);
        rx.try_recv().ok()
    }

    #[test]
    fn messages_are_sorted_by_shape() {
        match route(json!({ "jsonrpc": "2.0", "id": "p1", "method": "session/request_permission", "params": { "a": 1 } })) {
            Some(Incoming::Request { id, method, params }) => {
                assert_eq!((id, method.as_str(), params), (json!("p1"), "session/request_permission", json!({ "a": 1 })));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            route(json!({ "jsonrpc": "2.0", "method": "session/update", "params": {} })),
            Some(Incoming::Notification { method, .. }) if method == "session/update"
        ));
        // A null id is a notification, not a request.
        assert!(matches!(
            route(json!({ "jsonrpc": "2.0", "id": null, "method": "x" })),
            Some(Incoming::Notification { .. })
        ));
        assert!(matches!(
            route(json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": true } })),
            Some(Incoming::Response { id: 7, result: Ok(v) }) if v == json!({ "ok": true })
        ));
        assert!(matches!(
            route(json!({ "jsonrpc": "2.0", "id": 8, "error": { "code": -32000, "message": "auth required" } })),
            Some(Incoming::Response { id: 8, result: Err(e) }) if e.code == -32000 && e.message == "auth required"
        ));
        // Responses to ids we never send (non-numeric) and junk are dropped.
        assert!(route(json!({ "jsonrpc": "2.0", "id": "x", "result": {} })).is_none());
        assert!(route(json!({ "hello": "world" })).is_none());
    }
}
