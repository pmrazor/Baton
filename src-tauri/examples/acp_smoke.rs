//! Talk to an agent from the terminal, bypassing the UI.
//!
//!   cargo run --example acp_smoke -- <agent-id> [cwd] [prompt]
//!
//! Without a prompt it only initializes and opens a session (no tokens used).
//! Permission requests are auto-rejected.

use std::collections::HashMap;

use baton_lib::acp::{AcpConnection, Incoming, RpcError, SpawnSpec, PROTOCOL_VERSION};
use baton_lib::agents::default_agents;
use serde_json::{json, Value};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let agent_id = args.next().unwrap_or_else(|| "dsh".into());
    let cwd = args.next().unwrap_or_else(|| std::env::current_dir().unwrap().display().to_string());
    let prompt = args.next();

    let def = default_agents().into_iter().find(|d| d.id == agent_id).expect("unknown agent id");
    let env: HashMap<String, String> = def.env.clone();
    let (conn, mut incoming) = AcpConnection::spawn(SpawnSpec {
        command: &def.command,
        args: &def.args,
        env: &env,
        cwd: None,
    })
    .expect("spawn failed");

    let pump_conn = conn.clone();
    tokio::spawn(async move {
        while let Some(msg) = incoming.recv().await {
            match msg {
                Incoming::Notification { method, params } => {
                    let u = &params["update"];
                    match u["sessionUpdate"].as_str() {
                        Some("agent_message_chunk") => print!("{}", u["content"]["text"].as_str().unwrap_or("")),
                        Some(kind) => println!("\n[{method}] {kind}: {}", truncate(&u.to_string(), 160)),
                        None => println!("\n[{method}] {}", truncate(&params.to_string(), 300)),
                    }
                }
                Incoming::Request { id, method, params } => {
                    println!("\n[request] {method}: {}", truncate(&params.to_string(), 200));
                    let reply = if method == "session/request_permission" {
                        let reject = params["options"]
                            .as_array()
                            .and_then(|o| o.iter().find(|o| o["kind"] == "reject_once"))
                            .map(|o| o["optionId"].clone());
                        Ok(match reject {
                            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
                            None => json!({ "outcome": { "outcome": "cancelled" } }),
                        })
                    } else {
                        Err(RpcError::method_not_found(&method))
                    };
                    let _ = pump_conn.respond(id, reply).await;
                }
                Incoming::Response { id, result } => pump_conn.resolve(id, result).await,
                Incoming::Stderr(line) => eprintln!("  stderr| {line}"),
                Incoming::Exited(code) => {
                    pump_conn.fail_pending().await;
                    println!("\n[exited] {code:?}");
                    break;
                }
            }
        }
    });

    let init = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "auth": { "terminal": true },
                    "session": { "compaction": {} }
                },
                "clientInfo": { "name": "acp-smoke", "version": "0" }
            }),
        )
        .await
        .expect("initialize failed");
    println!("initialize → agent {} / protocol {}", init["agentInfo"], init["protocolVersion"]);
    println!("authMethods: {}", init["authMethods"]);
    println!("agentCapabilities: {}", init["agentCapabilities"]);

    // SMOKE_RESUME=<sessionId> reattaches an existing session instead of creating one.
    // SMOKE_LIST=1 lists the agent's sessions for cwd and exits.
    if std::env::var_os("SMOKE_LIST").is_some() {
        match conn.request("session/list", json!({ "cwd": cwd })).await {
            Ok(res) => {
                let sessions = res["sessions"].as_array().cloned().unwrap_or_default();
                println!("session/list → {} sessions (nextCursor: {})", sessions.len(), res["nextCursor"]);
                for s in sessions.iter().take(8) {
                    println!("  {} | {} | {}", s["sessionId"], s["updatedAt"], truncate(&s["title"].to_string(), 70));
                }
            }
            Err(e) => println!("session/list failed: {e}"),
        }
        conn.kill();
        return;
    }
    // SMOKE_DELETE=<sessionId> deletes the agent's record of a session and exits.
    if let Ok(id) = std::env::var("SMOKE_DELETE") {
        let res = conn.request("session/delete", json!({ "sessionId": id })).await;
        println!("session/delete → {}", if res.is_ok() { "ok".to_string() } else { format!("{res:?}") });
        conn.kill();
        return;
    }
    // SMOKE_LOAD=<sessionId> replays a session with session/load and exits.
    if let Ok(id) = std::env::var("SMOKE_LOAD") {
        let res = conn.request("session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] })).await;
        println!("\nsession/load → {}", if res.is_ok() { "ok" } else { "failed" });
        conn.kill();
        return;
    }

    // SMOKE_MCP=<McpServer[] json> and SMOKE_META=<_meta json> are passed through.
    let mcp: Value = std::env::var("SMOKE_MCP").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!([]));
    let (method, mut params) = match std::env::var("SMOKE_RESUME") {
        Ok(id) => ("session/resume", json!({ "sessionId": id, "cwd": cwd, "mcpServers": mcp })),
        Err(_) => ("session/new", json!({ "cwd": cwd, "mcpServers": mcp })),
    };
    if let Some(meta) = std::env::var("SMOKE_META").ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        params["_meta"] = meta;
    }
    let session = match conn.request(method, params.clone()).await {
        Ok(s) => s,
        Err(e) => {
            println!("session/new failed: {e}");
            conn.kill();
            return;
        }
    };
    let session_id = session["sessionId"]
        .as_str()
        .or(params["sessionId"].as_str())
        .unwrap()
        .to_string();
    println!("session {session_id}");
    print_options(&session);

    // SMOKE_SET="configId=value" switches a config option before prompting.
    if let Ok(set) = std::env::var("SMOKE_SET") {
        let (config_id, value) = set.split_once('=').expect("SMOKE_SET must be id=value");
        let res = conn
            .request("session/set_config_option", json!({ "sessionId": session_id, "configId": config_id, "value": value }))
            .await;
        println!("set_config_option {config_id} → {}", if res.is_ok() { "ok" } else { "failed" });
    }

    // SMOKE_REATTACH="<second prompt>": after the first prompt, close the session and
    // resume it in the same process (with SMOKE_MCP if set), then send this prompt.
    let reattach = std::env::var("SMOKE_REATTACH").ok();

    // SMOKE_WAIT=<seconds>: keep listening after session setup (for late updates).
    if let Some(secs) = std::env::var("SMOKE_WAIT").ok().and_then(|s| s.parse::<u64>().ok()) {
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        println!("\n[waited {secs}s]");
    }

    if let Some(prompt) = prompt {
        let res = conn
            .request("session/prompt", json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": prompt }] }))
            .await;
        println!("\nprompt → {}", if res.is_ok() { "ok" } else { "failed" });
        if let Some(second) = reattach {
            let closed = conn.request("session/close", json!({ "sessionId": session_id })).await;
            println!("session/close → {}", if closed.is_ok() { "ok".to_string() } else { format!("{closed:?}") });
            // SMOKE_REATTACH_MCP overrides the MCP servers for the second attach.
            let mcp2: Value = std::env::var("SMOKE_REATTACH_MCP")
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| mcp.clone());
            let mut params = json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": mcp2 });
            if let Some(meta) = std::env::var("SMOKE_META").ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                params["_meta"] = meta;
            }
            let resumed = conn.request("session/resume", params).await;
            println!("session/resume → {}", if resumed.is_ok() { "ok".to_string() } else { format!("{resumed:?}") });
            let res = conn
                .request("session/prompt", json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": second }] }))
                .await;
            println!("\nprompt 2 → {}", if res.is_ok() { "ok" } else { "failed" });
        }
    }
    conn.kill();
}

fn print_options(session: &Value) {
    if let Some(opts) = session["configOptions"].as_array() {
        for o in opts {
            println!("config option {} = {}", o["id"], o["currentValue"]);
            for choice in o["options"].as_array().into_iter().flatten() {
                println!("    - {} ({})", choice["value"], choice["name"]);
                for inner in choice["options"].as_array().into_iter().flatten() {
                    println!("        - {} ({})", inner["value"], inner["name"]);
                }
            }
        }
    }
    if !session["modes"].is_null() {
        println!("modes: current {}", session["modes"]["currentModeId"]);
    }
}

fn truncate(s: &str, n: usize) -> String {
    // SMOKE_FULL=1 prints updates untruncated.
    if std::env::var_os("SMOKE_FULL").is_some() || s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}
