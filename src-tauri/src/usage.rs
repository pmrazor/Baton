//! Plan limits read outside ACP, for agents whose adapter doesn't report them.
//!
//! Every reader returns the same shape, which the UI and the lead's
//! `list_agents` understand:
//!
//! ```json
//! { "groups": [{ "name": "Gemini Models", "description": "…",
//!     "buckets": [{ "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.75,
//!                   "reset_time": "2026-11-24T12:04:30Z" | "resets_at": 1795521870 }] }] }
//! ```

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

/// How long a usage reader may take before it is abandoned.
const TIMEOUT: Duration = Duration::from_secs(30);

/// A std `Command` for an agent program. On Windows, `npx` and friends are
/// `.cmd` shims that need `cmd /C`, and no console window may flash up.
pub fn command(program: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args).creation_flags(crate::acp::CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

/// Antigravity's `agy -p /usage --output-format json`: the groups sit in
/// `command.data`, already in the shared shape.
pub fn parse_print_report(stdout: &[u8]) -> Option<Value> {
    let report: Value = serde_json::from_slice(stdout).ok()?;
    let data = report.pointer("/command/data")?;
    data.get("groups")?.as_array()?;
    Some(data.clone())
}

/// Run `cmd` (a print-mode usage command) and read its report.
pub fn read_print(mut cmd: Command) -> Result<Value, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    parse_print_report(&out.stdout).ok_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string())
}

/// Start a Codex app-server with `cmd` and ask it for the account's limits
/// (`account/rateLimits/read`), the same call the Codex ACP adapter makes.
pub fn read_codex_app_server(mut cmd: Command) -> Result<Value, String> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // Responses arrive on a reader thread so a silent server can't hang us.
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                if tx.send(msg).is_err() {
                    break;
                }
            }
        }
    });
    let deadline = std::time::Instant::now() + TIMEOUT;
    let wait_for = |id: i64| -> Result<Value, String> {
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let msg = rx.recv_timeout(left).map_err(|_| "Codex가 응답하지 않았어요".to_string())?;
            if msg.get("id").and_then(Value::as_i64) == Some(id) && msg.get("method").is_none() {
                return match msg.get("error") {
                    Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
            }
        }
    };
    let mut send = |msg: Value| writeln!(stdin, "{msg}").map_err(|e| e.to_string());

    let result = (|| {
        send(json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "baton", "title": "Baton", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true }
            }
        }))?;
        wait_for(1)?;
        send(json!({ "method": "initialized" }))?;
        send(json!({ "id": 2, "method": "account/rateLimits/read" }))?;
        wait_for(2)
    })();
    // Closing stdin ends the server; kill it in case it lingers.
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    normalize_codex(&result?).ok_or_else(|| "한도 정보가 없어요".to_string())
}

/// `account/rateLimits/read` → the shared shape. Each limit (keyed by id) has
/// a primary and a secondary window, e.g. 5 hours and a week.
pub fn normalize_codex(result: &Value) -> Option<Value> {
    let mut snapshots: Vec<(String, Value)> = result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    if snapshots.is_empty() {
        let single = result.get("rateLimits").filter(|v| !v.is_null())?;
        snapshots.push(("codex".into(), single.clone()));
    }
    let groups: Vec<Value> = snapshots
        .iter()
        .filter_map(|(fallback, snap)| {
            let id = snap.get("limitId").and_then(Value::as_str).unwrap_or(fallback);
            let name = snap.get("limitName").and_then(Value::as_str).unwrap_or(id);
            let buckets: Vec<Value> = ["primary", "secondary"]
                .iter()
                .filter_map(|slot| {
                    let w = snap.get(*slot).filter(|w| !w.is_null())?;
                    let used = w.get("usedPercent").and_then(Value::as_f64)?;
                    let mut bucket = json!({
                        "id": format!("{id}-{slot}"),
                        "window": window_name(w.get("windowDurationMins").and_then(Value::as_u64)),
                        "remaining_fraction": (1.0 - used / 100.0).clamp(0.0, 1.0),
                    });
                    if let Some(reset) = w.get("resetsAt").and_then(Value::as_u64) {
                        bucket["resets_at"] = json!(reset);
                    }
                    Some(bucket)
                })
                .collect();
            (!buckets.is_empty()).then(|| json!({ "name": name, "buckets": buckets }))
        })
        .collect();
    if groups.is_empty() {
        return None;
    }
    let mut out = json!({ "groups": groups });
    if let Some(plan) = snapshots.iter().find_map(|(_, s)| s.get("planType").and_then(Value::as_str)) {
        out["plan"] = json!(plan);
    }
    Some(out)
}

/// "5h", "weekly", "3d"… from a window length in minutes.
fn window_name(mins: Option<u64>) -> String {
    match mins {
        Some(10080) => "weekly".into(),
        Some(m) if m >= 1440 && m % 1440 == 0 => format!("{}d", m / 1440),
        Some(m) if m >= 60 => format!("{}h", (m + 30) / 60),
        Some(m) => format!("{m}m"),
        None => "limit".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_antigravity_print_reports() {
        let report = br#"{"status":"SUCCESS","response":"Gemini Models\tWeekly...","command":{"name":"usage","data":{
            "groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.75,"reset_time":"2026-11-24T12:04:30Z"}]}]}}}"#;
        let usage = parse_print_report(report).unwrap();
        assert_eq!(usage["groups"][0]["buckets"][0]["id"], "gemini-5h");

        assert!(parse_print_report(b"Not logged in").is_none());
        assert!(parse_print_report(br#"{"status":"SUCCESS","response":"hi"}"#).is_none());
        assert!(parse_print_report(br#"{"command":{"name":"usage","data":{}}}"#).is_none());
    }

    #[test]
    fn codex_rate_limits_become_groups() {
        let result = json!({
            "rateLimits": { "limitId": "codex", "primary": { "usedPercent": 25.0, "windowDurationMins": 300, "resetsAt": 1795521870 },
                            "secondary": { "usedPercent": 60.0, "windowDurationMins": 10080, "resetsAt": null }, "planType": "plus" },
            "rateLimitsByLimitId": null
        });
        let usage = normalize_codex(&result).unwrap();
        assert_eq!(
            usage,
            json!({ "plan": "plus", "groups": [{ "name": "codex", "buckets": [
                { "id": "codex-primary", "window": "5h", "remaining_fraction": 0.75, "resets_at": 1795521870u64 },
                { "id": "codex-secondary", "window": "weekly", "remaining_fraction": 0.4 },
            ]}]})
        );
    }

    #[test]
    fn codex_limits_by_id_take_precedence() {
        let result = json!({
            "rateLimits": { "primary": { "usedPercent": 1.0, "windowDurationMins": 300 } },
            "rateLimitsByLimitId": {
                "codex": { "limitId": "codex", "limitName": "Codex", "primary": { "usedPercent": 10.0, "windowDurationMins": 300 } },
                "codex_bengalfox": { "limitName": "GPT-5 Codex Spark", "primary": { "usedPercent": 100.0, "windowDurationMins": 4320 } }
            }
        });
        let usage = normalize_codex(&result).unwrap();
        let names: Vec<&str> = usage["groups"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Codex", "GPT-5 Codex Spark"]);
        assert_eq!(usage["groups"][1]["buckets"][0]["window"], "3d");
        assert_eq!(usage["groups"][1]["buckets"][0]["remaining_fraction"], 0.0);
        assert_eq!(usage["groups"][1]["buckets"][0]["id"], "codex_bengalfox-primary");
    }

    #[test]
    fn empty_codex_reports_are_rejected() {
        assert!(normalize_codex(&json!({ "rateLimits": null })).is_none());
        assert!(normalize_codex(&json!({ "rateLimits": { "primary": null, "secondary": null } })).is_none());
    }

    #[test]
    fn window_names() {
        assert_eq!(window_name(Some(300)), "5h");
        assert_eq!(window_name(Some(10080)), "weekly");
        assert_eq!(window_name(Some(1440)), "1d");
        assert_eq!(window_name(Some(45)), "45m");
        assert_eq!(window_name(None), "limit");
    }
}
