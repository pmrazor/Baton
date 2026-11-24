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
            // Antigravity offers whatever models the Google account has, so
            // this member runs on the account's default model.
            member(
                "antigravity-gemini",
                "Antigravity · Gemini",
                "antigravity",
                json!({}),
                "Google Gemini: a different model family for a second opinion or review; reading a lot of code at once (very large context).",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_team_is_valid() {
        let team = auto_team();
        let mut ids: Vec<&str> = team.members.iter().map(|m| m.id.as_str()).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count, "member ids must be unique");
        assert!(team.members.iter().all(|m| !m.role.is_empty()));
        let known: Vec<String> = crate::agents::default_agents().into_iter().map(|a| a.id).collect();
        assert!(team.members.iter().all(|m| known.contains(&m.agent_id)), "every member uses a built-in agent");
        assert_eq!(team.isolation, "worktree");
    }

    #[test]
    fn user_teams_persist_and_the_auto_team_is_protected() {
        let dir = std::env::temp_dir().join(format!("baton-teams-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let teams = Teams::load(&dir);
        assert!(teams.save_team(auto_team()).is_err());

        let mut mine = auto_team();
        mine.id = "t1".into();
        mine.name = "Mine".into();
        mine.members.truncate(1);
        teams.save_team(mine.clone()).unwrap();
        mine.name = "Renamed".into();
        teams.save_team(mine).unwrap();

        let reloaded = Teams::load(&dir);
        let ids: Vec<String> = reloaded.all().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["auto", "t1"], "auto first, and saving twice replaces");
        assert_eq!(reloaded.get("t1").name, "Renamed");
        assert_eq!(reloaded.get("gone").id, AUTO_TEAM, "an unknown team falls back to auto");

        reloaded.delete("t1").unwrap();
        assert_eq!(Teams::load(&dir).all().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn older_team_files_get_defaults() {
        let team: Team = serde_json::from_value(json!({
            "id": "old", "name": "Old",
            "members": [{ "id": "m", "name": "M", "agentId": "claude" }]
        }))
        .unwrap();
        assert_eq!(team.max_parallel, 3);
        assert_eq!(team.isolation, "worktree");
        assert_eq!(team.members[0].profile_id, "default");
    }
}
