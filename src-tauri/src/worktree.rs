//! Isolated folders for file-writing tasks (git worktrees).
//!
//! A task's worktree starts from a snapshot of the workspace *including*
//! uncommitted and untracked (non-ignored) changes, so the member sees what
//! the user sees. Snapshots use a throwaway index, and merging writes files
//! with a per-file three-way merge, so the user's index and branches are
//! never touched.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Ignored dependency/build folders linked into a worktree instead of being
/// reinstalled or rebuilt from scratch.
const LINKED_DIRS: &[&str] = &["node_modules", "target", ".venv", "venv"];

#[derive(Debug, Clone)]
pub struct Sandbox {
    /// Repository root of the user's workspace.
    pub repo: PathBuf,
    /// The worktree folder.
    pub path: PathBuf,
    /// Snapshot commit the worktree started from.
    pub base: String,
    /// Folders linked from the workspace (excluded from snapshots).
    pub linked: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Change {
    /// A (added), M (modified) or D (deleted).
    pub status: String,
    pub path: String,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct MergeOutcome {
    pub merged: Vec<String>,
    /// Files left with conflict markers (or, if binary, kept as in the workspace).
    pub conflicts: Vec<String>,
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).stdin(Stdio::null());
    hide_window(&mut cmd);
    // commit-tree needs an identity; don't depend on the user's git config.
    cmd.env("GIT_AUTHOR_NAME", "Baton")
        .env("GIT_AUTHOR_EMAIL", "baton@localhost")
        .env("GIT_COMMITTER_NAME", "Baton")
        .env("GIT_COMMITTER_EMAIL", "baton@localhost");
    cmd
}

/// Windows: no console window flashing up for each git call.
fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::acp::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn run(cmd: &mut Command) -> Result<Vec<u8>, String> {
    let out = cmd.output().map_err(|e| format!("git를 실행하지 못했어요: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn run_text(cmd: &mut Command) -> Result<String, String> {
    run(cmd).map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// The repository root containing `dir`, if it is inside a git work tree.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    run_text(git(dir).args(["rev-parse", "--show-toplevel"])).ok().map(PathBuf::from)
}

/// Commit the folder's current state (tracked + untracked, minus ignored and
/// `exclude`) without touching its index, HEAD or branches.
fn snapshot(dir: &Path, exclude: &[String], label: &str) -> Result<String, String> {
    let index = std::env::temp_dir().join(format!("baton-index-{}-{}", std::process::id(), label));
    let _ = std::fs::remove_file(&index);
    let with_index = |args: &[&str]| -> Result<String, String> {
        let mut cmd = git(dir);
        cmd.env("GIT_INDEX_FILE", &index).args(args);
        run_text(&mut cmd)
    };
    let head = run_text(git(dir).args(["rev-parse", "--verify", "-q", "HEAD"])).ok();
    match &head {
        Some(_) => with_index(&["read-tree", "HEAD"])?,
        None => with_index(&["read-tree", "--empty"])?,
    };
    with_index(&["add", "-A", "--", "."])?;
    // Drop linked folders afterwards rather than excluding them by pathspec:
    // naming a path .gitignore already covers (e.g. Rust's `target`) makes
    // `git add` fail outright.
    for path in exclude {
        with_index(&["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", path])?;
    }
    let tree = with_index(&["write-tree"])?;
    let _ = std::fs::remove_file(&index);
    let mut commit = git(dir);
    commit.args(["commit-tree", &tree, "-m", &format!("baton snapshot {label}")]);
    if let Some(h) = head {
        commit.args(["-p", &h]);
    }
    run_text(&mut commit)
}

/// Create a worktree for a task from the workspace's current state.
pub fn create(workspace: &Path, worktrees_dir: &Path, task_id: &str) -> Result<Sandbox, String> {
    let repo = repo_root(workspace).ok_or("git 저장소가 아니에요")?;
    let base = snapshot(&repo, &[], &format!("{task_id}-base"))?;
    std::fs::create_dir_all(worktrees_dir).map_err(|e| e.to_string())?;
    let name = repo.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
    let path = worktrees_dir.join(format!("{name}-{task_id}-{}", &base[..8.min(base.len())]));
    run(git(&repo).arg("worktree").arg("add").arg("--detach").arg(&path).arg(&base))?;

    let mut linked = Vec::new();
    for dir in LINKED_DIRS {
        let source = repo.join(dir);
        let target = path.join(dir);
        if source.is_dir() && !target.exists() && link_dir(&source, &target).is_ok() {
            linked.push(dir.to_string());
        }
    }
    Ok(Sandbox { repo, path, base, linked })
}

#[cfg(unix)]
fn link_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
fn link_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    // Junctions need no admin rights, unlike directory symlinks.
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "mklink", "/J"]).arg(target).arg(source).stdout(Stdio::null());
    hide_window(&mut cmd);
    let status = cmd.status()?;
    if status.success() { Ok(()) } else { Err(std::io::Error::other("mklink failed")) }
}

/// What the task changed so far, as a snapshot commit plus the file list.
pub fn changes(sb: &Sandbox, label: &str) -> Result<(String, Vec<Change>), String> {
    let result = snapshot(&sb.path, &sb.linked, label)?;
    let out = run(git(&sb.repo).args(["diff", "--name-status", "--no-renames", "-z", &sb.base, &result]))?;
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut list = Vec::new();
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        list.push(Change {
            status: String::from_utf8_lossy(status).chars().next().unwrap_or('M').to_string(),
            path: String::from_utf8_lossy(path).to_string(),
        });
    }
    Ok((result, list))
}

fn blob(repo: &Path, commit: &str, path: &str) -> Option<Vec<u8>> {
    run(git(repo).args(["show", &format!("{commit}:{path}")])).ok()
}

/// Bring the task's changes into the workspace, file by file.
pub fn merge(sb: &Sandbox, result: &str, list: &[Change], task_id: &str) -> Result<MergeOutcome, String> {
    let mut outcome = MergeOutcome::default();
    for change in list {
        let target = sb.repo.join(&change.path);
        let base = blob(&sb.repo, &sb.base, &change.path);
        let theirs = blob(&sb.repo, result, &change.path);
        let ours = std::fs::read(&target).ok();

        if ours == theirs {
            outcome.merged.push(change.path.clone());
            continue;
        }
        if ours == base {
            // The workspace didn't touch this file since the task started.
            match &theirs {
                Some(bytes) => {
                    if let Some(dir) = target.parent() {
                        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                    }
                    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
                }
                None => {
                    let _ = std::fs::remove_file(&target);
                }
            }
            outcome.merged.push(change.path.clone());
            continue;
        }
        // Both sides changed: three-way merge text, keep the workspace for binaries.
        let (Some(o), Some(t)) = (&ours, &theirs) else {
            outcome.conflicts.push(change.path.clone());
            continue;
        };
        let b = base.clone().unwrap_or_default();
        if std::str::from_utf8(o).is_err() || std::str::from_utf8(t).is_err() || std::str::from_utf8(&b).is_err() {
            outcome.conflicts.push(change.path.clone());
            continue;
        }
        let tmp = std::env::temp_dir().join(format!("baton-merge-{}-{task_id}", std::process::id()));
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let (fo, fb, ft) = (tmp.join("ours"), tmp.join("base"), tmp.join("theirs"));
        std::fs::write(&fo, o).map_err(|e| e.to_string())?;
        std::fs::write(&fb, &b).map_err(|e| e.to_string())?;
        std::fs::write(&ft, t).map_err(|e| e.to_string())?;
        let out = git(&sb.repo)
            .args(["merge-file", "-p", "-L", "workspace", "-L", "base", "-L", &format!("task {task_id}")])
            .arg(&fo)
            .arg(&fb)
            .arg(&ft)
            .output()
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&tmp);
        // merge-file exits with the number of conflicts; negative means error.
        match out.status.code() {
            Some(0) => {
                std::fs::write(&target, &out.stdout).map_err(|e| e.to_string())?;
                outcome.merged.push(change.path.clone());
            }
            Some(n) if n > 0 => {
                std::fs::write(&target, &out.stdout).map_err(|e| e.to_string())?;
                outcome.conflicts.push(change.path.clone());
            }
            _ => outcome.conflicts.push(change.path.clone()),
        }
    }
    Ok(outcome)
}

/// Delete the worktree folder and its git bookkeeping.
pub fn remove(sb: &Sandbox) {
    // Unlink shared folders first so nothing can follow them on delete.
    for dir in &sb.linked {
        let link = sb.path.join(dir);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&link);
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
    }
    let _ = run(git(&sb.repo).arg("worktree").arg("remove").arg("--force").arg(&sb.path));
    let _ = std::fs::remove_dir_all(&sb.path);
    let _ = run(git(&sb.repo).args(["worktree", "prune"]));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    #[test]
    fn worktree_roundtrip_merges_and_flags_conflicts() {
        let root = std::env::temp_dir().join(format!("baton-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.join("b.txt"), "keep\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        // Uncommitted + untracked work must reach the worktree.
        std::fs::write(repo.join("b.txt"), "keep\nlocal edit\n").unwrap();
        std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules")).unwrap();
        std::fs::create_dir_all(repo.join("target")).unwrap();
        // Both ignore styles: `dir/` (doesn't match the symlink) and Rust's bare `target` (does).
        std::fs::write(repo.join(".gitignore"), "node_modules/\ntarget\n").unwrap();

        let sb = create(&repo, &root.join("wts"), "t1").unwrap();
        assert_eq!(std::fs::read_to_string(sb.path.join("b.txt")).unwrap(), "keep\nlocal edit\n");
        assert!(sb.path.join("new.txt").exists());
        assert_eq!(sb.linked, vec!["node_modules".to_string(), "target".to_string()]);

        // Task edits line 1 of a.txt and b.txt, adds c.txt; workspace edits line 3 of a.txt and b.txt.
        std::fs::write(sb.path.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
        std::fs::write(sb.path.join("b.txt"), "task\nlocal edit\n").unwrap();
        std::fs::write(sb.path.join("c.txt"), "added\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\ntwo\nTHREE\n").unwrap();
        std::fs::write(repo.join("b.txt"), "workspace\nlocal edit\n").unwrap();

        let (result, list) = changes(&sb, "t1-r").unwrap();
        let paths: Vec<_> = list.iter().map(|c| format!("{}{}", c.status, c.path)).collect();
        assert_eq!(paths, vec!["Ma.txt", "Mb.txt", "Ac.txt"]);

        let outcome = merge(&sb, &result, &list, "t1").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n");
        assert_eq!(std::fs::read_to_string(repo.join("c.txt")).unwrap(), "added\n");
        assert_eq!(outcome.conflicts, vec!["b.txt".to_string()]);
        assert!(std::fs::read_to_string(repo.join("b.txt")).unwrap().contains("<<<<<<<"));

        remove(&sb);
        assert!(!sb.path.exists());
        assert!(repo.join("node_modules").is_dir(), "linked folder must survive removal");
        let _ = std::fs::remove_dir_all(&root);
    }
}
