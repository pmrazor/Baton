//! Teams: the roster an orchestrator may delegate to. Each member is one
//! agent + account + settings, with a role line the orchestrator reads when
//! choosing who gets a task. "auto" is built in; users add their own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const AUTO_TEAM: &str = "auto";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// Stable id the orchestrator passes to `delegate`.
    pub id: String,
    pub name: String,
    pub agent_id: String,
    #[serde(default = "default_profile")]
    pub profile_id: String,
    /// Launch values (e.g. dsh `permission`).
    #[serde(default)]
    pub launch: HashMap<String, String>,
    /// ACP config options applied to each new task session (e.g. `model`, `mode`).
    #[serde(default)]
    pub config: HashMap<String, Value>,
    /// What this member is good at, in plain words.
    #[serde(default)]
    pub role: String,
}

fn default_profile() -> String {
    crate::profiles::DEFAULT_PROFILE.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub members: Vec<Member>,
    /// Tasks of one lead that may run at the same time.
    #[serde(default = "default_parallel")]
    pub max_parallel: usize,
    /// How file-writing tasks share a git workspace: "worktree" (each in its
    /// own copy, merged back on request) or "shared" (one at a time in place).
    #[serde(default = "default_isolation")]
    pub isolation: String,
}

fn default_isolation() -> String {
    "worktree".into()
}

fn default_parallel() -> usize {
    3
}

/// The roster used when the user hasn't built one. The lead runs on Opus, so
/// members use the other tiers.
pub fn auto_team() -> Team {
    let member = |id: &str, name: &str, agent: &str, config: Value, role: &str| Member {
        id: id.into(),
        name: name.into(),
        agent_id: agent.into(),
        profile_id: default_profile(),
        launch: HashMap::new(),
        config: serde_json::from_value(config).unwrap_or_default(),
        role: role.into(),
    };
    Team {
        id: AUTO_TEAM.into(),
        name: "자동".into(),
        max_parallel: 3,
        isolation: default_isolation(),
        members: vec![
            member(
                "claude-fable",
                "Claude Code · Fable",
                "claude",
                json!({ "model": "fable" }),
                "Complex implementation, design changes, multi-file refactors.",
            ),
            member(
                "claude-sonnet",
                "Claude Code · Sonnet",
                "claude",
                json!({ "model": "sonnet" }),
                "General implementation, code review, documentation.",
            ),
            member(
                "claude-haiku",
                "Claude Code · Haiku",
                "claude",
                json!({ "model": "haiku" }),
                "Small edits, code search and exploration, quick checks.",
            ),
            member(
                "deepseek-flash",
                "DeepSeek · V4.1 Flash",
                "dsh",
                json!({ "model": r#"["deepseek-account","deepseek-flash"]"# }),
                "Fast, cheap work: writing tests, repetitive or bulk edits, running commands.",
            ),
            member(
                "deepseek-pro",
                "DeepSeek · V4 Pro",
                "dsh",
                json!({ "model": r#"["deepseek-account","deepseek-v4-pro"]"# }),
                "Hard reasoning on a second opinion: tricky bugs, algorithms.",
            ),
        ],
    }
}

pub struct Teams {
    file: PathBuf,
    list: Mutex<Vec<Team>>,
}

impl Teams {
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join("teams.json");
        let list = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { file, list: Mutex::new(list) }
    }

    /// Built-in auto team first, then the user's teams.
    pub fn all(&self) -> Vec<Team> {
        std::iter::once(auto_team()).chain(self.list.lock().unwrap().iter().cloned()).collect()
    }

    pub fn get(&self, id: &str) -> Team {
        self.all().into_iter().find(|t| t.id == id).unwrap_or_else(auto_team)
    }

    /// Insert or replace a user team (the auto team cannot be overwritten).
    pub fn save_team(&self, team: Team) -> Result<Team, String> {
        if team.id == AUTO_TEAM {
            return Err("자동 팀은 바꿀 수 없어요. 복제해서 새 팀으로 만들어 주세요.".into());
        }
        let mut list = self.list.lock().unwrap();
        match list.iter_mut().find(|t| t.id == team.id) {
            Some(existing) => *existing = team.clone(),
            None => list.push(team.clone()),
        }
        self.write(&list)?;
        Ok(team)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut list = self.list.lock().unwrap();
        list.retain(|t| t.id != id);
        self.write(&list)
    }

    fn write(&self, list: &[Team]) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&self.file, text).map_err(|e| e.to_string())
    }
}
