//! Read an agent's plan limits the way the app does, from the terminal.
//!
//!   cargo run --example usage_probe -- <agent-id>
//!
//! Uses no tokens: Antigravity runs `agy -p /usage`, Codex asks its app-server.

use baton_lib::agents::default_agents;
use baton_lib::usage;

fn main() {
    let agent_id = std::env::args().nth(1).unwrap_or_else(|| "antigravity".into());
    let def = default_agents().into_iter().find(|d| d.id == agent_id).expect("unknown agent id");
    let result = if !def.usage_app_server.is_empty() {
        usage::read_codex_app_server(usage::command(&def.command, &def.usage_app_server))
    } else if !def.usage_args.is_empty() {
        usage::read_print(usage::command(&def.command, &def.usage_args))
    } else {
        Err(format!("{agent_id} has no usage reader"))
    };
    match result {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
