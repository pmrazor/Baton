//! Agent definitions: which ACP agents exist and how to launch them.
//!
//! Stored as `agents.json` in the app config directory so users can add or
//! tweak agents without rebuilding. Missing file → defaults are written.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Shown when the agent reports it needs a login.
    #[serde(default)]
    pub login_hint: String,
    /// ACP session config options applied right after `session/new`,
    /// e.g. `{ "model": "..." }`. Values the agent rejects are ignored.
    #[serde(default)]
    pub default_config: HashMap<String, Value>,
    /// Run one process per workspace with the workspace as its cwd. Needed by
    /// agents that scope their sandbox to the process cwd (dsh).
    #[serde(default)]
    pub process_per_workspace: bool,
    /// Choices fixed when the process starts (passed as env vars), e.g. dsh's
    /// permission mode. A session keeps the values it was created with.
    #[serde(default)]
    pub launch_options: Vec<LaunchOption>,
    /// Env var pointing the agent at a per-account home folder, which is how
    /// one agent gets several logged-in accounts. None = single account only.
    #[serde(default)]
    pub profile_env: Option<String>,
    /// Arguments (replacing `args`) that run the agent's interactive login.
    #[serde(default)]
    pub login_args: Vec<String>,
    /// Shown next to the login button, e.g. how to finish the login.
    #[serde(default)]
    pub login_note: String,
    /// Config options for a lead (agent mode) session, on top of `defaultConfig`.
    #[serde(default)]
    pub lead_config: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOption {
    pub id: String,
    pub name: String,
    /// UI hint, same vocabulary as ACP config categories (e.g. "mode").
    #[serde(default)]
    pub category: Option<String>,
    pub env: String,
    pub default: String,
    pub choices: Vec<LaunchChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchChoice {
    pub value: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

impl AgentDef {
    /// Resolve requested launch values against the definition: unknown or
    /// missing values fall back to the option's default.
    pub fn resolve_launch(&self, requested: &HashMap<String, String>) -> Vec<(String, String, String)> {
        self.launch_options
            .iter()
            .map(|opt| {
                let value = requested
                    .get(&opt.id)
                    .filter(|v| opt.choices.iter().any(|c| &c.value == *v))
                    .cloned()
                    .unwrap_or_else(|| opt.default.clone());
                (opt.id.clone(), opt.env.clone(), value)
            })
            .collect()
    }
}

pub fn default_agents() -> Vec<AgentDef> {
    vec![
        AgentDef {
            id: "claude".into(),
            name: "Claude Code".into(),
            description: "Anthropic Claude Code via the official ACP adapter".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/claude-agent-acp@0.102.0".into()],
            env: HashMap::new(),
            login_hint: "상단 배너의 로그인 버튼으로 Claude 계정에 로그인하세요.".into(),
            default_config: HashMap::new(),
            process_per_workspace: false,
            launch_options: Vec::new(),
            profile_env: Some("CLAUDE_CONFIG_DIR".into()),
            login_args: vec![
                "-y".into(),
                "@agentclientprotocol/claude-agent-acp@0.102.0".into(),
                "--cli".into(),
                "auth".into(),
                "login".into(),
                "--claudeai".into(),
            ],
            login_note: "브라우저에서 Claude 계정으로 로그인하면 끝나요.".into(),
            // `opus` is Claude Code's alias for the newest Opus, so it follows upgrades.
            lead_config: HashMap::from([("model".into(), json!("opus"))]),
        },
        AgentDef {
            id: "dsh".into(),
            name: "DeepSeek (dsh)".into(),
            description: "DeepSeek Harness ACP profile".into(),
            command: "dsh".into(),
            args: vec!["--profile".into(), "acp".into()],
            env: HashMap::new(),
            login_hint: "터미널에서 `dsh tui`를 실행해 로그인하세요.".into(),
            // The shipped route needs DEEPSEEK_API_KEY; the account route uses the dsh login.
            default_config: HashMap::from([("model".into(), json!(r#"["deepseek-account","deepseek-flash"]"#))]),
            // dsh's permission preset comes from DSH_PERMISSION_MODE at startup
            // and is pinned per session; ACP cannot switch it.
            process_per_workspace: false,
            launch_options: vec![LaunchOption {
                id: "permission".into(),
                name: "권한".into(),
                category: Some("mode".into()),
                env: "DSH_PERMISSION_MODE".into(),
                default: "workspace-write".into(),
                choices: vec![
                    LaunchChoice {
                        value: "read-only".into(),
                        name: "읽기 전용".into(),
                        description: "파일을 수정하지 않아요. 그 이상은 승인을 요청해요".into(),
                    },
                    LaunchChoice {
                        value: "workspace-write".into(),
                        name: "워크스페이스 쓰기".into(),
                        description: "워크스페이스 안에서만 수정해요. 그 밖은 승인을 요청해요".into(),
                    },
                    LaunchChoice {
                        value: "danger-full-access".into(),
                        name: "전체 권한".into(),
                        description: "승인 없이 모든 작업을 실행해요".into(),
                    },
                ],
            }],
            // dsh signs in through its web UI; DSH_HOME holds that account.
            profile_env: Some("DSH_HOME".into()),
            login_args: vec!["web".into()],
            login_note: "열린 dsh 웹 화면에서 DeepSeek 계정으로 로그인한 뒤, 터미널에서 Ctrl+C로 종료하세요.".into(),
            lead_config: HashMap::from([("model".into(), json!(r#"["deepseek-account","deepseek-v4-pro"]"#))]),
        },
    ]
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("agents.json")
}

pub fn load_or_init(config_dir: &Path) -> Result<Vec<AgentDef>, String> {
    let path = config_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let mut agents: Vec<AgentDef> =
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            if upgrade_builtins(&mut agents) {
                // Best effort: the in-memory upgrade applies either way.
                let _ = serde_json::to_string_pretty(&agents).map(|t| std::fs::write(&path, t));
            }
            Ok(agents)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let agents = default_agents();
            std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
            let text = serde_json::to_string_pretty(&agents).map_err(|e| e.to_string())?;
            std::fs::write(&path, text).map_err(|e| e.to_string())?;
            Ok(agents)
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Fill fields added after a user's agents.json was written, for the
/// built-in agents only. Returns whether anything changed.
fn upgrade_builtins(agents: &mut [AgentDef]) -> bool {
    let defaults = default_agents();
    let mut changed = false;
    for agent in agents.iter_mut() {
        let Some(builtin) = defaults.iter().find(|d| d.id == agent.id) else { continue };
        if agent.launch_options.is_empty() && !builtin.launch_options.is_empty() {
            agent.launch_options = builtin.launch_options.clone();
            changed = true;
        }
        if agent.lead_config.is_empty() && !builtin.lead_config.is_empty() {
            agent.lead_config = builtin.lead_config.clone();
            changed = true;
        }
        if agent.profile_env.is_none() && builtin.profile_env.is_some() {
            agent.profile_env = builtin.profile_env.clone();
            agent.login_args = builtin.login_args.clone();
            agent.login_note = builtin.login_note.clone();
            changed = true;
        }
    }
    changed
}
