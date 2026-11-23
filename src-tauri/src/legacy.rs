//! The app was called "Agent Hub" (bundle id `app.agenthub.desktop`) before
//! it became Baton. Copy its agent config and chat history over on first run
//! so nothing is lost; the old folders are left untouched.

use std::path::Path;

use tauri::{AppHandle, Manager};

const LEGACY_IDENTIFIER: &str = "app.agenthub.desktop";

pub fn migrate(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        copy_if_missing(&dir, "agents.json");
    }
    if let Ok(dir) = app.path().app_data_dir() {
        copy_if_missing(&dir, "sessions");
    }
}

/// Copy `<legacy dir>/<name>` to `<new dir>/<name>` unless the target exists.
fn copy_if_missing(new_dir: &Path, name: &str) {
    let target = new_dir.join(name);
    if target.exists() {
        return;
    }
    let Some(source) = new_dir.parent().map(|p| p.join(LEGACY_IDENTIFIER).join(name)) else { return };
    if !source.exists() {
        return;
    }
    if let Err(e) = copy_recursive(&source, &target) {
        eprintln!("이전 데이터 복사 실패 {}: {e}", source.display());
    }
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}
