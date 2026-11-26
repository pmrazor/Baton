//! Project guide (AGENTS.md / CLAUDE.md) checks done by Baton itself, no LLM:
//! does the workspace have one, and does it look stale compared with the git
//! history since it was last committed. The lead agent hears about it once.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::{git, history, worktree};

const GUIDE_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REASONS: usize = 6;
const MAX_LISTED: usize = 3;
const MANY_CHANGES: usize = 10;
const MODES: [&str; 3] = ["ask", "auto", "off"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuideStatus {
    pub exists: bool,
    pub file: Option<String>,
    pub mode: String,
    pub stale: Vec<String>,
}

/// The repository root of `folder`, or the folder itself outside git.
fn base_dir(folder: &str) -> PathBuf {
    let path = Path::new(folder);
    worktree::repo_root(path).unwrap_or_else(|| path.to_path_buf())
}

fn find_guide(root: &Path) -> Option<&'static str> {
    GUIDE_FILES.into_iter().find(|f| root.join(f).is_file())
}

fn settings_path(root: &Path) -> PathBuf {
    root.join(".baton").join("settings.json")
}

fn read_mode(root: &Path) -> String {
    std::fs::read(settings_path(root))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("guide").and_then(Value::as_str).map(str::to_string))
        .filter(|m| MODES.contains(&m.as_str()))
        .unwrap_or_else(|| "ask".to_string())
}

fn write_mode(root: &Path, mode: &str) -> Result<(), String> {
    history::baton_subdir(root, "")?;
    let path = settings_path(root);
    let mut value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    value["guide"] = json!(mode);
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn status(folder: &str) -> GuideStatus {
    let root = base_dir(folder);
    let file = find_guide(&root);
    let stale = match file {
        Some(f) => stale_reasons(&root, f),
        None => Vec::new(),
    };
    GuideStatus { exists: file.is_some(), file: file.map(str::to_string), mode: read_mode(&root), stale }
}

fn git_text(root: &Path, args: &[&str]) -> Option<String> {
    git::run_text(root, args, TIMEOUT, "git").ok()
}

/// "a, b, c, …" for a list longer than MAX_LISTED.
fn listed(items: &[String]) -> String {
    let mut out = items.iter().take(MAX_LISTED).cloned().collect::<Vec<_>>().join(", ");
    if items.len() > MAX_LISTED {
        out.push_str(", …");
    }
    out
}

/// Backticked tokens of the guide that look like repository paths.
fn path_tokens(text: &str) -> Vec<String> {
    const EXTS: [&str; 10] = [".rs", ".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".toml", ".yml"];
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for token in text.split('`').skip(1).step_by(2) {
        let token = token.trim();
        let plain = !token.is_empty()
            && token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '@'));
        let bad_start = token.starts_with(['-', '~', '/']);
        let looks_like_path = token.contains('/') || EXTS.iter().any(|e| token.ends_with(e)) || token.ends_with(".yaml");
        if plain && !bad_start && looks_like_path && !token.contains("://") && seen.insert(token.to_string()) {
            out.push(token.to_string());
        }
    }
    out
}

/// Paths the guide names that were in the repo when the guide was last
/// updated (`base`) and are gone now. Names that were never repo files (config
/// files elsewhere, data shapes like `groups/buckets`) and paths written
/// relative to a section (`components/` meaning `src/components/`) don't count.
fn missing_paths(root: &Path, guide: &str, base: &str) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join(guide)) else { return Vec::new() };
    let listing = |args: &[&str]| -> Vec<String> {
        git_text(root, args).unwrap_or_default().lines().map(str::to_string).collect()
    };
    let then = listing(&["ls-tree", "-r", "--name-only", base]);
    // An empty listing means git failed (or an empty repo): no signal.
    if then.is_empty() {
        return Vec::new();
    }
    let mut now: Option<Vec<String>> = None;
    let mut missing = Vec::new();
    for token in path_tokens(&text) {
        let t = token.trim_end_matches('/');
        // `hub/` is a folder path even though no `/` is left after trimming.
        let as_path = token.contains('/');
        if t.is_empty() || !names_tracked_path(&then, t, as_path) {
            continue;
        }
        let now = now.get_or_insert_with(|| listing(&["ls-files"]));
        if !root.join(t).exists() && !names_tracked_path(now, t, as_path) {
            missing.push(token);
        }
    }
    missing
}

/// Whether `t` names one of `paths`: a bare file name matches by basename; a
/// path matches the file or folder itself, also nested under another folder.
fn names_tracked_path(paths: &[String], t: &str, as_path: bool) -> bool {
    if !as_path {
        return paths.iter().any(|p| p.rsplit('/').next() == Some(t));
    }
    let nested = format!("/{t}");
    paths.iter().any(|p| {
        p == t
            || p.starts_with(&format!("{t}/"))
            || p.ends_with(&nested)
            || p.contains(&format!("{nested}/"))
    })
}

/// (status letter, paths) per line of `git diff --name-status`.
fn parse_name_status(text: &str) -> Vec<(char, Vec<String>)> {
    text.lines()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let letter = parts.next()?.chars().next()?;
            let paths: Vec<String> = parts.map(str::to_string).collect();
            (!paths.is_empty()).then_some((letter, paths))
        })
        .collect()
}

fn scripts_of(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().map(|v| v.get("scripts").cloned().unwrap_or(Value::Null))
}

fn stale_reasons(root: &Path, guide: &str) -> Vec<String> {
    // Only a committed guide has a point in time to compare against.
    if git_text(root, &["ls-files", "--", guide]).is_none_or(|t| t.is_empty()) {
        return Vec::new();
    }
    let Some(base) = git_text(root, &["log", "-1", "--format=%H", "--", guide]).filter(|b| !b.is_empty()) else {
        return Vec::new();
    };
    let mut reasons = Vec::new();

    let missing = missing_paths(root, guide, &base);
    if !missing.is_empty() {
        reasons.push(format!("missing: {}", listed(&missing)));
    }

    let changes = git_text(root, &["diff", "--name-status", "-M", &base, "HEAD"]).map(|t| parse_name_status(&t));
    if let Some(changes) = &changes {
        let old_dirs: BTreeSet<String> = git_text(root, &["ls-tree", "-d", "--name-only", &base])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        let new_dirs: BTreeSet<String> = changes
            .iter()
            .filter(|(l, _)| *l == 'A')
            .filter_map(|(_, p)| p[0].split_once('/').map(|(top, _)| top.to_string()))
            .filter(|top| !old_dirs.contains(top))
            .collect();
        if !new_dirs.is_empty() {
            let list: Vec<String> = new_dirs.into_iter().map(|d| format!("{d}/")).collect();
            reasons.push(format!("new folder: {}", listed(&list)));
        }
    }

    let old_scripts = git_text(root, &["show", &format!("{base}:package.json")]).and_then(|t| scripts_of(&t));
    let new_scripts = git_text(root, &["show", "HEAD:package.json"]).and_then(|t| scripts_of(&t));
    if let (Some(old), Some(new)) = (old_scripts, new_scripts) {
        if old != new {
            reasons.push("commands changed: package.json scripts".to_string());
        }
    }

    if let Some(changes) = &changes {
        if changes.iter().any(|(_, ps)| ps.iter().any(|p| p.starts_with(".github/workflows/"))) {
            reasons.push("CI workflows changed".to_string());
        }
        let moved = changes.iter().filter(|(l, _)| matches!(l, 'A' | 'D' | 'R')).count();
        if moved >= MANY_CHANGES {
            reasons.push(format!("{moved} files added/removed/moved since the guide was updated"));
        }
    }

    reasons.truncate(MAX_REASONS);
    reasons
}

/// The paragraph the lead hears once per session, if any.
pub fn guide_note(status: &GuideStatus) -> Option<String> {
    if !status.exists {
        return (status.mode == "auto").then(|| {
            "This workspace has no project guide (AGENTS.md / CLAUDE.md). Alongside the user's request, delegate one \
small task to the cheapest member: write AGENTS.md (directory map with one line per key file, how requests flow, \
build/test commands, conventions — every line verified against the code, ~100–200 lines) plus CLAUDE.md and \
GEMINI.md that contain just `@AGENTS.md`. Merge it like any task."
                .to_string()
        });
    }
    if status.mode == "off" || status.stale.is_empty() {
        return None;
    }
    let file = status.file.as_deref().unwrap_or("AGENTS.md");
    Some(format!(
        "The project guide {file} may be out of date: {}. In a task you delegate anyway (or a small one for the \
cheapest member), include fixing exactly these points in {file}; don't rewrite the rest.",
        status.stale.join("; ")
    ))
}

#[tauri::command]
pub async fn guide_status(folder: String) -> Result<GuideStatus, String> {
    tokio::task::spawn_blocking(move || status(&folder)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_guide_mode(folder: String, mode: String) -> Result<(), String> {
    if !MODES.contains(&mode.as_str()) {
        return Err("프로젝트 가이드 설정은 ask, auto, off 중 하나여야 해요.".to_string());
    }
    tokio::task::spawn_blocking(move || write_mode(&base_dir(&folder), &mode))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn commit(dir: &Path, msg: &str) {
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-qm", msg]);
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-guide-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        for (k, v) in
            [("core.autocrlf", "false"), ("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")]
        {
            sh(&dir, &["config", k, v]);
        }
        write(&dir, ".gitignore", ".baton/\n");
        write(&dir, "src/hub.rs", "fn main() {}\n");
        write(&dir, "package.json", "{\"scripts\":{\"test\":\"vitest\"}}");
        write(&dir, "AGENTS.md", "Map: `src/hub.rs`, `hub.rs`, `package.json`.\n");
        commit(&dir, "init");
        dir
    }

    fn stale(dir: &Path) -> Vec<String> {
        status(dir.to_str().unwrap()).stale
    }

    #[test]
    fn finds_guide_file_preferring_agents_md() {
        let dir = std::env::temp_dir().join(format!("baton-guide-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(dir.to_str().unwrap());
        assert!(!s.exists && s.file.is_none() && s.stale.is_empty());
        write(&dir, "CLAUDE.md", "x");
        assert_eq!(status(dir.to_str().unwrap()).file.as_deref(), Some("CLAUDE.md"));
        write(&dir, "AGENTS.md", "x");
        assert_eq!(status(dir.to_str().unwrap()).file.as_deref(), Some("AGENTS.md"));
    }

    #[test]
    fn mode_defaults_to_ask_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("baton-guide-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_mode(&dir), "ask");
        write_mode(&dir, "auto").unwrap();
        assert_eq!(read_mode(&dir), "auto");
        write(&dir, ".baton/settings.json", "{\"guide\":\"bogus\"}");
        assert_eq!(read_mode(&dir), "ask");
        let json = serde_json::to_value(status(dir.to_str().unwrap())).unwrap();
        assert_eq!(json["mode"], "ask");
        assert!(json.get("exists").is_some() && json.get("file").is_some() && json.get("stale").is_some());
    }

    #[test]
    fn fresh_guide_is_not_stale() {
        let dir = repo("fresh");
        let s = status(dir.to_str().unwrap());
        assert!(s.exists && s.stale.is_empty(), "{:?}", s.stale);
    }

    #[test]
    fn detects_missing_paths() {
        let dir = repo("missing");
        // Names that were never repo files, and section-relative folders, are not "missing".
        write(
            &dir,
            "AGENTS.md",
            "`src/hub.rs` `hub.rs` `hub/` `agents.json` `groups/buckets` `a b.rs` `src/*.rs` `-x.rs`\n",
        );
        write(&dir, "src/hub/mod.rs", "x");
        commit(&dir, "guide");
        assert!(stale(&dir).is_empty(), "{:?}", stale(&dir));

        // Files the guide named that later disappear are.
        std::fs::remove_file(dir.join("src/hub.rs")).unwrap();
        std::fs::remove_dir_all(dir.join("src/hub")).unwrap();
        commit(&dir, "remove hub");
        assert_eq!(stale(&dir), vec!["missing: src/hub.rs, hub.rs, hub/"]);
    }

    #[test]
    fn detects_new_folders_scripts_and_workflows() {
        let dir = repo("signals");
        write(&dir, "extensions/a.ts", "x");
        write(&dir, "src/more.rs", "x");
        write(&dir, "package.json", "{\"scripts\":{\"test\":\"jest\"}}");
        write(&dir, ".github/workflows/ci.yml", "x");
        commit(&dir, "change");
        let s = stale(&dir);
        assert!(s.contains(&"new folder: .github/, extensions/".to_string()), "{s:?}");
        assert!(s.contains(&"commands changed: package.json scripts".to_string()), "{s:?}");
        assert!(s.contains(&"CI workflows changed".to_string()), "{s:?}");
    }

    #[test]
    fn counts_many_added_files() {
        let dir = repo("many");
        for i in 0..10 {
            write(&dir, &format!("src/f{i}.rs"), "x");
        }
        commit(&dir, "many");
        assert_eq!(stale(&dir), vec!["10 files added/removed/moved since the guide was updated"]);
    }

    #[test]
    fn uncommitted_guide_is_never_stale() {
        let dir = repo("uncommitted");
        sh(&dir, &["rm", "-q", "-f", "AGENTS.md"]);
        sh(&dir, &["commit", "-qm", "drop guide"]);
        write(&dir, "AGENTS.md", "`src/gone.rs`\n");
        let s = status(dir.to_str().unwrap());
        assert!(s.exists && s.stale.is_empty());
    }

    fn st(exists: bool, mode: &str, stale: &[&str]) -> GuideStatus {
        GuideStatus {
            exists,
            file: exists.then(|| "AGENTS.md".to_string()),
            mode: mode.into(),
            stale: stale.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn note_selection() {
        assert!(guide_note(&st(false, "auto", &[])).unwrap().contains("has no project guide"));
        assert_eq!(guide_note(&st(false, "ask", &[])), None);
        assert_eq!(guide_note(&st(false, "off", &[])), None);
        assert_eq!(guide_note(&st(true, "ask", &[])), None);
        assert_eq!(guide_note(&st(true, "off", &["CI workflows changed"])), None);
        let note = guide_note(&st(true, "ask", &["missing: a.rs", "CI workflows changed"])).unwrap();
        assert!(note.contains("AGENTS.md may be out of date: missing: a.rs; CI workflows changed."), "{note}");
    }
}
