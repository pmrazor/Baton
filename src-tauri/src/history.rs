//! Chat transcripts, one JSON file per conversation, kept inside the
//! workspace at `<workspace>/.baton/sessions/` so a project's history lives
//! (and is deleted) with the project. `.baton/` git-ignores itself.
//!
//! Older versions stored everything in `<app data>/sessions`; those files are
//! moved into their workspace the first time it is loaded. Conversations
//! whose folder no longer exists stay there and still load.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const BATON_DIR: &str = ".baton";

fn legacy_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions"))
}

fn sessions_dir(workspace: &str) -> PathBuf {
    Path::new(workspace).join(BATON_DIR).join("sessions")
}

/// Create `.baton/sessions` (and a `.gitignore` keeping it out of git).
/// Never creates the workspace itself: a deleted project stays deleted.
fn ensure_sessions_dir(workspace: &str) -> Result<PathBuf, String> {
    if !Path::new(workspace).is_dir() {
        return Err(format!("작업 폴더가 없어요: {workspace}"));
    }
    let dir = sessions_dir(workspace);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ignore = Path::new(workspace).join(BATON_DIR).join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "# Baton chat history; not part of the project.\n*\n");
    }
    Ok(dir)
}

/// Session keys are `agentId:sessionId`; keep file names portable.
fn file_name(key: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{safe}.json")
}

fn write_atomic(path: &Path, data: &Value) -> Result<(), String> {
    // Write then rename so a crash mid-write never leaves a truncated file.
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_dir_json(dir: &Path) -> Vec<(PathBuf, Value)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| match std::fs::read(&p).map(|b| serde_json::from_slice::<Value>(&b)) {
            Ok(Ok(v)) => Some((p, v)),
            // A corrupt file shouldn't hide every other conversation.
            _ => {
                eprintln!("skipping unreadable session file {}", p.display());
                None
            }
        })
        .collect()
}

/// Move app-data conversations into their workspace's `.baton`. A task chat
/// goes with its lead (its own cwd is a temporary worktree).
fn migrate_legacy(app: &AppHandle) {
    if let Ok(dir) = legacy_dir(app) {
        migrate_from(&dir);
    }
}

fn migrate_from(dir: &Path) {
    let files = read_dir_json(dir);
    let cwd_by_key: HashMap<String, String> = files
        .iter()
        .filter_map(|(_, v)| Some((v.get("key")?.as_str()?.to_string(), v.get("cwd")?.as_str()?.to_string())))
        .collect();
    for (path, value) in files {
        let workspace = value
            .pointer("/parent/key")
            .and_then(Value::as_str)
            .and_then(|lead| cwd_by_key.get(lead).cloned())
            .or_else(|| value.get("cwd").and_then(Value::as_str).map(str::to_owned));
        let (Some(workspace), Some(key)) = (workspace, value.get("key").and_then(Value::as_str)) else { continue };
        let Ok(target_dir) = ensure_sessions_dir(&workspace) else { continue };
        if write_atomic(&target_dir.join(file_name(key)), &value).is_ok() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[tauri::command]
pub fn save_session(workspace: String, key: String, data: Value) -> Result<(), String> {
    let dir = ensure_sessions_dir(&workspace)?;
    write_atomic(&dir.join(file_name(&key)), &data)
}

/// Every conversation of these workspaces, plus old ones whose folder is gone.
#[tauri::command]
pub fn load_sessions(app: AppHandle, workspaces: Vec<String>) -> Result<Vec<Value>, String> {
    migrate_legacy(&app);
    let mut out: Vec<Value> = Vec::new();
    for ws in &workspaces {
        out.extend(read_dir_json(&sessions_dir(ws)).into_iter().map(|(_, v)| v));
    }
    if let Ok(dir) = legacy_dir(&app) {
        out.extend(read_dir_json(&dir).into_iter().map(|(_, v)| v));
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_session(app: AppHandle, workspace: String, key: String) -> Result<(), String> {
    let name = file_name(&key);
    let mut paths = vec![sessions_dir(&workspace).join(&name)];
    if let Ok(dir) = legacy_dir(&app) {
        paths.push(dir.join(&name));
    }
    for path in paths {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_chats_move_into_their_workspace() {
        let root = std::env::temp_dir().join(format!("baton-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let legacy = root.join("legacy");
        let ws = root.join("project");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        let ws_s = ws.display().to_string();
        let gone = root.join("deleted-project").display().to_string();

        let lead = json!({ "key": "claude:lead", "cwd": ws_s });
        let task = json!({ "key": "dsh:task", "cwd": "/tmp/worktrees/x", "parent": { "key": "claude:lead", "taskId": "t1" } });
        let orphan = json!({ "key": "claude:old", "cwd": gone });
        for v in [&lead, &task, &orphan] {
            write_atomic(&legacy.join(file_name(v["key"].as_str().unwrap())), v).unwrap();
        }

        migrate_from(&legacy);

        let moved: Vec<String> = read_dir_json(&sessions_dir(&ws_s))
            .into_iter()
            .map(|(_, v)| v["key"].as_str().unwrap().to_string())
            .collect();
        assert!(moved.contains(&"claude:lead".to_string()));
        assert!(moved.contains(&"dsh:task".to_string()), "a task chat follows its lead");
        assert_eq!(read_dir_json(&legacy).len(), 1, "a chat whose folder is gone stays in app data");
        assert!(!Path::new(&gone).exists(), "a deleted project must not be recreated");
        assert_eq!(std::fs::read_to_string(ws.join(".baton/.gitignore")).unwrap().lines().last(), Some("*"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
