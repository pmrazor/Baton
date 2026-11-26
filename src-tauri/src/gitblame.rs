//! `git blame` for the code editor's blame gutter.

use std::collections::HashMap;

use serde::Serialize;

use crate::files::{self, FsError};
use crate::gitdiff::repo_relative_path;
use crate::worktree;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// 1-based first line of the hunk.
    pub start_line: u32,
    pub line_count: u32,
    pub hash: String,
    pub author: String,
    /// Unix seconds.
    pub author_time: i64,
    pub summary: String,
    pub is_uncommitted: bool,
}

#[derive(Default, Clone)]
struct Meta {
    author: String,
    author_time: i64,
    summary: String,
}

fn parse_header(line: &str) -> Option<(&str, u32)> {
    let mut it = line.split(' ');
    let hash = it.next()?;
    if hash.len() < 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let _orig = it.next()?.parse::<u32>().ok()?;
    let fin = it.next()?.parse::<u32>().ok()?;
    Some((hash, fin))
}

/// Parse `git blame --porcelain` output into hunks of consecutive same-commit lines.
pub fn parse_porcelain(text: &str) -> Vec<BlameHunk> {
    let mut metas: HashMap<String, Meta> = HashMap::new();
    // (final line, hash) per source line, in output order.
    let mut lines: Vec<(u32, String)> = Vec::new();
    let mut current: Option<String> = None;

    for line in text.lines() {
        if line.starts_with('\t') {
            continue;
        }
        if let Some((hash, fin)) = parse_header(line) {
            metas.entry(hash.to_string()).or_default();
            current = Some(hash.to_string());
            lines.push((fin, hash.to_string()));
            continue;
        }
        let Some(hash) = &current else { continue };
        let meta = metas.entry(hash.clone()).or_default();
        if let Some(v) = line.strip_prefix("author ") {
            meta.author = v.to_string();
        } else if let Some(v) = line.strip_prefix("author-time ") {
            meta.author_time = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("summary ") {
            meta.summary = v.to_string();
        }
    }

    let mut hunks: Vec<BlameHunk> = Vec::new();
    for (fin, hash) in lines {
        if let Some(last) = hunks.last_mut() {
            if last.hash == hash && last.start_line + last.line_count == fin {
                last.line_count += 1;
                continue;
            }
        }
        let meta = metas.get(&hash).cloned().unwrap_or_default();
        hunks.push(BlameHunk {
            start_line: fin,
            line_count: 1,
            is_uncommitted: hash.bytes().all(|b| b == b'0'),
            hash,
            author: meta.author,
            author_time: meta.author_time,
            summary: meta.summary,
        });
    }
    hunks
}

pub fn blame(root: &str, path: &str) -> Result<Vec<BlameHunk>, FsError> {
    let canon_root = files::canonical_root(root)?;
    let segments = files::parse_rel_segments(path, false)?;
    let repo = worktree::repo_root(&canon_root)
        .ok_or_else(|| FsError::invalid_path("git 저장소가 아니에요."))?;
    let canon_repo = std::fs::canonicalize(&repo)
        .map_err(|e| FsError::io(format!("저장소 경로를 확인하지 못했어요: {e}")))?;
    let git_path = repo_relative_path(&canon_repo, &canon_root, &segments)?;

    // Untracked files have no history: nothing to show, and not an error.
    let tracked = worktree::git(&canon_repo)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["ls-files", "--error-unmatch", "--", &git_path])
        .output()
        .map_err(|e| FsError::io(format!("git를 실행하지 못했어요: {e}")))?;
    if !tracked.status.success() {
        return Ok(Vec::new());
    }

    let result = worktree::run(
        worktree::git(&canon_repo)
            .env("GIT_LITERAL_PATHSPECS", "1")
            .args(["blame", "--porcelain", "--", &git_path]),
    );
    match result {
        Ok(bytes) => Ok(parse_porcelain(&String::from_utf8_lossy(&bytes))),
        Err(msg) => {
            let lower = msg.to_lowercase();
            // Newly added (no HEAD yet) or deleted from the working tree.
            if lower.contains("no such path") || lower.contains("no such ref") || lower.contains("bad revision") {
                Ok(Vec::new())
            } else {
                Err(FsError::io(format!("blame 정보를 읽지 못했어요: {msg}")))
            }
        }
    }
}

#[tauri::command]
pub async fn git_blame(root: String, path: String) -> Result<Vec<BlameHunk>, FsError> {
    tokio::task::spawn_blocking(move || blame(&root, &path))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const H1: &str = "1111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222";
    const Z: &str = "0000000000000000000000000000000000000000";

    #[test]
    fn parses_and_merges_porcelain() {
        let text = format!(
            "{H1} 1 1 2\nauthor Ann\nauthor-mail <a@a>\nauthor-time 1700000000\nsummary first\nfilename f\n\tl1\n\
             {H1} 2 2\n\tl2\n\
             {H2} 1 3 1\nauthor Bob\nauthor-time 1700000100\nsummary second: x\nfilename f\n\tl3\n\
             {Z} 4 4 1\nauthor Not Committed Yet\nauthor-time 1700000200\nsummary Version of f from f\nfilename f\n\tl4\n\
             {H1} 3 5\n\tl5\n"
        );
        let h = parse_porcelain(&text);
        assert_eq!(h.len(), 4);
        assert_eq!((h[0].start_line, h[0].line_count, h[0].hash.as_str()), (1, 2, H1));
        assert_eq!(h[0].author, "Ann");
        assert_eq!(h[0].author_time, 1_700_000_000);
        assert_eq!(h[1].summary, "second: x");
        assert!(h[2].is_uncommitted && !h[0].is_uncommitted);
        // Metadata is only printed once per commit; the later hunk reuses it.
        assert_eq!((h[3].start_line, h[3].author.as_str()), (5, "Ann"));
        assert!(parse_porcelain("").is_empty());
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-blame-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        for (k, v) in [("core.autocrlf", "false"), ("user.name", "Tester"), ("user.email", "t@t"), ("commit.gpgsign", "false")] {
            sh(&dir, &["config", k, v]);
        }
        dir
    }

    #[test]
    fn blames_two_commits_and_uncommitted() {
        let dir = repo("two");
        let root = dir.to_str().unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        sh(&dir, &["add", "a.txt"]);
        sh(&dir, &["commit", "-qm", "first"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        sh(&dir, &["commit", "-qam", "second"]);

        let h = blame(root, "a.txt").unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].start_line, h[0].line_count, h[0].summary.as_str()), (1, 2, "first"));
        assert_eq!((h[1].start_line, h[1].line_count, h[1].summary.as_str()), (3, 2, "second"));
        assert_eq!(h[0].author, "Tester");
        assert_ne!(h[0].hash, h[1].hash);

        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        let h = blame(root, "a.txt").unwrap();
        assert!(h.last().unwrap().is_uncommitted);

        std::fs::write(dir.join("new.txt"), "x\n").unwrap();
        assert!(blame(root, "new.txt").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
