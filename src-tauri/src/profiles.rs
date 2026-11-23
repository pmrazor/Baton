//! Named accounts per agent. Each non-default profile gets its own home
//! folder (passed via the agent's `profileEnv`), so its login is separate.
//! The "default" profile is the user's existing login and has no folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const DEFAULT_PROFILE: &str = "default";
/// Key under which a session's profile travels in its launch values.
pub const PROFILE_KEY: &str = "profile";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub agent_id: String,
    pub name: String,
}

pub struct Profiles {
    file: PathBuf,
    root: PathBuf,
    list: Mutex<Vec<Profile>>,
}

impl Profiles {
    pub fn load(config_dir: &Path, data_dir: &Path) -> Self {
        let file = config_dir.join("profiles.json");
        let list = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { file, root: data_dir.join("profiles"), list: Mutex::new(list) }
    }

    /// Home folder for a profile; None for the default profile or a bad id.
    pub fn home(&self, agent_id: &str, profile_id: &str) -> Option<PathBuf> {
        if profile_id == DEFAULT_PROFILE || !is_safe_id(profile_id) || !is_safe_id(agent_id) {
            return None;
        }
        Some(self.root.join(agent_id).join(profile_id))
    }

    pub fn list(&self) -> Vec<Profile> {
        self.list.lock().unwrap().clone()
    }

    pub fn create(&self, agent_id: &str, name: &str) -> Result<Profile, String> {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let profile = Profile { id: format!("p{millis}"), agent_id: agent_id.into(), name: name.trim().into() };
        let mut list = self.list.lock().unwrap();
        list.push(profile.clone());
        self.save(&list)?;
        Ok(profile)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let mut list = self.list.lock().unwrap();
        let p = list.iter_mut().find(|p| p.id == id).ok_or("없는 계정이에요")?;
        p.name = name.trim().into();
        self.save(&list)
    }

    /// Forget the profile and delete its home folder (its login and history).
    pub fn delete(&self, id: &str) -> Result<Profile, String> {
        let mut list = self.list.lock().unwrap();
        let idx = list.iter().position(|p| p.id == id).ok_or("없는 계정이에요")?;
        let removed = list.remove(idx);
        self.save(&list)?;
        if let Some(home) = self.home(&removed.agent_id, &removed.id) {
            let _ = std::fs::remove_dir_all(home);
        }
        Ok(removed)
    }

    fn save(&self, list: &[Profile]) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&self.file, text).map_err(|e| e.to_string())
    }
}

/// Ids become folder names; keep them to plain identifiers.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
