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
    /// Member id to hand a task to when this member hits its plan limit;
    /// None picks the closest available member of the team.
    #[serde(default)]
    pub fallback: Option<String>,
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
    /// Shipped with the app: can be copied, not edited. Never stored.
    #[serde(default, skip_deserializing)]
    pub builtin: bool,
}

fn default_isolation() -> String {
    "worktree".into()
}

fn default_parallel() -> usize {
    3
}

fn member(id: &str, name: &str, agent: &str, config: Value, role: &str) -> Member {
    Member {
        id: id.into(),
        name: name.into(),
        agent_id: agent.into(),
        profile_id: default_profile(),
        launch: HashMap::new(),
        config: serde_json::from_value(config).unwrap_or_default(),
        role: role.into(),
        fallback: None,
    }
}

fn builtin(id: &str, name: &str, members: Vec<Member>) -> Team {
    Team { id: id.into(), name: name.into(), members, max_parallel: 3, isolation: default_isolation(), builtin: true }
}

/// Teams shipped with the app: the mixed auto team, then one per service
/// (so a lead can keep work inside one subscription).
pub fn builtin_teams() -> Vec<Team> {
    vec![auto_team(), claude_team(), codex_team(), antigravity_team(), deepseek_team()]
}

const FABLE_ROLE: &str = "Complex implementation, design changes, multi-file refactors.";
const SONNET_ROLE: &str = "General implementation, code review, documentation.";
const HAIKU_ROLE: &str = "Small edits, code search and exploration, quick checks.";
const DEEP_ROLE: &str = "Complex implementation, refactors and debugging: thinks longer.";
const QUICK_ROLE: &str = "Small edits, code search, running commands, quick checks: answers fast.";

fn claude_team() -> Team {
    builtin(
        "preset-claude",
        "Claude",
        vec![
            member("claude-fable", "Claude Code · Fable", "claude", json!({ "model": "fable" }), FABLE_ROLE),
            member("claude-sonnet", "Claude Code · Sonnet", "claude", json!({ "model": "sonnet" }), SONNET_ROLE),
            member("claude-haiku", "Claude Code · Haiku", "claude", json!({ "model": "haiku" }), HAIKU_ROLE),
        ],
    )
}

fn codex_team() -> Team {
    builtin(
        "preset-codex",
        "Codex",
        vec![
            member("codex-deep", "Codex · 깊게", "codex", json!({ "reasoning_effort": "high" }), DEEP_ROLE),
            member("codex-quick", "Codex · 빠르게", "codex", json!({ "reasoning_effort": "low" }), QUICK_ROLE),
        ],
    )
}

/// Antigravity's models depend on the Google plan and change often, so its
/// members run on the account's default model and differ in thinking level.
fn antigravity_team() -> Team {
    builtin(
        "preset-antigravity",
        "Antigravity",
        vec![
            member("antigravity-deep", "Antigravity · 깊게", "antigravity", json!({ "thought_level": "high" }), DEEP_ROLE),
            member("antigravity-quick", "Antigravity · 빠르게", "antigravity", json!({ "thought_level": "low" }), QUICK_ROLE),
        ],
    )
}

fn deepseek_team() -> Team {
    builtin(
        "preset-deepseek",
        "DeepSeek",
        vec![
            member(
                "deepseek-pro",
                "DeepSeek · V4 Pro",
                "dsh",
                json!({ "model": r#"["deepseek-account","deepseek-v4-pro"]"# }),
                "Hard reasoning: tricky bugs, algorithms, careful implementation.",
            ),
            member(
                "deepseek-flash",
                "DeepSeek · V4.1 Flash",
                "dsh",
                json!({ "model": r#"["deepseek-account","deepseek-flash"]"# }),
                "Fast, cheap work: writing tests, repetitive or bulk edits, running commands.",
            ),
        ],
    )
}

/// The roster used when the user hasn't built one, mixing services. The lead
/// runs on Opus, so Claude members use the other tiers.
pub fn auto_team() -> Team {
    Team {
        id: AUTO_TEAM.into(),
        name: "자동".into(),
        max_parallel: 3,
        isolation: default_isolation(),
        builtin: true,
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

/// Rough capability tier, from keywords in the model id, then the member's
/// name, id and thinking level (the first that has one wins): 3 strongest,
/// 2 standard, 1 fast/cheap. Whole words only, so "deepseek" isn't "deep"
/// and "gemini" isn't "mini".
pub fn tier(member: &Member) -> u8 {
    let model = member.config.get("model").and_then(Value::as_str);
    let effort = member
        .config
        .iter()
        .filter(|(k, _)| ["effort", "thought", "reasoning"].iter().any(|w| k.contains(w)))
        .find_map(|(_, v)| v.as_str());
    let sources = [model.unwrap_or(""), member.name.as_str(), member.id.as_str(), effort.unwrap_or("")];
    for text in sources {
        let text = text.to_lowercase();
        for word in text.split(|c: char| !c.is_alphanumeric()) {
            match word {
                "opus" | "fable" | "neon" | "pro" | "deep" => return 3,
                "sonnet" | "argon" | "default" => return 2,
                "haiku" | "flash" | "hydrogen" | "quick" | "mini" | "low" => return 1,
                _ => {}
            }
        }
    }
    2
}

/// Who takes over a task from `member` when it hits its plan limit: its
/// explicit fallback if that one can run, else the team member closest in
/// tier (same, then higher, then lower; team order breaks ties). Never
/// `member` itself.
pub fn pick_fallback(
    team: &Team,
    member: &Member,
    is_limited: impl Fn(&Member) -> bool,
    installed: impl Fn(&str) -> bool,
) -> Option<Member> {
    let usable = |m: &&Member| m.id != member.id && !is_limited(m) && installed(&m.agent_id);
    let explicit = member.fallback.as_deref().and_then(|id| team.members.iter().find(|m| m.id == id));
    if let Some(m) = explicit.filter(usable) {
        return Some(m.clone());
    }
    let own = i16::from(tier(member));
    team.members
        .iter()
        .filter(usable)
        .min_by_key(|m| {
            let diff = i16::from(tier(m)) - own;
            (match diff.signum() { 0 => 0, 1 => 1, _ => 2 }, diff.abs())
        })
        .cloned()
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

    /// Built-in teams first, then the user's teams.
    pub fn all(&self) -> Vec<Team> {
        builtin_teams().into_iter().chain(self.list.lock().unwrap().iter().cloned()).collect()
    }

    pub fn get(&self, id: &str) -> Team {
        self.all().into_iter().find(|t| t.id == id).unwrap_or_else(auto_team)
    }

    /// Insert or replace a user team (the auto team cannot be overwritten).
    pub fn save_team(&self, team: Team) -> Result<Team, String> {
        if builtin_teams().iter().any(|t| t.id == team.id) {
            return Err("기본 제공 팀은 바꿀 수 없어요. 복제해서 새 팀으로 만들어 주세요.".into());
        }
        let team = Team { builtin: false, ..team };
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
    fn builtin_teams_are_valid() {
        let teams = builtin_teams();
        let ids: Vec<&str> = teams.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["auto", "preset-claude", "preset-codex", "preset-antigravity", "preset-deepseek"]);
        let agents = crate::agents::default_agents();
        for team in &teams {
            assert!(team.builtin && !team.members.is_empty(), "{}", team.id);
            for m in &team.members {
                let agent = agents.iter().find(|a| a.id == m.agent_id).unwrap_or_else(|| panic!("{}: {}", team.id, m.agent_id));
                assert!(!m.role.is_empty(), "{}", m.id);
                // Single-service presets stay inside their service.
                if team.id.starts_with("preset-") {
                    assert!(team.id.ends_with(&agent.id) || (team.id == "preset-deepseek" && agent.id == "dsh"), "{}", m.id);
                }
            }
        }
    }

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
        let mut preset = builtin_teams().remove(1);
        preset.name = "changed".into();
        assert!(teams.save_team(preset).is_err(), "presets are read-only too");

        let mut mine = auto_team();
        mine.id = "t1".into();
        mine.name = "Mine".into();
        mine.members.truncate(1);
        teams.save_team(mine.clone()).unwrap();
        mine.name = "Renamed".into();
        teams.save_team(mine).unwrap();

        let reloaded = Teams::load(&dir);
        let ids: Vec<String> = reloaded.all().into_iter().map(|t| t.id).collect();
        assert_eq!(ids.last().map(String::as_str), Some("t1"), "user teams come after the built-in ones");
        assert_eq!(ids.iter().filter(|i| *i == "t1").count(), 1, "saving twice replaces");
        assert!(!reloaded.get("t1").builtin, "a copy of a built-in team is the user's own");
        assert_eq!(reloaded.get("t1").name, "Renamed");
        assert_eq!(reloaded.get("gone").id, AUTO_TEAM, "an unknown team falls back to auto");

        reloaded.delete("t1").unwrap();
        assert_eq!(Teams::load(&dir).all().len(), builtin_teams().len());
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
        assert_eq!(team.members[0].fallback, None);
    }

    #[test]
    fn fallbacks_round_trip_as_camel_case() {
        let mut m = member("a", "A", "claude", json!({}), "r");
        m.fallback = Some("b".into());
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["fallback"], "b");
        let back: Member = serde_json::from_value(v).unwrap();
        assert_eq!(back.fallback.as_deref(), Some("b"));
    }

    #[test]
    fn tiers_come_from_model_and_name() {
        let tier_of = |name: &str, config: Value| tier(&member("x", name, "claude", config, "r"));
        assert_eq!(tier_of("Claude Code · Fable", json!({ "model": "fable" })), 3);
        assert_eq!(tier_of("x", json!({ "model": "claude-OPUS-5-5" })), 3);
        assert_eq!(tier_of("x", json!({ "model": "gemini-3-pro" })), 3);
        assert_eq!(tier_of("x", json!({ "model": "sonnet" })), 2);
        assert_eq!(tier_of("x", json!({ "model": "default" })), 2);
        assert_eq!(tier_of("Antigravity · Gemini", json!({})), 2, "no model");
        assert_eq!(tier_of("x", json!({ "model": "haiku" })), 1);
        assert_eq!(tier_of("x", json!({ "model": "gemini-3-flash" })), 1);
        assert_eq!(tier_of("x", json!({ "model": "gpt-5-mini" })), 1);
        assert_eq!(tier_of("Some · Neon", json!({})), 3, "the name counts when the model says nothing");
        assert_eq!(tier_of("Hydrogen", json!({})), 1);
        // Whole words: DeepSeek isn't "deep", Gemini isn't "mini".
        assert_eq!(tier_of("DeepSeek · V4.1 Flash", json!({ "model": r#"["deepseek-account","deepseek-flash"]"# })), 1);
        assert_eq!(tier_of("DeepSeek · V4 Pro", json!({ "model": r#"["deepseek-account","deepseek-v4-pro"]"# })), 3);
        assert_eq!(tier_of("x", json!({ "model": "gemini" })), 2);
        // Built-in thinking-level members.
        assert_eq!(tier(&codex_team().members[0]), 3);
        assert_eq!(tier(&codex_team().members[1]), 1);
    }

    fn roster() -> Team {
        builtin(
            "t",
            "T",
            vec![
                member("opus", "Opus", "claude", json!({ "model": "opus" }), "r"),
                member("sonnet", "Sonnet", "claude", json!({ "model": "sonnet" }), "r"),
                member("haiku", "Haiku", "claude", json!({ "model": "haiku" }), "r"),
                member("gemini-pro", "Gemini Pro", "antigravity", json!({ "model": "gemini-3-pro" }), "r"),
                member("ds-flash", "DeepSeek Flash", "dsh", json!({ "model": "deepseek-flash" }), "r"),
            ],
        )
    }

    fn pick(team: &Team, id: &str, limited: &[&str], missing: &[&str]) -> Option<String> {
        let m = team.members.iter().find(|m| m.id == id).unwrap();
        pick_fallback(team, m, |x| limited.contains(&x.id.as_str()), |a| !missing.contains(&a)).map(|m| m.id)
    }

    #[test]
    fn explicit_fallback_comes_first() {
        let mut team = roster();
        team.members[0].fallback = Some("ds-flash".into());
        assert_eq!(pick(&team, "opus", &["opus"], &[]).as_deref(), Some("ds-flash"));
        // A limited, uninstalled or unknown fallback gives way to the tier choice.
        assert_eq!(pick(&team, "opus", &["opus", "ds-flash"], &[]).as_deref(), Some("gemini-pro"));
        assert_eq!(pick(&team, "opus", &["opus"], &["dsh"]).as_deref(), Some("gemini-pro"));
        team.members[0].fallback = Some("gone".into());
        assert_eq!(pick(&team, "opus", &["opus"], &[]).as_deref(), Some("gemini-pro"));
        // Pointing at itself never picks itself.
        team.members[0].fallback = Some("opus".into());
        assert_eq!(pick(&team, "opus", &[], &[]).as_deref(), Some("gemini-pro"));
    }

    #[test]
    fn fallback_prefers_the_same_tier_then_higher_then_lower() {
        let team = roster();
        assert_eq!(pick(&team, "opus", &["opus"], &[]).as_deref(), Some("gemini-pro"), "same tier");
        assert_eq!(pick(&team, "opus", &["opus", "gemini-pro"], &[]).as_deref(), Some("sonnet"), "then the next lower");
        assert_eq!(pick(&team, "sonnet", &["sonnet"], &[]).as_deref(), Some("opus"), "higher before lower");
        assert_eq!(pick(&team, "haiku", &["haiku"], &[]).as_deref(), Some("ds-flash"), "same tier");
        assert_eq!(pick(&team, "haiku", &["haiku", "ds-flash"], &[]).as_deref(), Some("sonnet"), "closest higher");
        assert_eq!(pick(&team, "haiku", &["haiku"], &["dsh"]).as_deref(), Some("sonnet"), "uninstalled skipped");
        assert_eq!(pick(&team, "gemini-pro", &[], &["claude"]).as_deref(), Some("ds-flash"));
        let all = ["opus", "sonnet", "haiku", "gemini-pro", "ds-flash"];
        assert_eq!(pick(&team, "opus", &all, &[]), None);
        // Even when it isn't limited, a member is never its own fallback.
        let alone = builtin("a", "A", vec![member("solo", "Solo", "claude", json!({}), "r")]);
        assert_eq!(pick(&alone, "solo", &[], &[]), None);
    }
}
