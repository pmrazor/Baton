//! Shared MCP servers: registered once in Baton (`mcp.json` in the app config
//! dir) and attached to every agent session through ACP's `mcpServers`.
//!
//! - `McpStore` keeps the list (disk + memory); the hub merges the enabled
//!   servers into each session request with `merge_shared`.
//! - `check` really starts/contacts a server and runs `initialize` + `tools/list`.
//! - `own_servers` lists, read-only, what agents have in their own config files.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// Name used by Baton's own MCP server for leads; shared servers may not take it.
pub const RESERVED_NAME: &str = "baton";
const MAX_SERVERS: usize = 32;
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TOOL_PAGES: usize = 5;
const PROTOCOL_VERSION: &str = "2025-06-18";

// ---------------------------------------------------------------- types ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpEnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<McpEnvVar>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<McpEnvVar>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub transport: McpTransport,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckResult {
    pub ok: bool,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<McpTool>,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentSupport {
    pub agent_id: String,
    pub agent_name: String,
    pub http: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentOwnServer {
    pub agent_id: String,
    pub source: String,
    pub name: String,
    pub kind: String,
    pub summary: String,
}

// ---------------------------------------------------------------- store ----

/// The shared list: loaded from `mcp.json` at startup, replaced by `mcp_save`.
pub struct McpStore {
    file: PathBuf,
    list: RwLock<Vec<McpServerConfig>>,
}

impl McpStore {
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join("mcp.json");
        let list = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { file, list: RwLock::new(list) }
    }

    pub fn list(&self) -> Vec<McpServerConfig> {
        self.list.read().unwrap().clone()
    }

    pub fn enabled(&self) -> Vec<McpServerConfig> {
        self.list.read().unwrap().iter().filter(|s| s.enabled).cloned().collect()
    }

    pub fn save(&self, servers: Vec<McpServerConfig>) -> Result<(), String> {
        validate(&servers)?;
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("설정 폴더를 만들지 못했어요: {e}"))?;
        }
        // Write then rename so a crash mid-write never leaves a truncated file.
        let tmp = self.file.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&servers).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| format!("MCP 설정을 저장하지 못했어요: {e}"))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| format!("MCP 설정을 저장하지 못했어요: {e}"))?;
        *self.list.write().unwrap() = servers;
        Ok(())
    }
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "올바른 서버 주소(URL)가 아니에요.".to_string())?;
    let host = parsed.host_str().unwrap_or("");
    match parsed.scheme() {
        "https" if !host.is_empty() => Ok(()),
        "http" if is_local_host(host) => Ok(()),
        _ => Err("서버 주소는 https:// 로 시작해야 해요. (http:// 는 localhost만 가능해요.)".into()),
    }
}

pub fn validate(servers: &[McpServerConfig]) -> Result<(), String> {
    if servers.len() > MAX_SERVERS {
        return Err(format!("MCP 서버는 최대 {MAX_SERVERS}개까지 등록할 수 있어요."));
    }
    let mut seen = HashSet::new();
    for s in servers {
        if !valid_name(&s.name) {
            return Err(format!("서버 이름 \"{}\"은(는) 쓸 수 없어요. 영문, 숫자, _, - 만 1~64자로 입력해 주세요.", s.name));
        }
        if s.name.eq_ignore_ascii_case(RESERVED_NAME) {
            return Err(format!("\"{RESERVED_NAME}\"은(는) Baton이 쓰는 이름이라 사용할 수 없어요."));
        }
        if !seen.insert(s.name.to_ascii_lowercase()) {
            return Err(format!("서버 이름 \"{}\"이(가) 중복돼요.", s.name));
        }
        match &s.transport {
            McpTransport::Stdio { command, env, .. } => {
                if command.trim().is_empty() {
                    return Err(format!("\"{}\" 서버의 실행 명령을 입력해 주세요.", s.name));
                }
                if env.iter().any(|e| e.name.trim().is_empty()) {
                    return Err(format!("\"{}\" 서버의 환경 변수 이름이 비어 있어요.", s.name));
                }
            }
            McpTransport::Http { url, headers } => {
                validate_url(url).map_err(|e| format!("\"{}\" 서버: {e}", s.name))?;
                if headers.iter().any(|h| h.name.trim().is_empty()) {
                    return Err(format!("\"{}\" 서버의 헤더 이름이 비어 있어요.", s.name));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- merge ----

fn env_list(vars: &[McpEnvVar]) -> Vec<Value> {
    vars.iter().map(|v| json!({ "name": v.name, "value": v.value })).collect()
}

/// Add the enabled shared servers to an ACP `McpServer[]`. http servers only
/// when the agent supports them; names already in `base` (e.g. "baton") win.
pub fn merge_shared(base: Value, shared: &[McpServerConfig], http_ok: bool) -> Value {
    let mut list = match base {
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    let mut names: HashSet<String> =
        list.iter().filter_map(|s| s.get("name").and_then(Value::as_str)).map(str::to_owned).collect();
    for s in shared.iter().filter(|s| s.enabled) {
        if names.contains(&s.name) {
            continue;
        }
        let entry = match &s.transport {
            McpTransport::Stdio { command, args, env } => {
                json!({ "name": s.name, "command": command, "args": args, "env": env_list(env) })
            }
            McpTransport::Http { url, headers } => {
                if !http_ok {
                    eprintln!("공유 MCP 서버 \"{}\" 건너뜀: 이 에이전트는 http 전송을 지원하지 않아요.", s.name);
                    continue;
                }
                json!({ "type": "http", "name": s.name, "url": url, "headers": env_list(headers) })
            }
        };
        names.insert(s.name.clone());
        list.push(entry);
    }
    Value::Array(list)
}

// ------------------------------------------------- JSON-RPC pure pieces ----

fn rpc_request(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn rpc_notification(method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "method": method })
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "Baton", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// A response (result or error) to request `id`; anything else (server
/// requests, notifications, other ids) is `None`.
fn response_for(msg: &Value, id: i64) -> Option<Value> {
    let obj = msg.as_object()?;
    (obj.get("id").and_then(Value::as_i64) == Some(id) && (obj.contains_key("result") || obj.contains_key("error")))
        .then(|| msg.clone())
}

/// One stdout line → the response to `id`, ignoring non-JSON and unrelated lines.
fn parse_stdout_line(line: &str, id: i64) -> Option<Value> {
    let msg: Value = serde_json::from_str(line.trim()).ok()?;
    response_for(&msg, id)
}

/// Find the response to `id` in an SSE body (`data:` lines, events split by blank lines).
fn parse_sse_response(body: &str, id: i64) -> Option<Value> {
    let mut data = String::new();
    let mut found = None;
    let mut flush = |data: &mut String| {
        if !data.is_empty() {
            if let Some(r) = serde_json::from_str::<Value>(data).ok().and_then(|m| response_for(&m, id)) {
                found = Some(r);
            }
            data.clear();
        }
    };
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            flush(&mut data);
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush(&mut data);
    found
}

/// A plain JSON body is either one response or a batch.
fn parse_json_response(body: &str, id: i64) -> Option<Value> {
    match serde_json::from_str::<Value>(body.trim()).ok()? {
        Value::Array(items) => items.iter().find_map(|m| response_for(m, id)),
        msg => response_for(&msg, id),
    }
}

/// `result` of a response, or its error message.
fn result_of(resp: Value) -> Result<Value, String> {
    if let Some(err) = resp.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("알 수 없는 오류");
        return Err(format!("서버가 오류를 돌려줬어요: {msg}"));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

fn parse_tools_page(result: &Value) -> (Vec<McpTool>, Option<String>) {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(McpTool {
                        name: t.get("name")?.as_str()?.to_string(),
                        description: t.get("description").and_then(Value::as_str).map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let cursor = result.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned);
    (tools, cursor)
}

// ------------------------------------------------------------ handshake ----

struct Handshake {
    server_name: Option<String>,
    server_version: Option<String>,
    tools: Vec<McpTool>,
}

trait Rpc {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String>;
    async fn notify(&mut self, method: &str) -> Result<(), String>;
}

async fn handshake<R: Rpc>(rpc: &mut R) -> Result<Handshake, String> {
    let init = rpc.call("initialize", initialize_params()).await?;
    rpc.notify("notifications/initialized").await?;
    let info = init.get("serverInfo");
    let text = |k: &str| info.and_then(|i| i.get(k)).and_then(Value::as_str).map(str::to_owned);
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_TOOL_PAGES {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let page = rpc.call("tools/list", params).await?;
        let (mut found, next) = parse_tools_page(&page);
        tools.append(&mut found);
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }
    Ok(Handshake { server_name: text("name"), server_version: text("version"), tools })
}

// ---------------------------------------------------------------- stdio ----

struct StdioRpc<R, W> {
    reader: R,
    writer: W,
    next_id: i64,
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> StdioRpc<R, W> {
    fn new(reader: R, writer: W) -> Self {
        Self { reader, writer, next_id: 1 }
    }

    async fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).await.map_err(|_| "서버가 입력을 받지 않고 종료됐어요.".to_string())?;
        self.writer.flush().await.map_err(|_| "서버가 입력을 받지 않고 종료됐어요.".to_string())
    }
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> Rpc for StdioRpc<R, W> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&rpc_request(id, method, params)).await?;
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line).await.map_err(|e| format!("서버 출력을 읽지 못했어요: {e}"))?;
            if n == 0 {
                return Err("서버가 응답하기 전에 종료됐어요.".into());
            }
            if let Some(resp) = parse_stdout_line(&line, id) {
                return result_of(resp);
            }
        }
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        self.send(&rpc_notification(method)).await
    }
}

fn with_stderr(msg: &str, tail: &Mutex<VecDeque<String>>) -> String {
    let lines: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
    if lines.is_empty() {
        msg.to_string()
    } else {
        format!("{msg}\n{}", lines.join("\n"))
    }
}

async fn check_stdio(command: &str, args: &[String], env: &[McpEnvVar]) -> Result<Handshake, String> {
    let mut cmd = crate::acp::platform_command(command, args);
    if let Some(path) = crate::shell_env::refreshed_path() {
        cmd.env("PATH", path);
    }
    for v in env {
        cmd.env(&v.name, &v.value);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("서버를 시작하지 못했어요: {e}"))?;
    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let tail: Arc<Mutex<VecDeque<String>>> = Default::default();
    let tail_writer = tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut t = tail_writer.lock().unwrap();
            if t.len() >= 5 {
                t.pop_front();
            }
            t.push_back(line);
        }
    });

    let mut rpc = StdioRpc::new(BufReader::new(stdout), stdin);
    let outcome = tokio::time::timeout(CHECK_TIMEOUT, handshake(&mut rpc)).await;
    drop(rpc);
    let _ = child.kill().await;
    match outcome {
        Ok(Ok(h)) => Ok(h),
        Ok(Err(e)) => {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Err(with_stderr(&e, &tail))
        }
        Err(_) => Err(with_stderr("응답이 없어요 (20초)", &tail)),
    }
}

// ----------------------------------------------------------------- http ----

struct HttpRpc {
    client: reqwest::Client,
    url: String,
    headers: reqwest::header::HeaderMap,
    session: Option<reqwest::header::HeaderValue>,
    next_id: i64,
}

impl HttpRpc {
    fn new(url: &str, headers: &[McpEnvVar]) -> Result<Self, String> {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
        let client = crate::extensions::http_client().map_err(|e| e.message)?;
        let mut map = HeaderMap::new();
        for h in headers {
            let name = HeaderName::from_bytes(h.name.trim().as_bytes())
                .map_err(|_| format!("헤더 이름 \"{}\"이(가) 올바르지 않아요.", h.name))?;
            let mut value = HeaderValue::from_str(&h.value)
                .map_err(|_| format!("헤더 \"{}\"의 값이 올바르지 않아요.", h.name))?;
            value.set_sensitive(true);
            map.insert(name, value);
        }
        map.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        map.insert(ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
        Ok(Self { client, url: url.trim().to_string(), headers: map, session: None, next_id: 1 })
    }

    async fn post(&mut self, body: &Value, id: Option<i64>) -> Result<Option<Value>, String> {
        let mut req = self.client.post(&self.url).headers(self.headers.clone()).body(body.to_string());
        if let Some(s) = &self.session {
            req = req.header("Mcp-Session-Id", s.clone()).header("MCP-Protocol-Version", PROTOCOL_VERSION);
        }
        let mut resp = req.send().await.map_err(|e| format!("서버에 연결하지 못했어요: {}", describe_http_error(e)))?;
        if let Some(s) = resp.headers().get("mcp-session-id") {
            self.session = Some(s.clone());
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("서버가 HTTP {}을(를) 돌려줬어요.", status.as_u16()));
        }
        let Some(id) = id else { return Ok(None) };
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/event-stream"));
        if is_sse {
            // Stop as soon as our response arrived; the stream may stay open.
            let mut buf = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| format!("응답을 읽지 못했어요: {}", describe_http_error(e)))? {
                buf.extend_from_slice(&chunk);
                if let Some(r) = parse_sse_response(&String::from_utf8_lossy(&buf), id) {
                    return Ok(Some(r));
                }
            }
            Err("서버 응답에서 결과를 찾지 못했어요.".into())
        } else {
            let text = resp.text().await.map_err(|e| format!("응답을 읽지 못했어요: {}", describe_http_error(e)))?;
            parse_json_response(&text, id).map(Some).ok_or_else(|| "서버 응답을 해석하지 못했어요.".to_string())
        }
    }
}

/// reqwest errors without the URL (it may carry secrets in the query).
fn describe_http_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

impl Rpc for HttpRpc {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let resp = self.post(&rpc_request(id, method, params), Some(id)).await?;
        result_of(resp.ok_or_else(|| "서버 응답이 비어 있어요.".to_string())?)
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        self.post(&rpc_notification(method), None).await.map(|_| ())
    }
}

async fn check_http(url: &str, headers: &[McpEnvVar]) -> Result<Handshake, String> {
    let mut rpc = HttpRpc::new(url, headers)?;
    match tokio::time::timeout(CHECK_TIMEOUT, handshake(&mut rpc)).await {
        Ok(r) => r,
        Err(_) => Err("응답이 없어요 (20초)".into()),
    }
}

/// Start/contact the server and list its tools. Never errors: failures are in the result.
pub async fn check(server: &McpServerConfig) -> McpCheckResult {
    let started = Instant::now();
    let outcome = match &server.transport {
        McpTransport::Stdio { command, args, env } => {
            if command.trim().is_empty() {
                Err("실행 명령을 입력해 주세요.".to_string())
            } else {
                check_stdio(command.trim(), args, env).await
            }
        }
        McpTransport::Http { url, headers } => match validate_url(url) {
            Ok(()) => check_http(url, headers).await,
            Err(e) => Err(e),
        },
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(h) => McpCheckResult {
            ok: true,
            server_name: h.server_name,
            server_version: h.server_version,
            tools: h.tools,
            error: None,
            elapsed_ms,
        },
        Err(e) => McpCheckResult { ok: false, error: Some(e), elapsed_ms, ..Default::default() },
    }
}

// ------------------------------------------------------- agents' own ------

/// URL without query string/fragment (they may hold tokens) and credentials.
fn strip_url(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        Err(_) => url.split(['?', '#']).next().unwrap_or("").to_string(),
    }
}

fn command_line(command: &str, args: &[String]) -> String {
    std::iter::once(command.to_string()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ")
}

fn own_entry(agent_id: &str, source: &str, name: &str, kind: Option<&str>, command: Option<&str>, args: Vec<String>, url: Option<&str>) -> Option<McpAgentOwnServer> {
    let (default_kind, summary) = match (url, command) {
        (Some(u), _) => ("http", strip_url(u)),
        (None, Some(c)) => ("stdio", command_line(c, &args)),
        (None, None) => return None,
    };
    Some(McpAgentOwnServer {
        agent_id: agent_id.to_string(),
        source: source.to_string(),
        name: name.to_string(),
        kind: kind.filter(|k| !k.is_empty()).unwrap_or(default_kind).to_string(),
        summary,
    })
}

/// `mcpServers` object of `~/.claude.json`.
fn parse_claude(text: &str) -> Vec<McpAgentOwnServer> {
    let Ok(root) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else { return Vec::new() };
    servers
        .iter()
        .filter_map(|(name, s)| {
            let args = s
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            own_entry(
                "claude",
                "~/.claude.json",
                name,
                s.get("type").and_then(Value::as_str),
                s.get("command").and_then(Value::as_str),
                args,
                s.get("url").and_then(Value::as_str),
            )
        })
        .collect()
}

/// `[mcp_servers.<name>]` tables of `~/.codex/config.toml`.
fn parse_codex(text: &str) -> Vec<McpAgentOwnServer> {
    let Ok(root) = text.parse::<toml::Table>() else { return Vec::new() };
    let Some(servers) = root.get("mcp_servers").and_then(|v| v.as_table()) else { return Vec::new() };
    servers
        .iter()
        .filter_map(|(name, s)| {
            let args = s
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_owned).collect())
                .unwrap_or_default();
            own_entry(
                "codex",
                "~/.codex/config.toml",
                name,
                None,
                s.get("command").and_then(|v| v.as_str()),
                args,
                s.get("url").and_then(|v| v.as_str()),
            )
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Best effort, read-only; unreadable or unparsable files yield nothing.
pub fn own_servers() -> Vec<McpAgentOwnServer> {
    let Some(home) = home_dir() else { return Vec::new() };
    let mut out = Vec::new();
    if let Ok(t) = std::fs::read_to_string(home.join(".claude.json")) {
        out.extend(parse_claude(&t));
    }
    if let Ok(t) = std::fs::read_to_string(home.join(".codex").join("config.toml")) {
        out.extend(parse_codex(&t));
    }
    out
}

/// Largest pasted TOML the importer accepts.
const MAX_TOML_BYTES: usize = 256 * 1024;

/// Parses pasted TOML (e.g. a Codex `config.toml` snippet) into plain JSON so the
/// frontend importer can treat it like JSON.
pub fn parse_toml(text: &str) -> Result<Value, String> {
    if text.len() > MAX_TOML_BYTES {
        return Err("TOML은 256KB까지만 가져올 수 있어요.".into());
    }
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| {
        let message = e.to_string();
        let first = message.lines().next().unwrap_or("").trim();
        format!("올바른 TOML 형식이 아니에요: {first}")
    })?;
    serde_json::to_value(table).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_parse_toml(text: String) -> Result<Value, String> {
    parse_toml(&text)
}

// ---------------------------------------------------------------- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_toml_converts_codex_shape_to_json() {
        let value = parse_toml(
            "[mcp_servers.github]\ncommand = \"npx\"\nargs = [\"-y\", \"srv\"]\nenv = { GITHUB_TOKEN = \"t\" }\nenabled = false\n\n[mcp_servers.docs]\nurl = \"https://d.dev/mcp\"\n[mcp_servers.docs.http_headers]\nX-Key = \"k\"\n",
        )
        .unwrap();
        assert_eq!(value["mcp_servers"]["github"]["command"], json!("npx"));
        assert_eq!(value["mcp_servers"]["github"]["args"], json!(["-y", "srv"]));
        assert_eq!(value["mcp_servers"]["github"]["env"]["GITHUB_TOKEN"], json!("t"));
        assert_eq!(value["mcp_servers"]["github"]["enabled"], json!(false));
        assert_eq!(value["mcp_servers"]["docs"]["url"], json!("https://d.dev/mcp"));
        assert_eq!(value["mcp_servers"]["docs"]["http_headers"]["X-Key"], json!("k"));
    }

    #[test]
    fn parse_toml_reports_first_line_of_error_in_korean() {
        let err = parse_toml("= broken").unwrap_err();
        assert!(err.starts_with("올바른 TOML 형식이 아니에요: "), "{err}");
        assert!(!err.contains('\n'), "{err}");
        assert!(mcp_parse_toml("[unclosed".into()).is_err());
    }

    #[test]
    fn parse_toml_rejects_oversized_input() {
        let big = format!("a = \"{}\"", "x".repeat(MAX_TOML_BYTES));
        assert_eq!(parse_toml(&big).unwrap_err(), "TOML은 256KB까지만 가져올 수 있어요.");
    }

    fn stdio(name: &str) -> McpServerConfig {
        McpServerConfig {
            name: name.into(),
            enabled: true,
            transport: McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "srv".into()],
                env: vec![McpEnvVar { name: "K".into(), value: "V".into() }],
            },
        }
    }

    fn http(name: &str, url: &str) -> McpServerConfig {
        McpServerConfig {
            name: name.into(),
            enabled: true,
            transport: McpTransport::Http {
                url: url.into(),
                headers: vec![McpEnvVar { name: "Authorization".into(), value: "Bearer x".into() }],
            },
        }
    }

    #[test]
    fn serde_shape_matches_the_contract() {
        let v = serde_json::to_value(stdio("a")).unwrap();
        assert_eq!(v["transport"]["type"], "stdio");
        assert_eq!(v["transport"]["args"][0], "-y");
        let back: McpServerConfig = serde_json::from_value(json!({
            "name": "h", "enabled": false,
            "transport": { "type": "http", "url": "https://x.dev/mcp", "headers": [] }
        }))
        .unwrap();
        assert!(!back.enabled);
        assert!(matches!(back.transport, McpTransport::Http { .. }));
        let r = serde_json::to_value(McpCheckResult { ok: true, elapsed_ms: 5, ..Default::default() }).unwrap();
        assert_eq!(r["elapsedMs"], 5);
    }

    #[test]
    fn validation_rules() {
        assert!(validate(&[stdio("ok_name-1"), http("web", "https://x.dev/mcp"), http("loc", "http://localhost:3000/mcp")]).is_ok());
        assert!(validate(&[stdio("a"), stdio("a")]).is_err());
        assert!(validate(&[stdio("bad name")]).is_err());
        assert!(validate(&[stdio("")]).is_err());
        assert!(validate(&[stdio(&"x".repeat(65))]).is_err());
        assert!(validate(&[stdio("baton")]).is_err());
        assert!(validate(&[http("w", "http://example.com/mcp")]).is_err());
        assert!(validate(&[http("w", "ftp://example.com")]).is_err());
        assert!(validate(&[http("w", "not a url")]).is_err());
        let mut empty_cmd = stdio("e");
        empty_cmd.transport = McpTransport::Stdio { command: "  ".into(), args: vec![], env: vec![] };
        assert!(validate(&[empty_cmd]).is_err());
        let many: Vec<_> = (0..33).map(|i| stdio(&format!("s{i}"))).collect();
        assert!(validate(&many).is_err());
        assert!(validate(&many[..32]).is_ok());
    }

    #[test]
    fn store_saves_and_reloads() {
        let dir = std::env::temp_dir().join(format!("baton-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = McpStore::load(&dir);
        assert!(store.list().is_empty());
        let mut off = stdio("off");
        off.enabled = false;
        store.save(vec![stdio("on"), off]).unwrap();
        assert_eq!(store.enabled().len(), 1);
        assert!(store.save(vec![stdio("baton")]).is_err());
        assert_eq!(store.list().len(), 2);
        assert_eq!(McpStore::load(&dir).list().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_converts_and_filters() {
        let base = json!([{ "type": "http", "name": "baton", "url": "http://127.0.0.1:1/mcp", "headers": [] }]);
        let mut disabled = stdio("off");
        disabled.enabled = false;
        let shared = vec![stdio("fs"), http("web", "https://x.dev/mcp"), disabled, stdio("baton")];

        let with_http = merge_shared(base.clone(), &shared, true);
        let list = with_http.as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["name"], "baton");
        assert_eq!(list[0]["url"], "http://127.0.0.1:1/mcp");
        assert_eq!(list[1], json!({ "name": "fs", "command": "npx", "args": ["-y", "srv"], "env": [{ "name": "K", "value": "V" }] }));
        assert_eq!(
            list[2],
            json!({ "type": "http", "name": "web", "url": "https://x.dev/mcp", "headers": [{ "name": "Authorization", "value": "Bearer x" }] })
        );

        let no_http = merge_shared(base, &shared, false);
        assert_eq!(no_http.as_array().unwrap().len(), 2);
        assert_eq!(merge_shared(json!([]), &[], true), json!([]));
        assert_eq!(merge_shared(Value::Null, &[stdio("a")], false).as_array().unwrap().len(), 1);
    }

    #[test]
    fn stdout_lines_are_filtered_by_id() {
        assert!(parse_stdout_line("starting up...", 1).is_none());
        assert!(parse_stdout_line(r#"{"jsonrpc":"2.0","method":"notifications/message","params":{}}"#, 1).is_none());
        assert!(parse_stdout_line(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#, 1).is_none());
        assert!(parse_stdout_line(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, 1).is_none());
        assert!(parse_stdout_line(r#"{"jsonrpc":"2.0","id":1,"result":{"a":1}}"#, 1).is_some());
        let err = parse_stdout_line(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"boom"}}"#, 1).unwrap();
        assert!(result_of(err).unwrap_err().contains("boom"));
    }

    #[test]
    fn sse_and_json_bodies() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n\
                    event: message\r\ndata: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":3,\"result\":{\"ok\":true}}\r\n\r\n";
        // multi-line data joins with \n, which is valid JSON whitespace
        assert_eq!(parse_sse_response(body, 3).unwrap()["result"]["ok"], true);
        assert!(parse_sse_response(body, 4).is_none());
        // trailing event without blank line
        assert!(parse_sse_response("data: {\"id\":1,\"result\":{}}", 1).is_some());
        assert!(parse_json_response(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, 1).is_some());
        assert!(parse_json_response(r#"[{"id":9,"result":{}},{"id":1,"result":{}}]"#, 1).is_some());
        assert!(parse_json_response("<html>", 1).is_none());
    }

    #[test]
    fn tools_pages() {
        let (tools, next) = parse_tools_page(&json!({ "tools": [{ "name": "a", "description": "d" }, { "name": "b" }, { "bad": 1 }], "nextCursor": "c2" }));
        assert_eq!(tools, vec![McpTool { name: "a".into(), description: Some("d".into()) }, McpTool { name: "b".into(), description: None }]);
        assert_eq!(next.as_deref(), Some("c2"));
        assert_eq!(parse_tools_page(&json!({ "tools": [] })).1, None);
    }

    #[tokio::test]
    async fn stdio_handshake_over_in_memory_pipes() {
        use tokio::io::{duplex, split};
        let (client, server) = duplex(8192);
        let (cr, cw) = split(client);
        let (sr, mut sw) = split(server);

        // Fake server: noise on stdout, a ping request, two tool pages.
        let fake = tokio::spawn(async move {
            let mut lines = BufReader::new(sr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: Value = serde_json::from_str(&line).unwrap();
                let Some(id) = msg.get("id").cloned() else { continue };
                let reply = match msg["method"].as_str().unwrap() {
                    "initialize" => {
                        assert_eq!(msg["params"]["protocolVersion"], PROTOCOL_VERSION);
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "serverInfo": { "name": "fake", "version": "1.2" } } })
                    }
                    "tools/list" if msg["params"].get("cursor").is_none() => {
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "one", "description": "first" }], "nextCursor": "p2" } })
                    }
                    "tools/list" => {
                        assert_eq!(msg["params"]["cursor"], "p2");
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "two" }] } })
                    }
                    other => panic!("unexpected {other}"),
                };
                sw.write_all(b"booting server...\n").await.unwrap();
                sw.write_all(format!("{{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"ping\"}}\n{reply}\n").as_bytes()).await.unwrap();
            }
        });

        let mut rpc = StdioRpc::new(BufReader::new(cr), cw);
        let h = handshake(&mut rpc).await.unwrap();
        assert_eq!(h.server_name.as_deref(), Some("fake"));
        assert_eq!(h.server_version.as_deref(), Some("1.2"));
        assert_eq!(h.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["one", "two"]);
        drop(rpc);
        fake.await.unwrap();
    }

    #[tokio::test]
    async fn stdio_eof_is_an_error_not_a_hang() {
        use tokio::io::{duplex, split};
        let (client, server) = duplex(1024);
        drop(server);
        let (cr, cw) = split(client);
        let mut rpc = StdioRpc::new(BufReader::new(cr), cw);
        assert!(handshake(&mut rpc).await.is_err());
    }

    #[tokio::test]
    async fn missing_command_reports_start_failure() {
        let r = check(&stdio_cmd("baton-definitely-not-a-command-xyz")).await;
        assert!(!r.ok);
        assert!(r.error.is_some());
    }

    fn stdio_cmd(command: &str) -> McpServerConfig {
        McpServerConfig {
            name: "x".into(),
            enabled: true,
            transport: McpTransport::Stdio { command: command.into(), args: vec![], env: vec![] },
        }
    }

    #[test]
    fn own_server_summaries_hide_secrets() {
        let claude = parse_claude(
            r#"{"mcpServers":{
              "fs":{"type":"stdio","command":"npx","args":["-y","@x/fs"],"env":{"TOKEN":"secret"}},
              "web":{"type":"http","url":"https://h.dev/mcp?key=secret","headers":{"Authorization":"secret"}},
              "odd":{}}}"#,
        );
        assert_eq!(claude.len(), 2);
        let fs = claude.iter().find(|s| s.name == "fs").unwrap();
        assert_eq!((fs.kind.as_str(), fs.summary.as_str()), ("stdio", "npx -y @x/fs"));
        let web = claude.iter().find(|s| s.name == "web").unwrap();
        assert_eq!(web.summary, "https://h.dev/mcp");
        assert!(parse_claude("not json").is_empty());

        let codex = parse_codex(
            "[mcp_servers.docs]\nurl = \"https://d.dev/mcp?t=1\"\n\n[mcp_servers.git]\ncommand = \"uvx\"\nargs = [\"mcp-git\"]\n[mcp_servers.git.env]\nK = \"secret\"\n",
        );
        assert_eq!(codex.len(), 2);
        assert_eq!(codex.iter().find(|s| s.name == "docs").unwrap().summary, "https://d.dev/mcp");
        assert_eq!(codex.iter().find(|s| s.name == "git").unwrap().summary, "uvx mcp-git");
        assert!(parse_codex("= broken").is_empty());
    }
}
