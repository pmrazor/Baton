//! Source control for the pro mode 깃 panel: status, staging, commits,
//! branches and sync, run with the user's own git config and identity.
//!
//! Every command runs from the repository root with terminal prompts turned
//! off and a timeout, so a credential prompt or a stuck hook can't hang the
//! app. Paths are relative to the repository root, `/`-separated, and are
//! validated like `files.rs` does before they reach git.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::files::MAX_READ_BYTES;
use crate::gitdiff::{self, BlobContent, GitDiffTexts};
use crate::worktree::{hide_window, native_path};

/// Local operations: status, staging, branches.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Commits (hooks may run) and network operations.
const LONG_TIMEOUT: Duration = Duration::from_secs(120);
/// Paths per git invocation, to stay under command-line length limits.
const PATH_CHUNK: usize = 200;
/// Default page size for `git_log`.
const DEFAULT_LOG_LIMIT: u32 = 200;
/// Field separator inside a `-z` terminated `git log` record.
const LOG_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    /// Relative to the repository root, `/`-separated.
    pub path: String,
    /// The old path of a staged rename or copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// Staged state: M, A, D, R, C, T, U, or "" when unchanged.
    pub index: String,
    /// Working tree state: M, D, T, A, U, ?, or "" when unchanged.
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo: bool,
    /// The repository's top folder (native form); empty when not a repo.
    pub repo_root: String,
    /// The requested folder relative to `repo_root`, `/`-terminated or empty.
    pub prefix: String,
    /// The current branch, or the short commit when detached.
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// False in a fresh repository without commits (nothing to amend).
    pub has_commits: bool,
    /// Full HEAD commit hash, or empty when there are no commits yet.
    pub head: String,
    pub files: Vec<StatusFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Branch {
    /// `main` for a local branch, `origin/main` for a remote one.
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        // Status polling must not take index.lock away from a concurrent `git add`.
        .arg("--no-optional-locks")
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        // Paths are file names, never pathspec magic like `:(top)` or globs.
        .env("GIT_LITERAL_PATHSPECS", "1");
    hide_window(&mut cmd);
    cmd
}

/// Read a pipe to the end on its own thread.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Run a command, killing it once `timeout` passes.
fn exec(cmd: &mut Command, timeout: Duration) -> Result<Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("git를 실행하지 못했어요: {e}"))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git 명령이 {}초 안에 끝나지 않아 멈췄어요. 인증이나 네트워크 상태를 확인해 주세요.",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("git 명령을 기다리지 못했어요: {e}")),
        }
    };
    // A helper git started (an ssh master, say) may hold the pipes open; don't wait on it.
    let grace = Duration::from_secs(2);
    let stdout = stdout.recv_timeout(grace).unwrap_or_default();
    let stderr = stderr.recv_timeout(grace).unwrap_or_default();
    Ok(Output { success: status.success(), stdout, stderr: String::from_utf8_lossy(&stderr).trim().to_string() })
}

/// `what` (e.g. "스테이징하지 못했어요") followed by git's own message.
fn failure(what: &str, out: &Output) -> String {
    let detail =
        if out.stderr.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { out.stderr.clone() };
    if detail.is_empty() { what.to_string() } else { format!("{what}: {detail}") }
}

fn run(dir: &Path, args: &[&str], timeout: Duration, what: &str) -> Result<Vec<u8>, String> {
    let out = exec(git(dir).args(args), timeout).map_err(|e| format!("{what}: {e}"))?;
    if out.success { Ok(out.stdout) } else { Err(failure(what, &out)) }
}

fn run_text(dir: &Path, args: &[&str], timeout: Duration, what: &str) -> Result<String, String> {
    run(dir, args, timeout, what).map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// Run `args` followed by `paths`, in chunks.
fn run_paths(dir: &Path, args: &[&str], paths: &[String], what: &str) -> Result<(), String> {
    for chunk in paths.chunks(PATH_CHUNK) {
        let mut all: Vec<&str> = args.to_vec();
        all.extend(chunk.iter().map(String::as_str));
        run(dir, &all, LOCAL_TIMEOUT, what)?;
    }
    Ok(())
}

/// The repository's top folder and `root`'s prefix in it; None when `root`
/// is not inside a git work tree.
fn open_repo(root: &str) -> Result<Option<(PathBuf, String)>, String> {
    let dir = Path::new(root);
    if !dir.is_dir() {
        return Err("작업 폴더를 찾을 수 없어요.".into());
    }
    let out = exec(git(dir).args(["rev-parse", "--show-toplevel", "--show-prefix"]), LOCAL_TIMEOUT)?;
    if !out.success {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let top = lines.next().unwrap_or("").trim();
    if top.is_empty() {
        return Ok(None);
    }
    Ok(Some((native_path(top), lines.next().unwrap_or("").trim().to_string())))
}

fn repo(root: &str) -> Result<PathBuf, String> {
    open_repo(root)?.map(|(top, _)| top).ok_or_else(|| "git 저장소가 아니에요.".into())
}

fn has_head(repo: &Path) -> bool {
    exec(git(repo).args(["rev-parse", "--verify", "-q", "HEAD"]), LOCAL_TIMEOUT).is_ok_and(|o| o.success)
}

fn clean_single_path(path: &str) -> Result<String, String> {
    crate::files::parse_rel_segments(path, false)
        .map(|segments| segments.join("/"))
        .map_err(|e| format!("{} ({path})", e.message))
}

/// Validate paths the way `files.rs` does (no `..`, no absolute paths) and
/// normalise them to `/`-separated repository-relative paths.
fn clean_paths(paths: &[String]) -> Result<Vec<String>, String> {
    paths.iter().map(|p| clean_single_path(p)).collect()
}

/// Validate a git commit hash as 4–64 ASCII hex characters.
fn validate_hash(hash: &str) -> Result<&str, String> {
    let h = hash.trim();
    if (4..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(h)
    } else {
        Err(format!("올바르지 않은 커밋 해시예요: {hash}"))
    }
}

fn validate_branch_name<'a>(repo: &Path, branch: &'a str) -> Result<&'a str, String> {
    let name = branch.trim();
    if name.is_empty() {
        return Err("브랜치 이름을 입력해 주세요.".into());
    }
    let valid = !name.starts_with('-')
        && exec(git(repo).args(["check-ref-format", "--branch", name]), LOCAL_TIMEOUT)?.success;
    if !valid {
        return Err(format!("쓸 수 없는 브랜치 이름이에요: {name}"));
    }
    Ok(name)
}

fn state(c: char) -> String {
    if c == '.' { String::new() } else { c.to_string() }
}

/// A porcelain v2 change record of `fields` space-separated fields, the
/// first being `XY` and the last the path (which may contain spaces).
fn entry(rest: &str, fields: usize) -> Option<StatusFile> {
    let parts: Vec<&str> = rest.splitn(fields, ' ').collect();
    if parts.len() != fields {
        return None;
    }
    let mut code = parts[0].chars();
    let (x, y) = (code.next()?, code.next()?);
    Some(StatusFile { path: parts[fields - 1].to_string(), index: state(x), worktree: state(y), ..Default::default() })
}

/// Parse `git status --porcelain=v2 --branch -z` output.
fn parse_status(out: &[u8]) -> GitStatus {
    let text = String::from_utf8_lossy(out);
    let mut st = GitStatus { repo: true, ..Default::default() };
    let mut oid = String::new();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => oid = value.to_string(),
                "branch.head" => st.branch = value.to_string(),
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
        } else if let Some(rest) = record.strip_prefix("1 ") {
            // XY sub mH mI mW hH hI path
            st.files.extend(entry(rest, 8));
        } else if let Some(rest) = record.strip_prefix("2 ") {
            // XY sub mH mI mW hH hI Xscore path, then the original path as its own record.
            let orig = records.next().filter(|p| !p.is_empty()).map(str::to_string);
            st.files.extend(entry(rest, 9).map(|f| StatusFile { orig_path: orig, ..f }));
        } else if let Some(rest) = record.strip_prefix("u ") {
            // XY sub m1 m2 m3 mW h1 h2 h3 path
            st.files.extend(entry(rest, 10).map(|f| StatusFile { conflicted: true, ..f }));
        } else if let Some(path) = record.strip_prefix("? ") {
            st.files.push(StatusFile {
                path: path.to_string(),
                worktree: "?".into(),
                untracked: true,
                ..Default::default()
            });
        }
    }
    st.has_commits = !oid.is_empty() && oid != "(initial)";
    if st.has_commits {
        st.head = oid.clone();
    }
    if st.branch == "(detached)" {
        st.detached = true;
        st.branch = oid.chars().take(7).collect();
    }
    st
}

fn read_status(repo: &Path) -> Result<GitStatus, String> {
    let out = run(
        repo,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        LOCAL_TIMEOUT,
        "변경 사항을 읽지 못했어요",
    )?;
    Ok(parse_status(&out))
}

pub fn status(root: &str) -> Result<GitStatus, String> {
    let Some((top, prefix)) = open_repo(root)? else { return Ok(GitStatus::default()) };
    let mut st = read_status(&top)?;
    st.repo_root = top.display().to_string();
    st.prefix = prefix;
    Ok(st)
}

pub fn stage(root: &str, paths: &[String]) -> Result<(), String> {
    let paths = clean_paths(paths)?;
    let repo = repo(root)?;
    run_paths(&repo, &["add", "--"], &paths, "스테이징하지 못했어요")
}

pub fn unstage(root: &str, paths: &[String]) -> Result<(), String> {
    let paths = clean_paths(paths)?;
    let repo = repo(root)?;
    if has_head(&repo) {
        run_paths(&repo, &["restore", "--staged", "--"], &paths, "스테이징을 취소하지 못했어요")
    } else {
        // No commit yet: there is nothing to restore from, so just drop the entries.
        run_paths(
            &repo,
            &["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"],
            &paths,
            "스테이징을 취소하지 못했어요",
        )
    }
}

/// Tracked files go back to their staged (or committed) content; untracked
/// files go to the OS trash, never deleted outright. Paths without changes
/// are skipped.
pub fn discard(root: &str, paths: &[String]) -> Result<(), String> {
    let paths = clean_paths(paths)?;
    let repo = repo(root)?;
    let st = read_status(&repo)?;
    let untracked: HashSet<&str> = st.files.iter().filter(|f| f.untracked).map(|f| f.path.as_str()).collect();
    let changed: HashSet<&str> = st.files.iter().filter(|f| !f.untracked).map(|f| f.path.as_str()).collect();
    let tracked: Vec<String> = paths.iter().filter(|p| changed.contains(p.as_str())).cloned().collect();
    // `restore --worktree` restores from the index by default.
    run_paths(&repo, &["restore", "--worktree", "--"], &tracked, "변경을 되돌리지 못했어요")?;
    let repo_text = repo.to_string_lossy();
    for path in paths.iter().filter(|p| untracked.contains(p.as_str())) {
        crate::files::trash_entry(&repo_text, path).map_err(|e| format!("{} ({path})", e.message))?;
    }
    Ok(())
}

/// Commit what is staged; returns the new commit's short hash.
pub fn commit(root: &str, message: &str, amend: bool) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("커밋 메시지를 입력해 주세요.".into());
    }
    let repo = repo(root)?;
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    run(&repo, &args, LONG_TIMEOUT, "커밋하지 못했어요")?;
    run_text(&repo, &["rev-parse", "--short", "HEAD"], LOCAL_TIMEOUT, "커밋 해시를 읽지 못했어요")
}

fn parse_branches(out: &[u8]) -> Vec<Branch> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let full = fields.next()?;
            let name = fields.next()?;
            let head = fields.next().unwrap_or("");
            let upstream = fields.next().unwrap_or("").trim();
            let remote = full.starts_with("refs/remotes/");
            // `origin/HEAD` points at another remote branch.
            if name.is_empty() || (remote && full.ends_with("/HEAD")) {
                return None;
            }
            Some(Branch {
                name: name.to_string(),
                current: head == "*",
                remote,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect()
}

/// Local branches (the current one marked), then remote branches.
pub fn branches(root: &str) -> Result<Vec<Branch>, String> {
    let repo = repo(root)?;
    let out = run(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
        LOCAL_TIMEOUT,
        "브랜치 목록을 읽지 못했어요",
    )?;
    Ok(parse_branches(&out))
}

/// Switch to `branch` (a remote branch's name without the remote creates a
/// tracking branch), or create it from HEAD. Git refuses when local changes
/// would be overwritten; its message is passed on.
pub fn checkout(root: &str, branch: &str, create: bool) -> Result<(), String> {
    let repo = repo(root)?;
    let name = validate_branch_name(&repo, branch)?;
    // `switch`, not `checkout`: a name that also matches a file must never restore that file.
    let args: &[&str] = if create { &["switch", "-c", name] } else { &["switch", name] };
    let what = if create { "브랜치를 만들지 못했어요" } else { "브랜치를 바꾸지 못했어요" };
    run(&repo, args, LOCAL_TIMEOUT, what).map(|_| ())
}

/// Create a new branch pointing at `hash` without switching to it.
pub fn branch_at(root: &str, name: &str, hash: &str) -> Result<(), String> {
    let hash = validate_hash(hash)?;
    let repo = repo(root)?;
    let name = validate_branch_name(&repo, name)?;
    run(&repo, &["branch", name, hash], LOCAL_TIMEOUT, "브랜치를 만들지 못했어요").map(|_| ())
}

fn parse_log(out: &[u8]) -> Vec<Commit> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter(|rec| !rec.is_empty())
        .filter_map(|rec| {
            let mut fields = rec.split('\x1f');
            let hash = fields.next()?.trim().to_string();
            if hash.is_empty() {
                return None;
            }
            let short = fields.next()?.to_string();
            let parents = fields.next()?.split_whitespace().map(str::to_string).collect();
            let author = fields.next()?.to_string();
            let email = fields.next()?.to_string();
            let time = fields.next()?.trim().parse::<i64>().unwrap_or(0);
            let subject = fields.next()?.to_string();
            let refs = fields
                .next()
                .unwrap_or("")
                .split(", ")
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .collect();
            Some(Commit { hash, short, parents, author, email, time, subject, refs })
        })
        .collect()
}

/// Read paginated commit history across all refs, in topological order.
/// Returns an empty list for a repository with no commits.
pub fn log(root: &str, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
    let repo = repo(root)?;
    let limit = if limit == 0 { DEFAULT_LOG_LIMIT } else { limit };
    let skip_arg = format!("--skip={skip}");
    let limit_arg = format!("-n{limit}");
    let format_arg = format!("--format={LOG_FORMAT}");
    let out = exec(
        git(&repo).args([
            "log",
            "--all",
            "--date-order",
            "--topo-order",
            "-z",
            &skip_arg,
            &limit_arg,
            &format_arg,
        ]),
        LOCAL_TIMEOUT,
    )
    .map_err(|e| format!("커밋 기록을 읽지 못했어요: {e}"))?;
    if !out.success {
        // Fresh repository with no commits yet.
        if !has_head(&repo) {
            return Ok(Vec::new());
        }
        return Err(failure("커밋 기록을 읽지 못했어요", &out));
    }
    Ok(parse_log(&out.stdout))
}

fn parse_commit_files(out: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(out);
    let mut parts = text.split('\0');
    let mut files = Vec::new();
    while let Some(raw_status) = parts.next() {
        let raw_status = raw_status.trim_start_matches(['\n', '\r']);
        if raw_status.is_empty() {
            continue;
        }
        let Some(first) = raw_status.chars().next() else { continue };
        let status = first.to_string();
        if matches!(first, 'R' | 'C') {
            let Some(orig) = parts.next() else { break };
            let Some(path) = parts.next() else { break };
            if !path.is_empty() {
                files.push(CommitFile {
                    path: path.to_string(),
                    status,
                    orig_path: (!orig.is_empty()).then(|| orig.to_string()),
                });
            }
        } else {
            let Some(path) = parts.next() else { break };
            if !path.is_empty() {
                files.push(CommitFile { path: path.to_string(), status, orig_path: None });
            }
        }
    }
    files
}

/// Files changed by `hash` (against its first parent for merge commits, or the
/// empty tree for the root commit).
pub fn commit_files(root: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    let hash = validate_hash(hash)?;
    let repo = repo(root)?;
    let out = run(
        &repo,
        &["show", "--name-status", "-z", "--format=", "--root", "-m", "--first-parent", hash],
        LOCAL_TIMEOUT,
        "커밋의 변경 파일을 읽지 못했어요",
    )?;
    Ok(parse_commit_files(&out))
}

fn read_commit_blob(repo: &Path, spec: &str) -> BlobContent {
    let Ok(kind_out) = exec(git(repo).args(["cat-file", "-t", spec]), LOCAL_TIMEOUT) else {
        return BlobContent::Missing;
    };
    if !kind_out.success || String::from_utf8_lossy(&kind_out.stdout).trim() != "blob" {
        return BlobContent::Missing;
    }
    let Ok(size_out) = exec(git(repo).args(["cat-file", "-s", spec]), LOCAL_TIMEOUT) else {
        return BlobContent::Missing;
    };
    if !size_out.success {
        return BlobContent::Missing;
    }
    if let Ok(size) = String::from_utf8_lossy(&size_out.stdout).trim().parse::<u64>() {
        if size > MAX_READ_BYTES {
            return BlobContent::Binary;
        }
    }
    let Ok(bytes_out) = exec(git(repo).args(["show", spec]), LOCAL_TIMEOUT) else {
        return BlobContent::Missing;
    };
    if !bytes_out.success {
        return BlobContent::Missing;
    }
    gitdiff::bytes_to_blob(bytes_out.stdout)
}

/// Original (`<first-parent>:path`) and modified (`<hash>:path`) text of a file
/// changed in `hash`. Missing sides return `None`; binary/oversized files set `binary: true`.
pub fn diff_commit_texts(
    root: &str,
    hash: &str,
    path: &str,
    orig_path: Option<&str>,
) -> Result<GitDiffTexts, String> {
    let hash = validate_hash(hash)?;
    let clean_path = clean_single_path(path)?;
    let clean_orig = match orig_path {
        Some(p) if !p.is_empty() => Some(clean_single_path(p)?),
        _ => None,
    };
    let repo = repo(root)?;
    run_text(
        &repo,
        &["rev-parse", "--verify", "-q", &format!("{hash}^{{commit}}")],
        LOCAL_TIMEOUT,
        "커밋을 찾지 못했어요",
    )?;
    let parent = exec(git(&repo).args(["rev-parse", "--verify", "-q", &format!("{hash}^1")]), LOCAL_TIMEOUT)
        .ok()
        .filter(|o| o.success)
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let orig_rel = clean_orig.as_deref().unwrap_or(&clean_path);
    let original = match parent {
        Some(p) => read_commit_blob(&repo, &format!("{p}:{orig_rel}")),
        None => BlobContent::Missing,
    };
    let modified = read_commit_blob(&repo, &format!("{hash}:{clean_path}"));
    Ok(gitdiff::blobs_to_diff_texts(original, modified))
}

/// Cheap fingerprint of HEAD and all refs, used to decide whether commit history
/// needs refreshing when the window regains focus.
pub fn refs_stamp(root: &str) -> Result<String, String> {
    let repo = repo(root)?;
    let head = exec(git(&repo).args(["rev-parse", "--verify", "-q", "HEAD"]), LOCAL_TIMEOUT)
        .ok()
        .filter(|o| o.success)
        .map(|o| o.stdout)
        .unwrap_or_default();
    let refs = exec(
        git(&repo).args(["for-each-ref", "--format=%(HEAD)%(objectname)%(refname)"]),
        LOCAL_TIMEOUT,
    )
    .ok()
    .filter(|o| o.success)
    .map(|o| o.stdout)
    .unwrap_or_default();
    if head.is_empty() && refs.is_empty() {
        return Ok(String::new());
    }
    // 64-bit FNV-1a digest over HEAD + refs.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in head.iter().chain(&[0u8]).chain(&refs) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    Ok(format!("{h:016x}"))
}

pub fn fetch(root: &str) -> Result<(), String> {
    let repo = repo(root)?;
    run(&repo, &["fetch"], LONG_TIMEOUT, "가져오지 못했어요").map(|_| ())
}

pub fn pull(root: &str) -> Result<(), String> {
    let repo = repo(root)?;
    run(&repo, &["pull", "--ff-only"], LONG_TIMEOUT, "끌어오지 못했어요").map(|_| ())
}

/// `origin`, or the only remote there is.
fn default_remote(repo: &Path) -> Result<String, String> {
    let list = run_text(repo, &["remote"], LOCAL_TIMEOUT, "원격 저장소 목록을 읽지 못했어요")?;
    let remotes: Vec<&str> = list.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
    if remotes.contains(&"origin") {
        return Ok("origin".into());
    }
    match remotes.as_slice() {
        [only] => Ok(only.to_string()),
        [] => Err("원격 저장소가 없어요. 먼저 원격 저장소를 추가해 주세요.".into()),
        _ => Err("origin 원격 저장소가 없어서 어디로 올릴지 정할 수 없어요.".into()),
    }
}

/// Push; a branch without an upstream is pushed to `origin` and tracks it.
pub fn push(root: &str) -> Result<(), String> {
    let repo = repo(root)?;
    let st = read_status(&repo)?;
    if st.upstream.is_some() {
        return run(&repo, &["push"], LONG_TIMEOUT, "올리지 못했어요").map(|_| ());
    }
    if st.detached || st.branch.is_empty() {
        return Err("브랜치에 있지 않아서 올릴 수 없어요.".into());
    }
    let remote = default_remote(&repo)?;
    run(&repo, &["push", "-u", &remote, &st.branch], LONG_TIMEOUT, "올리지 못했어요").map(|_| ())
}

pub fn init(root: &str) -> Result<(), String> {
    let dir = Path::new(root);
    if !dir.is_dir() {
        return Err("작업 폴더를 찾을 수 없어요.".into());
    }
    run(dir, &["init"], LOCAL_TIMEOUT, "저장소를 만들지 못했어요").map(|_| ())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("작업 실행에 실패했어요: {e}"))?
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    blocking(move || status(&root)).await
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || stage(&root, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || unstage(&root, &paths)).await
}

#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || discard(&root, &paths)).await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> Result<String, String> {
    blocking(move || commit(&root, &message, amend)).await
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<Branch>, String> {
    blocking(move || branches(&root)).await
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String, create: bool) -> Result<(), String> {
    blocking(move || checkout(&root, &branch, create)).await
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<(), String> {
    blocking(move || fetch(&root)).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<(), String> {
    blocking(move || pull(&root)).await
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<(), String> {
    blocking(move || push(&root)).await
}

#[tauri::command]
pub async fn git_init(root: String) -> Result<(), String> {
    blocking(move || init(&root)).await
}

#[tauri::command]
pub async fn git_log(root: String, skip: Option<u32>, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    blocking(move || log(&root, skip.unwrap_or(0), limit.unwrap_or(DEFAULT_LOG_LIMIT))).await
}

#[tauri::command]
pub async fn git_commit_files(root: String, hash: String) -> Result<Vec<CommitFile>, String> {
    blocking(move || commit_files(&root, &hash)).await
}

#[tauri::command]
pub async fn git_diff_commit_texts(
    root: String,
    hash: String,
    path: String,
    orig_path: Option<String>,
) -> Result<GitDiffTexts, String> {
    blocking(move || diff_commit_texts(&root, &hash, &path, orig_path.as_deref())).await
}

#[tauri::command]
pub async fn git_branch_at(root: String, name: String, hash: String) -> Result<(), String> {
    blocking(move || branch_at(&root, &name, &hash)).await
}

#[tauri::command]
pub async fn git_refs_stamp(root: String) -> Result<String, String> {
    blocking(move || refs_stamp(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success()
    }

    fn sh_ok(dir: &Path, args: &[&str]) {
        assert!(sh(dir, args), "git {args:?}");
    }

    fn sh_text(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn config(dir: &Path) {
        // LF on disk on every platform (GitHub's Windows runners default to autocrlf),
        // and no dependence on the machine's identity or signing setup.
        for (key, value) in
            [("core.autocrlf", "false"), ("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")]
        {
            sh_ok(dir, &["config", key, value]);
        }
    }

    /// An empty repository (no commits).
    fn empty_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh_ok(&dir, &["init", "-q"]);
        config(&dir);
        dir
    }

    /// A repository with one commit of `a.txt`, `b.txt` and `old.txt`.
    fn repo_with_commit(name: &str) -> PathBuf {
        let dir = empty_repo(name);
        write(&dir, "a.txt", "a\n");
        write(&dir, "b.txt", "b\n");
        write(&dir, "old.txt", "old\n");
        sh_ok(&dir, &["add", "."]);
        sh_ok(&dir, &["commit", "-qm", "init"]);
        dir
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(dir: &Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel)).unwrap()
    }

    fn root(dir: &Path) -> &str {
        dir.to_str().unwrap()
    }

    fn file<'a>(st: &'a GitStatus, path: &str) -> &'a StatusFile {
        st.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", st.files))
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn status_reports_staged_modified_untracked_and_renamed() {
        let dir = repo_with_commit("status");
        write(&dir, "a.txt", "a\nmore\n");
        write(&dir, "b.txt", "b\nstaged\n");
        write(&dir, "new file.txt", "new\n");
        write(&dir, "sub/u.txt", "untracked\n");
        sh_ok(&dir, &["add", "b.txt", "new file.txt"]);
        std::fs::create_dir_all(dir.join("dir")).unwrap();
        sh_ok(&dir, &["mv", "old.txt", "dir/renamed.txt"]);

        let st = status(root(&dir)).unwrap();
        assert!(st.repo && st.has_commits && !st.detached);
        assert!(!st.branch.is_empty());
        assert_eq!(st.upstream, None);
        assert_eq!(st.prefix, "");
        assert_eq!((st.ahead, st.behind), (0, 0));

        let a = file(&st, "a.txt");
        assert_eq!((a.index.as_str(), a.worktree.as_str(), a.untracked), ("", "M", false));
        let b = file(&st, "b.txt");
        assert_eq!((b.index.as_str(), b.worktree.as_str()), ("M", ""));
        let n = file(&st, "new file.txt");
        assert_eq!((n.index.as_str(), n.worktree.as_str()), ("A", ""));
        let u = file(&st, "sub/u.txt");
        assert!(u.untracked && !u.conflicted);
        assert_eq!(u.worktree, "?");
        let r = file(&st, "dir/renamed.txt");
        assert_eq!(r.index, "R");
        assert_eq!(r.orig_path.as_deref(), Some("old.txt"));
        assert_eq!(st.files.len(), 5, "{:?}", st.files);

        // A subfolder of the repository reports the same repo-relative paths.
        let sub = status(root(&dir.join("sub"))).unwrap();
        assert_eq!(sub.prefix, "sub/");
        assert_eq!(sub.files.len(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_conflicts() {
        let dir = repo_with_commit("conflict");
        let main = sh_text(&dir, &["branch", "--show-current"]);
        sh_ok(&dir, &["switch", "-q", "-c", "side"]);
        write(&dir, "a.txt", "side\n");
        sh_ok(&dir, &["commit", "-qam", "side"]);
        sh_ok(&dir, &["switch", "-q", &main]);
        write(&dir, "a.txt", "main\n");
        sh_ok(&dir, &["commit", "-qam", "main"]);
        assert!(!sh(&dir, &["merge", "-q", "side"]), "the merge must conflict");

        let st = status(root(&dir)).unwrap();
        let a = file(&st, "a.txt");
        assert!(a.conflicted && !a.untracked);
        assert_eq!((a.index.as_str(), a.worktree.as_str()), ("U", "U"));
        // Git refuses to switch with an unresolved conflict and says why.
        let err = checkout(root(&dir), "side", false).unwrap_err();
        assert!(err.starts_with("브랜치를 바꾸지 못했어요: "), "{err}");
        // Staging the file marks it resolved.
        write(&dir, "a.txt", "resolved\n");
        stage(root(&dir), &paths(&["a.txt"])).unwrap();
        let a = status(root(&dir)).unwrap().files.into_iter().find(|f| f.path == "a.txt").unwrap();
        assert!(!a.conflicted);
        assert_eq!(a.index, "M");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_branch_headers() {
        let raw = b"# branch.oid 0123456789abcdef\0# branch.head (detached)\0# branch.upstream origin/main\0\
# branch.ab +2 -1\0? a b.txt\0";
        let st = parse_status(raw);
        assert!(st.detached && st.has_commits);
        assert_eq!(st.branch, "0123456");
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files[0].path, "a b.txt");

        let fresh = parse_status(b"# branch.oid (initial)\0# branch.head main\0");
        assert!(!fresh.has_commits && !fresh.detached);
        assert_eq!(fresh.branch, "main");
    }

    #[test]
    fn stage_and_unstage() {
        let dir = repo_with_commit("stage");
        write(&dir, "a.txt", "a\nchanged\n");
        write(&dir, "n.txt", "new\n");
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        stage(root(&dir), &paths(&["a.txt", "n.txt", "b.txt"])).unwrap();
        let st = status(root(&dir)).unwrap();
        assert_eq!(file(&st, "a.txt").index, "M");
        assert_eq!(file(&st, "n.txt").index, "A");
        assert_eq!(file(&st, "b.txt").index, "D");

        unstage(root(&dir), &paths(&["a.txt", "n.txt", "b.txt"])).unwrap();
        let st = status(root(&dir)).unwrap();
        assert_eq!((file(&st, "a.txt").index.as_str(), file(&st, "a.txt").worktree.as_str()), ("", "M"));
        assert!(file(&st, "n.txt").untracked);
        assert_eq!(file(&st, "b.txt").worktree, "D");
        assert_eq!(read(&dir, "a.txt"), "a\nchanged\n", "unstaging keeps the edit");

        for bad in ["../outside.txt", "/etc/passwd", "a/../../x", ""] {
            assert!(stage(root(&dir), &paths(&[bad])).is_err(), "{bad}");
            assert!(discard(root(&dir), &paths(&[bad])).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_and_unstage_without_head() {
        let dir = empty_repo("nohead");
        write(&dir, "a.txt", "a\n");
        write(&dir, "sub/b.txt", "b\n");
        stage(root(&dir), &paths(&["a.txt", "sub/b.txt"])).unwrap();
        let st = status(root(&dir)).unwrap();
        assert!(!st.has_commits);
        assert_eq!(file(&st, "a.txt").index, "A");

        unstage(root(&dir), &paths(&["a.txt", "sub/b.txt"])).unwrap();
        let st = status(root(&dir)).unwrap();
        assert!(file(&st, "a.txt").untracked && file(&st, "sub/b.txt").untracked);
        assert!(dir.join("a.txt").exists(), "the file itself stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_restores_tracked_files() {
        let dir = repo_with_commit("discard");
        write(&dir, "a.txt", "a\nedit\n");
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        // A staged edit with a further unstaged edit goes back to the staged version.
        write(&dir, "old.txt", "old\nstaged\n");
        sh_ok(&dir, &["add", "old.txt"]);
        write(&dir, "old.txt", "old\nstaged\nunstaged\n");

        discard(root(&dir), &paths(&["a.txt", "b.txt", "old.txt", "clean-but-unknown.txt"])).unwrap();
        assert_eq!(read(&dir, "a.txt"), "a\n");
        assert_eq!(read(&dir, "b.txt"), "b\n");
        assert_eq!(read(&dir, "old.txt"), "old\nstaged\n");
        let st = status(root(&dir)).unwrap();
        assert_eq!(st.files.len(), 1, "{:?}", st.files);
        assert_eq!((file(&st, "old.txt").index.as_str(), file(&st, "old.txt").worktree.as_str()), ("M", ""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_and_amend() {
        let dir = empty_repo("commit");
        write(&dir, "a.txt", "a\n");
        stage(root(&dir), &paths(&["a.txt"])).unwrap();
        let hash = commit(root(&dir), "first", false).unwrap();
        assert!(!hash.is_empty());
        assert_eq!(hash, sh_text(&dir, &["rev-parse", "--short", "HEAD"]));
        assert!(status(root(&dir)).unwrap().files.is_empty());

        write(&dir, "a.txt", "a\nb\n");
        stage(root(&dir), &paths(&["a.txt"])).unwrap();
        let amended = commit(root(&dir), "second\n\nbody", true).unwrap();
        assert_ne!(amended, hash);
        assert_eq!(sh_text(&dir, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(sh_text(&dir, &["log", "-1", "--format=%B"]), "second\n\nbody");
        assert_eq!(sh_text(&dir, &["show", "HEAD:a.txt"]), "a\nb");

        // Nothing staged: git's own message comes through.
        let err = commit(root(&dir), "empty", false).unwrap_err();
        assert!(err.starts_with("커밋하지 못했어요"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_refuses_empty_message() {
        let dir = repo_with_commit("emptymsg");
        write(&dir, "a.txt", "a\nchanged\n");
        stage(root(&dir), &paths(&["a.txt"])).unwrap();
        for message in ["", "   ", "\n\t\n"] {
            let err = commit(root(&dir), message, false).unwrap_err();
            assert!(err.contains("커밋 메시지"), "{err}");
        }
        assert_eq!(sh_text(&dir, &["rev-list", "--count", "HEAD"]), "1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_and_switch_branches() {
        let dir = repo_with_commit("branch");
        let main = status(root(&dir)).unwrap().branch;
        checkout(root(&dir), "feature/x", true).unwrap();
        assert_eq!(status(root(&dir)).unwrap().branch, "feature/x");
        write(&dir, "a.txt", "feature\n");
        sh_ok(&dir, &["commit", "-qam", "feature"]);

        let list = branches(root(&dir)).unwrap();
        let names: Vec<(&str, bool, bool)> = list.iter().map(|b| (b.name.as_str(), b.current, b.remote)).collect();
        assert!(names.contains(&("feature/x", true, false)), "{names:?}");
        assert!(names.contains(&(main.as_str(), false, false)), "{names:?}");

        checkout(root(&dir), &main, false).unwrap();
        assert_eq!(status(root(&dir)).unwrap().branch, main);
        assert_eq!(read(&dir, "a.txt"), "a\n");

        // Local edits the switch would overwrite: refused with git's message, edit kept.
        write(&dir, "a.txt", "local\n");
        let err = checkout(root(&dir), "feature/x", false).unwrap_err();
        assert!(err.starts_with("브랜치를 바꾸지 못했어요: "), "{err}");
        assert_eq!(read(&dir, "a.txt"), "local\n");
        assert_eq!(status(root(&dir)).unwrap().branch, main);

        for bad in ["", "  ", "-x", "bad..name", "a b"] {
            assert!(checkout(root(&dir), bad, true).is_err(), "{bad:?}");
        }
        assert!(checkout(root(&dir), "no-such-branch", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn push_sets_upstream_then_fetch_and_pull() {
        let dir = repo_with_commit("push");
        let remote = std::env::temp_dir().join(format!("baton-git-push-remote-{}.git", std::process::id()));
        let _ = std::fs::remove_dir_all(&remote);
        sh_ok(&dir, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        assert!(push(root(&dir)).unwrap_err().contains("원격 저장소가 없어요"));
        sh_ok(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);

        push(root(&dir)).unwrap();
        let st = status(root(&dir)).unwrap();
        assert_eq!(st.upstream, Some(format!("origin/{}", st.branch)));
        assert_eq!((st.ahead, st.behind), (0, 0));
        assert!(branches(root(&dir)).unwrap().iter().any(|b| b.remote && b.name == format!("origin/{}", st.branch)));

        write(&dir, "a.txt", "a\nnext\n");
        sh_ok(&dir, &["commit", "-qam", "next"]);
        assert_eq!(status(root(&dir)).unwrap().ahead, 1);
        push(root(&dir)).unwrap();
        fetch(root(&dir)).unwrap();
        pull(root(&dir)).unwrap();
        assert_eq!(status(root(&dir)).unwrap().ahead, 0);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[test]
    fn not_a_repo_until_init() {
        let dir = std::env::temp_dir().join(format!("baton-git-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let st = status(root(&dir)).unwrap();
        assert!(!st.repo && st.files.is_empty());
        assert!(stage(root(&dir), &paths(&["a.txt"])).unwrap_err().contains("git 저장소가 아니에요"));
        init(root(&dir)).unwrap();
        assert!(status(root(&dir)).unwrap().repo);
        assert!(status(root(&dir.join("missing"))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_branch_list() {
        let raw = b"refs/heads/main\0main\0*\0origin/main\nrefs/heads/dev\0dev\0 \0\n\
refs/remotes/origin/HEAD\0origin\0 \0\nrefs/remotes/origin/main\0origin/main\0 \0\n";
        let list = parse_branches(raw);
        assert_eq!(
            list,
            vec![
                Branch { name: "main".into(), current: true, remote: false, upstream: Some("origin/main".into()) },
                Branch { name: "dev".into(), current: false, remote: false, upstream: None },
                Branch { name: "origin/main".into(), current: false, remote: true, upstream: None },
            ]
        );
    }

    #[test]
    fn log_empty_repo_returns_empty() {
        let dir = empty_repo("log-empty");
        assert!(log(root(&dir), 0, 200).unwrap().is_empty());
        assert_eq!(refs_stamp(root(&dir)).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_linear_history_and_pagination() {
        let dir = empty_repo("log-linear");
        let mut hashes = Vec::new();
        for i in 1..=5 {
            write(&dir, "f.txt", &format!("v{i}\n"));
            sh_ok(&dir, &["add", "f.txt"]);
            sh_ok(&dir, &["commit", "-qm", &format!("commit {i}")]);
            hashes.push(sh_text(&dir, &["rev-parse", "HEAD"]));
        }
        sh_ok(&dir, &["tag", "v1.0"]);

        let all = log(root(&dir), 0, 0).unwrap();
        assert_eq!(all.len(), 5);
        // Newest first.
        assert_eq!(all[0].hash, hashes[4]);
        assert_eq!(all[0].subject, "commit 5");
        assert_eq!(all[0].author, "t");
        assert_eq!(all[0].email, "t@t");
        assert!(all[0].time > 0);
        assert_eq!(all[0].parents, vec![hashes[3].clone()]);
        assert!(all[0].refs.iter().any(|r| r.starts_with("HEAD -> ")), "{:?}", all[0].refs);
        assert!(all[0].refs.iter().any(|r| r == "tag: v1.0"), "{:?}", all[0].refs);
        // Root commit has no parents.
        assert_eq!(all[4].hash, hashes[0]);
        assert!(all[4].parents.is_empty());

        // Pagination: skip + limit.
        let page1 = log(root(&dir), 0, 2).unwrap();
        let page2 = log(root(&dir), 2, 2).unwrap();
        let page3 = log(root(&dir), 4, 2).unwrap();
        let page4 = log(root(&dir), 5, 2).unwrap();
        assert_eq!(page1.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["commit 5", "commit 4"]);
        assert_eq!(page2.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["commit 3", "commit 2"]);
        assert_eq!(page3.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["commit 1"]);
        assert!(page4.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_branch_merge_and_commit_files() {
        let dir = repo_with_commit("log-merge");
        let base_hash = sh_text(&dir, &["rev-parse", "HEAD"]);
        let main = sh_text(&dir, &["branch", "--show-current"]);

        // Root commit files (uses --root).
        let root_files = commit_files(root(&dir), &base_hash).unwrap();
        let root_summary: Vec<(&str, &str)> =
            root_files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
        assert_eq!(root_summary, vec![("A", "a.txt"), ("A", "b.txt"), ("A", "old.txt")]);

        // Feature branch: modify a.txt, add feat.txt, delete b.txt, rename old.txt -> moved.txt.
        sh_ok(&dir, &["switch", "-q", "-c", "feat"]);
        write(&dir, "a.txt", "a\nfeat\n");
        write(&dir, "feat.txt", "feat\n");
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        sh_ok(&dir, &["mv", "old.txt", "moved.txt"]);
        sh_ok(&dir, &["add", "-A"]);
        sh_ok(&dir, &["commit", "-qm", "feat work"]);
        let feat_hash = sh_text(&dir, &["rev-parse", "HEAD"]);

        let feat_files = commit_files(root(&dir), &feat_hash).unwrap();
        assert!(feat_files.iter().any(|f| f.path == "a.txt" && f.status == "M"), "{feat_files:?}");
        assert!(feat_files.iter().any(|f| f.path == "feat.txt" && f.status == "A"), "{feat_files:?}");
        assert!(feat_files.iter().any(|f| f.path == "b.txt" && f.status == "D"), "{feat_files:?}");
        assert!(
            feat_files.iter().any(|f| f.path == "moved.txt" && f.status == "R" && f.orig_path.as_deref() == Some("old.txt")),
            "{feat_files:?}"
        );

        // Main branch advances separately, then merges feat (--no-ff).
        sh_ok(&dir, &["switch", "-q", &main]);
        write(&dir, "main.txt", "main\n");
        sh_ok(&dir, &["add", "main.txt"]);
        sh_ok(&dir, &["commit", "-qm", "main work"]);
        let main_hash = sh_text(&dir, &["rev-parse", "HEAD"]);

        sh_ok(&dir, &["merge", "--no-ff", "-qm", "merge feat", "feat"]);
        let merge_hash = sh_text(&dir, &["rev-parse", "HEAD"]);

        // Log contains all 4 commits; merge commit has [main_hash, feat_hash] as parents.
        let commits = log(root(&dir), 0, 200).unwrap();
        assert_eq!(commits.len(), 4);
        assert_eq!(commits[0].hash, merge_hash);
        assert_eq!(commits[0].parents, vec![main_hash.clone(), feat_hash.clone()]);

        // Merge commit files diff against first parent (main): shows feat's changes, not main.txt.
        let merge_files = commit_files(root(&dir), &merge_hash).unwrap();
        assert!(merge_files.iter().any(|f| f.path == "feat.txt" && f.status == "A"), "{merge_files:?}");
        assert!(!merge_files.iter().any(|f| f.path == "main.txt"), "{merge_files:?}");

        // branch_at creates a branch at an older commit and changes refs_stamp.
        let stamp_before = refs_stamp(root(&dir)).unwrap();
        branch_at(root(&dir), "from-base", &base_hash).unwrap();
        let stamp_after = refs_stamp(root(&dir)).unwrap();
        assert_ne!(stamp_before, stamp_after);
        assert_eq!(sh_text(&dir, &["rev-parse", "from-base"]), base_hash);

        // Hash validation rejects bad inputs.
        for bad in ["", "abc", "zzzz", "--all", "1234;rm", &"a".repeat(65)] {
            assert!(commit_files(root(&dir), bad).is_err(), "{bad:?}");
            assert!(branch_at(root(&dir), "ok-name", bad).is_err(), "{bad:?}");
        }
        assert!(branch_at(root(&dir), "-bad", &base_hash).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_commit_texts_handles_root_modify_delete_rename_and_binary() {
        let dir = empty_repo("commit-diff");
        write(&dir, "a.txt", "v1\n");
        write(&dir, "gone.txt", "bye\n");
        write(&dir, "old.txt", "same\n");
        sh_ok(&dir, &["add", "."]);
        sh_ok(&dir, &["commit", "-qm", "root"]);
        let c1 = sh_text(&dir, &["rev-parse", "HEAD"]);

        // Root commit: original is None, modified is Some.
        assert_eq!(
            diff_commit_texts(root(&dir), &c1, "a.txt", None).unwrap(),
            GitDiffTexts { original: None, modified: Some("v1\n".into()), binary: false }
        );

        // Second commit: modify, add, delete, rename, and binary file.
        write(&dir, "a.txt", "v2\n");
        write(&dir, "added.txt", "new\n");
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        sh_ok(&dir, &["mv", "old.txt", "renamed.txt"]);
        write(&dir, "renamed.txt", "same\nmore\n");
        std::fs::write(dir.join("img.bin"), b"bin\0data").unwrap();
        let big = vec![b'x'; (MAX_READ_BYTES as usize) + 1];
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        sh_ok(&dir, &["add", "-A"]);
        sh_ok(&dir, &["commit", "-qm", "second"]);
        let c2 = sh_text(&dir, &["rev-parse", "HEAD"]);

        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "a.txt", None).unwrap(),
            GitDiffTexts { original: Some("v1\n".into()), modified: Some("v2\n".into()), binary: false }
        );
        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "added.txt", None).unwrap(),
            GitDiffTexts { original: None, modified: Some("new\n".into()), binary: false }
        );
        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "gone.txt", None).unwrap(),
            GitDiffTexts { original: Some("bye\n".into()), modified: None, binary: false }
        );
        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "renamed.txt", Some("old.txt")).unwrap(),
            GitDiffTexts {
                original: Some("same\n".into()),
                modified: Some("same\nmore\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "img.bin", None).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );
        assert_eq!(
            diff_commit_texts(root(&dir), &c2, "big.txt", None).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );

        // Short hash works too; invalid hash or path traversal fails.
        let short_c2 = &c2[..7];
        assert_eq!(
            diff_commit_texts(root(&dir), short_c2, "a.txt", None).unwrap().modified.as_deref(),
            Some("v2\n")
        );
        assert!(diff_commit_texts(root(&dir), "bad!", "a.txt", None).is_err());
        assert!(diff_commit_texts(root(&dir), &c2, "../escape.txt", None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
