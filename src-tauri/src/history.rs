//! Chat transcripts persisted as one JSON file per session under
//! `<app data dir>/sessions`. The UI owns the shape; we only store it.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions"))
}

/// Session keys are `agentId:sessionId`; keep file names portable.
fn file_name(key: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{safe}.json")
}

#[tauri::command]
pub fn save_session(app: AppHandle, key: String, data: Value) -> Result<(), String> {
    let dir = sessions_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name(&key));
    // Write then rename so a crash mid-write never leaves a truncated file.
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_sessions(app: AppHandle) -> Result<Vec<Value>, String> {
    let dir = sessions_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A corrupt file shouldn't hide every other conversation.
        match std::fs::read(&path).map(|b| serde_json::from_slice::<Value>(&b)) {
            Ok(Ok(v)) => out.push(v),
            _ => eprintln!("skipping unreadable session file {}", path.display()),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_session(app: AppHandle, key: String) -> Result<(), String> {
    match std::fs::remove_file(sessions_dir(&app)?.join(file_name(&key))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}
