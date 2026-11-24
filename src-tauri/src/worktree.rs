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
    run_text(git(dir).args(["rev-parse", "--show-toplevel"])).ok().map(|p| native_path(&p))
}

/// A path printed by git. Git for Windows prints `C:/Users/…`; keep it in
/// the native form, since `cmd` reads `/Users` as an option switch.
fn native_path(text: &str) -> PathBuf {
    if cfg!(windows) { PathBuf::from(text.replace('/', "\\")) } else { PathBuf::from(text) }
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

/// Text with CRLF line endings turned into LF, so files compare equal no
/// matter how git converted them (Windows keeps CRLF on disk, LF in git).
fn lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 20);
    for &b in bytes {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

fn is_text(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0)
}

/// Bring the task's changes into the workspace, file by file.
///
/// Comparisons and three-way merges run on LF-normalised text; merged text is
/// written back with the workspace file's own line endings.
pub fn merge(sb: &Sandbox, result: &str, list: &[Change], task_id: &str) -> Result<MergeOutcome, String> {
    let mut outcome = MergeOutcome::default();
    for change in list {
        let target = sb.repo.join(&change.path);
        let base = blob(&sb.repo, &sb.base, &change.path);
        // What the member actually left on disk (its line endings included);
        // fall back to the snapshot if the file can't be read.
        let theirs = if change.status == "D" {
            None
        } else {
            std::fs::read(sb.path.join(&change.path)).ok().or_else(|| blob(&sb.repo, result, &change.path))
        };
        let ours = std::fs::read(&target).ok();
        let norm = |b: &Option<Vec<u8>>| b.as_ref().map(|v| if is_text(v) { lf(v) } else { v.clone() });

        if norm(&ours) == norm(&theirs) {
            outcome.merged.push(change.path.clone());
            continue;
        }
        if norm(&ours) == norm(&base) {
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
        if !is_text(o) || !is_text(t) || !is_text(&b) {
            outcome.conflicts.push(change.path.clone());
            continue;
        }
        let workspace_crlf = o.windows(2).any(|w| w == b"\r\n");
        let tmp = std::env::temp_dir().join(format!("baton-merge-{}-{task_id}", std::process::id()));
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let (fo, fb, ft) = (tmp.join("ours"), tmp.join("base"), tmp.join("theirs"));
        std::fs::write(&fo, lf(o)).map_err(|e| e.to_string())?;
        std::fs::write(&fb, lf(&b)).map_err(|e| e.to_string())?;
        std::fs::write(&ft, lf(t)).map_err(|e| e.to_string())?;
        let mut cmd = git(&sb.repo);
        cmd.args(["merge-file", "-p", "-L", "workspace", "-L", "base", "-L", &format!("task {task_id}")])
            .arg(&fo)
            .arg(&fb)
            .arg(&ft);
        let out = cmd.output().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&tmp);
        let merged = if workspace_crlf { crlf(&out.stdout) } else { out.stdout.clone() };
        // merge-file exits with the number of conflicts; negative means error.
        match out.status.code() {
            Some(0) => {
                std::fs::write(&target, &merged).map_err(|e| e.to_string())?;
                outcome.merged.push(change.path.clone());
            }
            Some(n) if n > 0 => {
                std::fs::write(&target, &merged).map_err(|e| e.to_string())?;
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
    unlink(sb);
    let _ = run(git(&sb.repo).arg("worktree").arg("remove").arg("--force").arg(&sb.path));
    let _ = std::fs::remove_dir_all(&sb.path);
    let _ = run(git(&sb.repo).args(["worktree", "prune"]));
}

const LOCK_FILE: &str = ".lock";

/// This run's folder for worktrees, `<root>/<run_id>`. The returned file holds
/// a lock for as long as the app runs, so another Baton window's cleanup
/// leaves the folder alone.
pub fn claim_run_dir(root: &Path, run_id: &str) -> std::io::Result<(PathBuf, std::fs::File)> {
    let dir = root.join(run_id);
    std::fs::create_dir_all(&dir)?;
    let lock = std::fs::File::create(dir.join(LOCK_FILE))?;
    lock.try_lock().map_err(std::io::Error::other)?;
    Ok((dir, lock))
}

/// Remove worktrees left by earlier runs (the app quit before their tasks were
/// merged or discarded). Changes nobody merged are first saved as a patch in
/// the repository's `.baton/unmerged/`; returns those patch files.
pub fn cleanup_orphans(root: &Path, keep: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut saved = Vec::new();
    for dir in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && p != keep) {
        if dir.join(".git").is_file() {
            // Worktree from a version without run folders.
            saved.extend(remove_orphan(&dir));
            continue;
        }
        let lock_path = dir.join(LOCK_FILE);
        if lock_path.exists() {
            let Ok(lock) = std::fs::File::open(&lock_path) else { continue };
            if lock.try_lock().is_err() {
                continue; // Another instance is still using it.
            }
            // Released before deleting: Windows can't delete an open file.
        }
        let Ok(children) = std::fs::read_dir(&dir) else { continue };
        for child in children.flatten().map(|e| e.path()).filter(|p| p.join(".git").is_file()) {
            saved.extend(remove_orphan(&child));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    saved
}

fn remove_orphan(path: &Path) -> Option<PathBuf> {
    let linked: Vec<String> = LINKED_DIRS
        .iter()
        .filter(|d| path.join(d).symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()))
        .map(|d| d.to_string())
        .collect();
    let common = run_text(git(path).args(["rev-parse", "--path-format=absolute", "--git-common-dir"])).ok();
    let repo = common.as_deref().map(native_path).and_then(|p| p.parent().map(Path::to_path_buf));
    let base = run_text(git(path).args(["rev-parse", "HEAD"])).ok();
    let (Some(repo), Some(base)) = (repo, base) else {
        // Its repository is gone: nothing to save or unregister.
        let sb = Sandbox { repo: path.to_path_buf(), path: path.to_path_buf(), base: String::new(), linked };
        unlink(&sb);
        let _ = std::fs::remove_dir_all(path);
        return None;
    };
    let sb = Sandbox { repo, path: path.to_path_buf(), base, linked };
    let saved = save_patch(&sb);
    remove(&sb);
    saved
}

/// Write the worktree's changes since its base as `.baton/unmerged/<name>.patch`
/// (apply with `git apply`). None when there were no changes.
fn save_patch(sb: &Sandbox) -> Option<PathBuf> {
    let name = sb.path.file_name()?.to_string_lossy().to_string();
    let result = snapshot(&sb.path, &sb.linked, &format!("{name}-orphan")).ok()?;
    let diff = run(git(&sb.repo).args(["diff", "--binary", &sb.base, &result])).ok()?;
    if diff.is_empty() {
        return None;
    }
    let dir = crate::history::baton_subdir(&sb.repo, "unmerged").ok()?;
    let file = dir.join(format!("{name}.patch"));
    std::fs::write(&file, diff).ok()?;
    Some(file)
}

/// A leftover patch saved by `save_patch`, for the UI to list.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UnmergedPatch {
    pub file: String,
    /// Milliseconds since the epoch.
    pub modified: u64,
    pub size: u64,
    /// Paths the patch changes.
    pub files: Vec<String>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct ApplyOutcome {
    pub applied: bool,
    /// Files left with conflict markers.
    pub conflicts: Vec<String>,
    pub message: String,
}

/// `<root>/.baton/unmerged`, without creating it.
fn unmerged_dir(workspace: &Path) -> Option<PathBuf> {
    Some(repo_root(workspace)?.join(".baton").join("unmerged"))
}

/// The patch's path, only for a plain `*.patch` file name inside `unmerged_dir`.
fn patch_path(workspace: &Path, file: &str) -> Result<PathBuf, String> {
    let plain = !file.is_empty() && !file.contains(['/', '\\']) && !file.contains("..");
    if !plain || !file.ends_with(".patch") {
        return Err(format!("올바르지 않은 파일 이름이에요: {file}"));
    }
    let path = unmerged_dir(workspace).ok_or("git 저장소가 아니에요")?.join(file);
    if path.is_file() { Ok(path) } else { Err(format!("패치 파일이 없어요: {file}")) }
}

/// Leftover patches in the workspace's repository, newest first.
pub fn list_unmerged(workspace: &Path) -> Vec<UnmergedPatch> {
    let Some(root) = repo_root(workspace) else { return Vec::new() };
    let Some(dir) = unmerged_dir(workspace) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<UnmergedPatch> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".patch"))
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            // `-z` prints paths verbatim: "added\tdeleted\tpath\0".
            let numstat = run(git(&root).args(["apply", "--numstat", "-z"]).arg(e.path())).unwrap_or_default();
            let files = String::from_utf8_lossy(&numstat)
                .split('\0')
                .filter_map(|l| l.splitn(3, '\t').nth(2))
                .map(str::to_string)
                .collect();
            Some(UnmergedPatch { file: e.file_name().to_string_lossy().to_string(), modified, size: meta.len(), files })
        })
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(p.modified));
    out
}

/// `git apply --3way` against a throwaway index that matches the working
/// tree (it refuses to run when the two differ), so the user's own index is
/// never touched. The temp index is removed on every path out.
fn three_way(root: &Path, patch: &Path) -> Result<std::process::Output, String> {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let index = std::env::temp_dir().join(format!("baton-index-{}-apply{seq}", std::process::id()));
    let _ = std::fs::remove_file(&index);
    let result = (|| {
        let with_index = |args: &[&str]| {
            let mut cmd = git(root);
            cmd.env("GIT_INDEX_FILE", &index).args(args);
            cmd
        };
        let has_head = run_text(git(root).args(["rev-parse", "--verify", "-q", "HEAD"])).is_ok();
        run(&mut with_index(&["read-tree", if has_head { "HEAD" } else { "--empty" }]))?;
        run(&mut with_index(&["add", "-A", "--", "."]))?;
        with_index(&["apply", "--3way"])
            .arg(patch)
            .output()
            .map_err(|e| format!("git를 실행하지 못했어요: {e}"))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Apply a leftover patch to the working tree. Plain first; if the files have
/// moved on, a 3-way merge that may leave conflict markers. The patch is
/// deleted only after a clean apply.
pub fn apply_unmerged(workspace: &Path, file: &str) -> Result<ApplyOutcome, String> {
    let path = patch_path(workspace, file)?;
    let root = repo_root(workspace).ok_or("git 저장소가 아니에요")?;
    let io = |e: std::io::Error| format!("git를 실행하지 못했어요: {e}");
    if git(&root).arg("apply").arg(&path).output().map_err(io)?.status.success() {
        let _ = std::fs::remove_file(&path);
        return Ok(ApplyOutcome { applied: true, message: "그대로 적용했어요".into(), ..Default::default() });
    }
    let out = three_way(&root, &path)?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        let _ = std::fs::remove_file(&path);
        return Ok(ApplyOutcome { applied: true, message: "변경된 부분을 합쳐서 적용했어요".into(), ..Default::default() });
    }
    // "Applied patch to 'x' with conflicts." for each file left with markers.
    let conflicts: Vec<String> = stderr
        .lines()
        .filter_map(|l| l.strip_prefix("Applied patch to '")?.strip_suffix("' with conflicts."))
        .map(str::to_string)
        .collect();
    let message = if conflicts.is_empty() { stderr } else { "충돌이 있어요".into() };
    Ok(ApplyOutcome { applied: false, conflicts, message })
}

pub fn delete_unmerged(workspace: &Path, file: &str) -> Result<(), String> {
    std::fs::remove_file(patch_path(workspace, file)?).map_err(|e| e.to_string())
}

fn unlink(sb: &Sandbox) {
    for dir in &sb.linked {
        let link = sb.path.join(dir);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&link);
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    fn patch_repo(name: &str) -> (PathBuf, PathBuf) {
        let repo = std::env::temp_dir().join(format!("baton-unmerged-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nf4\nf5\nf6\nf7\nf8\n").unwrap();
        sh(&repo, &["add", "."]);
        let commit = |msg: &str| sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", msg]);
        commit("init");
        // The patch: a.txt line 2 -> TWO, plus a new file.
        std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nf4\nf5\nf6\nf7\nf8\n").unwrap();
        std::fs::write(repo.join("n.txt"), "new\n").unwrap();
        sh(&repo, &["add", "."]);
        commit("task");
        let diff = run(git(&repo).args(["diff", "--binary", "HEAD~1", "HEAD"])).unwrap();
        sh(&repo, &["reset", "-q", "--hard", "HEAD~1"]);
        let dir = crate::history::baton_subdir(&repo, "unmerged").unwrap();
        std::fs::write(dir.join("t1.patch"), diff).unwrap();
        (repo, dir.join("t1.patch"))
    }

    #[test]
    fn unmerged_patch_lists_and_applies_cleanly() {
        let (repo, patch) = patch_repo("clean");
        let list = list_unmerged(&repo);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].file, "t1.patch");
        assert!(list[0].size > 0 && list[0].modified > 0);
        let mut files = list[0].files.clone();
        files.sort();
        assert_eq!(files, vec!["a.txt", "n.txt"]);

        let out = apply_unmerged(&repo, "t1.patch").unwrap();
        assert!(out.applied && out.conflicts.is_empty());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\nTWO\nthree\nf4\nf5\nf6\nf7\nf8\n");
        assert!(repo.join("n.txt").exists());
        assert!(!patch.exists());
        assert!(list_unmerged(&repo).is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn unmerged_patch_falls_back_to_three_way_and_keeps_patch_on_conflict() {
        let (repo, patch) = patch_repo("conflict");
        // An uncommitted edit: the 3-way merge must still run, without staging anything.
        std::fs::write(repo.join("a.txt"), "one\nother\nthree\nf4\nf5\nf6\nf7\nf8\n").unwrap();
        let out = apply_unmerged(&repo, "t1.patch").unwrap();
        assert!(!out.applied);
        assert_eq!(out.conflicts, vec!["a.txt"]);
        assert!(std::fs::read_to_string(repo.join("a.txt")).unwrap().contains("<<<<<<<"));
        assert!(patch.exists(), "a conflicted patch must be kept");
        sh(&repo, &["diff", "--cached", "--quiet"]);
        // Neither method works (no repo history for the blobs): the error is returned, patch kept.
        std::fs::write(&patch, "garbage\n").unwrap();
        let out = apply_unmerged(&repo, "t1.patch").unwrap();
        assert!(!out.applied && out.conflicts.is_empty() && !out.message.is_empty());
        assert!(patch.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn unmerged_patch_merges_around_unrelated_uncommitted_edits() {
        let (repo, patch) = patch_repo("merge");
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nf4\nf5\nf6\nf7\nEIGHT\n").unwrap();
        let out = apply_unmerged(&repo, "t1.patch").unwrap();
        assert!(out.applied && out.conflicts.is_empty(), "{}", out.message);
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\nTWO\nthree\nf4\nf5\nf6\nf7\nEIGHT\n");
        assert!(!patch.exists());
        sh(&repo, &["diff", "--cached", "--quiet"]);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn unmerged_patch_delete_and_bad_names() {
        let (repo, patch) = patch_repo("names");
        for bad in ["", "../t1.patch", "a/t1.patch", "a\\t1.patch", "t1.txt", "..patch", ".patch/.."] {
            assert!(apply_unmerged(&repo, bad).is_err(), "{bad}");
            assert!(delete_unmerged(&repo, bad).is_err(), "{bad}");
        }
        assert!(patch.exists());
        assert!(delete_unmerged(&repo, "missing.patch").is_err());
        delete_unmerged(&repo, "t1.patch").unwrap();
        assert!(!patch.exists());
        // Not a git repo: empty list.
        assert!(list_unmerged(&std::env::temp_dir().join("baton-no-such-dir")).is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_roundtrip_merges_and_flags_conflicts() {
        let root = std::env::temp_dir().join(format!("baton-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q"]);
        // Keep LF on disk even where git converts by default (GitHub's Windows runners).
        sh(&repo, &["config", "core.autocrlf", "false"]);
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

    /// Windows: files are CRLF on disk but LF inside git (core.autocrlf=true).
    #[test]
    fn crlf_workspace_merges_without_false_conflicts() {
        let root = std::env::temp_dir().join(format!("baton-wt-crlf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "core.autocrlf", "true"]);
        std::fs::write(repo.join("a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        std::fs::write(repo.join("b.txt"), "keep\r\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

        let sb = create(&repo, &root.join("wts"), "c1").unwrap();
        // Task rewrites a.txt line 1 and b.txt; workspace edits a.txt line 3 only.
        std::fs::write(sb.path.join("a.txt"), "ONE\r\ntwo\r\nthree\r\n").unwrap();
        std::fs::write(sb.path.join("b.txt"), "task\r\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\r\ntwo\r\nTHREE\r\n").unwrap();

        let (result, list) = changes(&sb, "c1-r").unwrap();
        let outcome = merge(&sb, &result, &list, "c1").unwrap();
        assert!(outcome.conflicts.is_empty(), "false conflicts: {:?}", outcome.conflicts);
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "ONE\r\ntwo\r\nTHREE\r\n");
        assert_eq!(std::fs::read_to_string(repo.join("b.txt")).unwrap(), "task\r\n");
        remove(&sb);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn leftover_worktrees_are_saved_as_patches_and_removed() {
        let root = std::env::temp_dir().join(format!("baton-wt-orphan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("node_modules")).unwrap();
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        std::fs::write(repo.join("node_modules/dep.js"), "keep me").unwrap();

        let wts = root.join("worktrees");
        // An earlier run that quit with an unmerged task and a task that changed nothing.
        let (old_run, old_lock) = claim_run_dir(&wts, "old1").unwrap();
        let edited = create(&repo, &old_run, "old1-1").unwrap();
        std::fs::write(edited.path.join("a.txt"), "one\ntask edit\n").unwrap();
        std::fs::write(edited.path.join("new.txt"), "from task\n").unwrap();
        let untouched = create(&repo, &old_run, "old1-2").unwrap();
        drop(old_lock);
        // Another window that is still running.
        let (live_run, _live_lock) = claim_run_dir(&wts, "live").unwrap();
        let live = create(&repo, &live_run, "live-1").unwrap();
        // A worktree from before run folders existed.
        let flat = create(&repo, &wts, "flat-1").unwrap();
        // This run's own folder.
        let (mine, _my_lock) = claim_run_dir(&wts, "mine").unwrap();

        let saved = cleanup_orphans(&wts, &mine);

        assert_eq!(saved.len(), 1, "only the edited task has something to save: {saved:?}");
        // Compare real paths: macOS temp folders sit behind a /private symlink,
        // and Windows canonical paths carry a \\?\ prefix.
        let unmerged = repo.join(".baton").join("unmerged").canonicalize().unwrap();
        assert!(saved[0].canonicalize().unwrap().starts_with(&unmerged), "{saved:?}");
        assert!(!edited.path.exists() && !untouched.path.exists() && !flat.path.exists());
        assert!(!old_run.exists(), "the finished run's folder is gone");
        assert!(live.path.exists(), "a running instance's worktree is left alone");
        assert!(mine.exists());
        assert_eq!(std::fs::read_to_string(repo.join("node_modules/dep.js")).unwrap(), "keep me");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\n", "the workspace is untouched");

        // The patch brings the task's work back.
        sh(&repo, &["apply", saved[0].to_str().unwrap()]);
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "one\ntask edit\n");
        assert_eq!(std::fs::read_to_string(repo.join("new.txt")).unwrap(), "from task\n");

        let worktrees = String::from_utf8(
            Command::new("git").arg("-C").arg(&repo).args(["worktree", "list"]).output().unwrap().stdout,
        )
        .unwrap();
        assert_eq!(worktrees.lines().count(), 2, "only the repo and the live worktree stay registered:\n{worktrees}");
        remove(&live);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn worktrees_of_deleted_repos_are_just_deleted() {
        let root = std::env::temp_dir().join(format!("baton-wt-gone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        let wts = root.join("worktrees");
        let (run, lock) = claim_run_dir(&wts, "r1").unwrap();
        let sb = create(&repo, &run, "r1-1").unwrap();
        std::fs::write(sb.path.join("a.txt"), "edit\n").unwrap();
        drop(lock);
        std::fs::remove_dir_all(&repo).unwrap();

        assert!(cleanup_orphans(&wts, &wts.join("mine")).is_empty());
        assert!(!run.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_paths_become_native() {
        let p = native_path("C:/Users/me/repo");
        if cfg!(windows) {
            assert_eq!(p.to_str(), Some("C:\\Users\\me\\repo"));
        } else {
            assert_eq!(p.to_str(), Some("C:/Users/me/repo"));
        }
    }
}
