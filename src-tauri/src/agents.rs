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
    /// Arguments (replacing `args`) that print the account's plan limits as
    /// JSON without using any tokens. Empty = the agent can't report them.
    #[serde(default)]
    pub usage_args: Vec<String>,
    /// Arguments (replacing `args`) that start a Codex app-server, which Baton
    /// asks for the account's plan limits (`account/rateLimits/read`).
    #[serde(default)]
    pub usage_app_server: Vec<String>,
    /// How to get the agent onto this computer, shown when it isn't.
    #[serde(default)]
    pub install: Option<Install>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    /// Shell line run in a terminal on macOS and Linux.
    #[serde(default)]
    pub unix: Option<String>,
    /// Command line run in a terminal (cmd.exe) on Windows.
    #[serde(default)]
    pub windows: Option<String>,
    /// Programs that must exist first, e.g. "npm".
    #[serde(default)]
    pub requires: Vec<String>,
    /// Official install page.
    pub url: String,
    #[serde(default)]
    pub note: String,
}

impl Install {
    /// The command for this platform, if it can be installed from a terminal.
    pub fn command(&self) -> Option<&str> {
        if cfg!(windows) { self.windows.as_deref() } else { self.unix.as_deref() }
    }
}

const NODE_URL: &str = "https://nodejs.org/en/download";

/// Agents started through `npx`: nothing to install but Node.js.
fn via_npx(note: &str) -> Option<Install> {
    Some(Install { unix: None, windows: None, requires: vec!["npx".into()], url: NODE_URL.into(), note: note.into() })
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
            usage_args: Vec::new(),
            usage_app_server: Vec::new(),
            install: via_npx("Node.js만 있으면 돼요. Claude Code 어댑터는 처음 실행할 때 자동으로 받아요."),
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
            usage_args: Vec::new(),
            usage_app_server: Vec::new(),
            install: Some(Install {
                unix: Some("npm install -g @deepseek-ai/dsh".into()),
                windows: Some("npm install -g @deepseek-ai/dsh".into()),
                requires: vec!["npm".into()],
                url: "https://www.npmjs.com/package/@deepseek-ai/dsh".into(),
                note: String::new(),
            }),
        },
        AgentDef {
            id: "antigravity".into(),
            name: "Antigravity".into(),
            description: "Google Antigravity CLI (agy) and its built-in ACP server".into(),
            command: "agy".into(),
            // Each session in its own worker: required for the HTTP MCP server
            // a lead gets, and keeps one session's hang from blocking others.
            args: vec!["acp".into(), "--process-per-session".into()],
            env: HashMap::new(),
            login_hint: "상단 배너의 로그인 버튼으로 Google 계정에 로그인하세요.".into(),
            // The account decides which models exist; start on its default.
            default_config: HashMap::new(),
            // agy expects the project folder as its working directory.
            process_per_workspace: true,
            launch_options: Vec::new(),
            // The login lives in the OS keychain, shared by every agy process.
            profile_env: None,
            login_args: vec!["acp".into(), "--login".into()],
            login_note: "터미널에 나온 주소를 브라우저에서 열어 Google 계정으로 로그인하고, 받은 코드를 터미널에 붙여 넣으세요.".into(),
            lead_config: HashMap::new(),
            usage_args: ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"].map(String::from).to_vec(),
            usage_app_server: Vec::new(),
            install: Some(Install {
                unix: Some("curl -fsSL https://antigravity.google/cli/install.sh | bash".into()),
                // The official CMD installer, run from %TEMP%. No quotes: the
                // line passes through `cmd /C start … cmd /K`, and `cd` takes
                // a path with spaces as is.
                windows: Some(
                    "cd /d %TEMP% && curl -fsSL https://antigravity.google/cli/install.cmd -o agy-install.cmd && agy-install.cmd && del agy-install.cmd".into(),
                ),
                requires: Vec::new(),
                url: "https://antigravity.google/docs/getting-started?tab=cli".into(),
                note: "Google 공식 설치 스크립트예요.".into(),
            }),
        },
        AgentDef {
            id: "codex".into(),
            name: "Codex".into(),
            description: "OpenAI Codex via the official ACP adapter".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/codex-acp@2.6.0".into()],
            env: HashMap::new(),
            login_hint: "로그인 버튼을 누르면 터미널에서 ChatGPT 계정 로그인이 열려요.".into(),
            default_config: HashMap::new(),
            process_per_workspace: false,
            launch_options: Vec::new(),
            // Codex keeps config and auth.json in CODEX_HOME (default ~/.codex).
            profile_env: Some("CODEX_HOME".into()),
            // The adapter has no login of its own; the Codex CLI's login writes
            // the auth.json it reads. 0.166 is the version this adapter bundles.
            login_args: vec!["-y".into(), "@openai/codex@0.166.0".into(), "login".into()],
            login_note: "브라우저에서 ChatGPT 계정으로 로그인하면 끝나요.".into(),
            lead_config: HashMap::new(),
            usage_args: Vec::new(),
            // The adapter keeps Codex's limits to itself; ask the same Codex version directly.
            usage_app_server: vec!["-y".into(), "@openai/codex@0.166.0".into(), "app-server".into()],
            install: via_npx("Node.js만 있으면 돼요. Codex 어댑터는 처음 실행할 때 자동으로 받아요."),
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
            if upgrade_builtins(&mut agents) | add_missing_builtins(&mut agents) {
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
        if agent.install.is_none() && builtin.install.is_some() {
            agent.install = builtin.install.clone();
            changed = true;
        }
        if agent.usage_app_server.is_empty() && !builtin.usage_app_server.is_empty() {
            agent.usage_app_server = builtin.usage_app_server.clone();
            changed = true;
        }
        if agent.usage_args.is_empty() && !builtin.usage_args.is_empty() {
            agent.usage_args = builtin.usage_args.clone();
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

/// Append built-in agents added in a later version (e.g. Antigravity) to an
/// existing agents.json. Returns whether anything was added.
fn add_missing_builtins(agents: &mut Vec<AgentDef>) -> bool {
    let missing: Vec<AgentDef> =
        default_agents().into_iter().filter(|d| !agents.iter().any(|a| a.id == d.id)).collect();
    let added = !missing.is_empty();
    agents.extend(missing);
    added
}

/// Whether `command` can be started: an existing path, or a program on PATH.
pub fn command_exists(command: &str) -> bool {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file();
    }
    let Some(dirs) = crate::shell_env::path() else { return false };
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|e| e.to_ascii_lowercase())
        .collect();
    std::env::split_paths(&dirs).any(|dir| {
        let candidate = dir.join(command);
        #[cfg(windows)]
        {
            exts.iter().any(|ext| dir.join(format!("{command}{ext}")).is_file()) || candidate.is_file()
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            candidate.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dsh() -> AgentDef {
        default_agents().into_iter().find(|a| a.id == "dsh").unwrap()
    }

    #[test]
    fn unknown_launch_values_fall_back_to_defaults() {
        let def = dsh();
        let resolved = def.resolve_launch(&HashMap::new());
        assert_eq!(resolved, vec![("permission".into(), "DSH_PERMISSION_MODE".into(), "workspace-write".into())]);

        let bogus = HashMap::from([("permission".to_string(), "root".to_string())]);
        assert_eq!(def.resolve_launch(&bogus)[0].2, "workspace-write");

        let chosen = HashMap::from([("permission".to_string(), "read-only".to_string())]);
        assert_eq!(def.resolve_launch(&chosen)[0].2, "read-only");
    }

    #[test]
    fn old_configs_gain_new_builtin_fields_only() {
        let mut old = dsh();
        old.launch_options.clear();
        old.lead_config.clear();
        old.profile_env = None;
        old.login_args.clear();
        let mut custom = dsh();
        custom.id = "my-agent".into();
        custom.launch_options.clear();

        let mut agents = vec![old, custom];
        assert!(upgrade_builtins(&mut agents));
        assert_eq!(agents[0].launch_options.len(), 1);
        assert_eq!(agents[0].profile_env.as_deref(), Some("DSH_HOME"));
        assert_eq!(agents[0].login_args, vec!["web".to_string()]);
        assert!(!agents[0].lead_config.is_empty());
        assert!(agents[1].launch_options.is_empty(), "user-defined agents are left alone");
        assert!(!upgrade_builtins(&mut agents), "a second pass changes nothing");
    }

    #[test]
    fn new_builtins_join_an_existing_agents_json() {
        let dir = std::env::temp_dir().join(format!("baton-agents-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // agents.json written by a version that only knew Claude and dsh, plus a user's own agent.
        let mut old: Vec<AgentDef> =
            default_agents().into_iter().filter(|a| a.id == "claude" || a.id == "dsh").collect();
        let mut mine = dsh();
        mine.id = "mine".into();
        old.push(mine);
        std::fs::write(config_path(&dir), serde_json::to_string(&old).unwrap()).unwrap();

        let ids: Vec<String> = load_or_init(&dir).unwrap().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["claude", "dsh", "mine", "antigravity", "codex"]);
        let saved: Vec<AgentDef> = serde_json::from_str(&std::fs::read_to_string(config_path(&dir)).unwrap()).unwrap();
        assert_eq!(saved.len(), 5, "the additions are written back");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_builtin_says_how_to_install_it() {
        for agent in default_agents() {
            let install = agent.install.unwrap_or_else(|| panic!("{} has no install info", agent.id));
            assert!(install.url.starts_with("https://"), "{}", agent.id);
            assert!(install.command().is_some() || !install.requires.is_empty(), "{}: nothing to do", agent.id);
        }
    }

    #[test]
    fn finds_commands_on_path() {
        #[cfg(unix)]
        assert!(command_exists("sh"));
        #[cfg(windows)]
        assert!(command_exists("cmd"));
        assert!(!command_exists("baton-no-such-command-xyz"));
        assert!(!command_exists("/no/such/dir/agy"));
    }

    #[test]
    fn agents_json_is_created_then_reloaded() {
        let dir = std::env::temp_dir().join(format!("baton-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_init(&dir).unwrap();
        assert!(config_path(&dir).exists());
        let second = load_or_init(&dir).unwrap();
        let ids = |a: &[AgentDef]| a.iter().map(|d| d.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&first), ids(&second));
        assert_eq!(ids(&first), ["claude", "dsh", "antigravity", "codex"]);

        std::fs::write(config_path(&dir), "not json").unwrap();
        assert!(load_or_init(&dir).is_err(), "a broken file is reported, not overwritten");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
