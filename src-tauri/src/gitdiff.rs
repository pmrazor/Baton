//! Git diff text retrieval for side-by-side / unified diff tabs in the code editor.
//!
//! Fetches the original and modified versions of a file for either unstaged
//! (index/HEAD vs working tree) or staged (HEAD vs index) comparisons, keeping
//! path validation strictly inside the workspace root.

use std::io::ErrorKind;
use std::path::{Component, Path};

use serde::Serialize;

use crate::files::{self, FsError, MAX_READ_BYTES};
use crate::worktree;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitDiffTexts {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub binary: bool,
}

pub(crate) enum BlobContent {
    Missing,
    Binary,
    Text(String),
}

impl BlobContent {
    pub(crate) fn into_text(self) -> Option<String> {
        match self {
            BlobContent::Text(s) => Some(s),
            BlobContent::Missing | BlobContent::Binary => None,
        }
    }
}

pub(crate) fn bytes_to_blob(bytes: Vec<u8>) -> BlobContent {
    if bytes.len() as u64 > MAX_READ_BYTES || bytes.contains(&0) {
        return BlobContent::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(text) => BlobContent::Text(text),
        Err(_) => BlobContent::Binary,
    }
}

pub(crate) fn blobs_to_diff_texts(original: BlobContent, modified: BlobContent) -> GitDiffTexts {
    if matches!(original, BlobContent::Binary) || matches!(modified, BlobContent::Binary) {
        return GitDiffTexts { original: None, modified: None, binary: true };
    }
    GitDiffTexts {
        original: original.into_text(),
        modified: modified.into_text(),
        binary: false,
    }
}

/// Read a git object (`:path` or `HEAD:path`) as text, detecting missing or binary/oversized blobs.
fn read_git_blob(repo: &Path, spec: &str) -> BlobContent {
    let Ok(kind_bytes) = worktree::run(worktree::git(repo).args(["cat-file", "-t", spec])) else {
        return BlobContent::Missing;
    };
    if String::from_utf8_lossy(&kind_bytes).trim() != "blob" {
        return BlobContent::Missing;
    }
    let Ok(size_bytes) = worktree::run(worktree::git(repo).args(["cat-file", "-s", spec])) else {
        return BlobContent::Missing;
    };
    if let Ok(size) = String::from_utf8_lossy(&size_bytes).trim().parse::<u64>() {
        if size > MAX_READ_BYTES {
            return BlobContent::Binary;
        }
    }
    let Ok(bytes) = worktree::run(worktree::git(repo).args(["show", spec])) else {
        return BlobContent::Missing;
    };
    bytes_to_blob(bytes)
}

/// Read a working-tree file strictly inside `canon_root`, returning `Missing` if deleted.
fn read_worktree_file(canon_root: &Path, segments: &[String]) -> Result<BlobContent, FsError> {
    let raw = files::join_segments(canon_root, segments);
    match std::fs::symlink_metadata(&raw) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(BlobContent::Missing),
        Err(e) => return Err(FsError::io(format!("파일 상태를 확인하지 못했어요: {e}"))),
        Ok(_) => {}
    }

    let canon = match std::fs::canonicalize(&raw) {
        Ok(p) => p,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(BlobContent::Missing),
        Err(e) => return Err(FsError::io(format!("파일 경로를 확인하지 못했어요: {e}"))),
    };
    if !canon.starts_with(canon_root) {
        return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로에는 접근할 수 없어요."));
    }

    let meta = std::fs::metadata(&canon)
        .map_err(|e| FsError::io(format!("파일 정보를 읽지 못했어요: {e}")))?;
    if !meta.is_file() {
        return Err(FsError::invalid_path("파일이 아니에요."));
    }
    if meta.len() > MAX_READ_BYTES {
        return Ok(BlobContent::Binary);
    }

    let bytes = std::fs::read(&canon)
        .map_err(|e| FsError::io(format!("파일을 읽지 못했어요: {e}")))?;
    Ok(bytes_to_blob(bytes))
}

/// Compute the `/`-separated path relative to `canon_repo` for `segments` inside `canon_root`.
pub(crate) fn repo_relative_path(canon_repo: &Path, canon_root: &Path, segments: &[String]) -> Result<String, FsError> {
    let prefix = canon_root
        .strip_prefix(canon_repo)
        .map_err(|_| FsError::invalid_path("작업 폴더가 git 저장소 안에 있지 않아요."))?;
    let mut parts: Vec<String> = Vec::new();
    for comp in prefix.components() {
        if let Component::Normal(os) = comp {
            parts.push(os.to_string_lossy().to_string());
        }
    }
    parts.extend(segments.iter().cloned());
    Ok(parts.join("/"))
}

pub fn diff_texts(root: &str, path: &str, staged: bool) -> Result<GitDiffTexts, FsError> {
    let canon_root = files::canonical_root(root)?;
    let segments = files::parse_rel_segments(path, false)?;
    let repo = worktree::repo_root(&canon_root)
        .ok_or_else(|| FsError::invalid_path("git 저장소가 아니에요."))?;
    let canon_repo = std::fs::canonicalize(&repo)
        .map_err(|e| FsError::io(format!("저장소 경로를 확인하지 못했어요: {e}")))?;
    let git_path = repo_relative_path(&canon_repo, &canon_root, &segments)?;

    let index_spec = format!(":{git_path}");
    let head_spec = format!("HEAD:{git_path}");

    let (original, modified) = if staged {
        let orig = read_git_blob(&canon_repo, &head_spec);
        let modi = read_git_blob(&canon_repo, &index_spec);
        (orig, modi)
    } else {
        let orig = match read_git_blob(&canon_repo, &index_spec) {
            BlobContent::Missing => read_git_blob(&canon_repo, &head_spec),
            other => other,
        };
        let modi = read_worktree_file(&canon_root, &segments)?;
        (orig, modi)
    };

    Ok(blobs_to_diff_texts(original, modified))
}

#[tauri::command]
pub async fn git_diff_texts(root: String, path: String, staged: bool) -> Result<GitDiffTexts, FsError> {
    tokio::task::spawn_blocking(move || diff_texts(&root, &path, staged))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-gitdiff-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        sh(&dir, &["config", "core.autocrlf", "false"]);
        dir
    }

    fn sh(dir: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn commit(dir: &Path, msg: &str) {
        sh(dir, &["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", msg]);
    }

    #[test]
    fn modified_file_and_staged_vs_unstaged() {
        let repo = temp_repo("modified");
        let root = repo.to_str().unwrap();

        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        sh(&repo, &["add", "a.txt"]);
        commit(&repo, "init");

        // Unstaged modification only.
        std::fs::write(repo.join("a.txt"), "v2\n").unwrap();
        assert_eq!(
            diff_texts(root, "a.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("v1\n".into()),
                modified: Some("v2\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_texts(root, "a.txt", true).unwrap(),
            GitDiffTexts {
                original: Some("v1\n".into()),
                modified: Some("v1\n".into()),
                binary: false,
            }
        );

        // Stage v2, then edit worktree to v3 -> HEAD=v1, index=v2, worktree=v3.
        sh(&repo, &["add", "a.txt"]);
        std::fs::write(repo.join("a.txt"), "v3\n").unwrap();

        assert_eq!(
            diff_texts(root, "a.txt", true).unwrap(),
            GitDiffTexts {
                original: Some("v1\n".into()),
                modified: Some("v2\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_texts(root, "a.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("v2\n".into()),
                modified: Some("v3\n".into()),
                binary: false,
            }
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn added_and_untracked_files() {
        let repo = temp_repo("added");
        let root = repo.to_str().unwrap();

        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        sh(&repo, &["add", "base.txt"]);
        commit(&repo, "init");

        // Untracked file.
        std::fs::write(repo.join("untracked.txt"), "hello\n").unwrap();
        assert_eq!(
            diff_texts(root, "untracked.txt", false).unwrap(),
            GitDiffTexts {
                original: None,
                modified: Some("hello\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_texts(root, "untracked.txt", true).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: false }
        );

        // Added (staged) new file, then edited in worktree.
        std::fs::write(repo.join("added.txt"), "staged\n").unwrap();
        sh(&repo, &["add", "added.txt"]);
        assert_eq!(
            diff_texts(root, "added.txt", true).unwrap(),
            GitDiffTexts {
                original: None,
                modified: Some("staged\n".into()),
                binary: false,
            }
        );
        std::fs::write(repo.join("added.txt"), "staged + worktree\n").unwrap();
        assert_eq!(
            diff_texts(root, "added.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("staged\n".into()),
                modified: Some("staged + worktree\n".into()),
                binary: false,
            }
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn deleted_files_worktree_and_staged() {
        let repo = temp_repo("deleted");
        let root = repo.to_str().unwrap();

        std::fs::write(repo.join("del_wt.txt"), "keep in index\n").unwrap();
        std::fs::write(repo.join("del_idx.txt"), "removed from index\n").unwrap();
        sh(&repo, &["add", "."]);
        commit(&repo, "init");

        // Deleted in working tree only.
        std::fs::remove_file(repo.join("del_wt.txt")).unwrap();
        assert_eq!(
            diff_texts(root, "del_wt.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("keep in index\n".into()),
                modified: None,
                binary: false,
            }
        );

        // Deleted in index (`git rm`).
        sh(&repo, &["rm", "-q", "del_idx.txt"]);
        assert_eq!(
            diff_texts(root, "del_idx.txt", true).unwrap(),
            GitDiffTexts {
                original: Some("removed from index\n".into()),
                modified: None,
                binary: false,
            }
        );
        // Unstaged falls back to HEAD when absent from index.
        assert_eq!(
            diff_texts(root, "del_idx.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("removed from index\n".into()),
                modified: None,
                binary: false,
            }
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn repo_without_head() {
        let repo = temp_repo("nohead");
        let root = repo.to_str().unwrap();

        std::fs::write(repo.join("first.txt"), "first\n").unwrap();
        sh(&repo, &["add", "first.txt"]);
        std::fs::write(repo.join("first.txt"), "first edited\n").unwrap();
        std::fs::write(repo.join("loose.txt"), "untracked\n").unwrap();

        assert_eq!(
            diff_texts(root, "first.txt", true).unwrap(),
            GitDiffTexts {
                original: None,
                modified: Some("first\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_texts(root, "first.txt", false).unwrap(),
            GitDiffTexts {
                original: Some("first\n".into()),
                modified: Some("first edited\n".into()),
                binary: false,
            }
        );
        assert_eq!(
            diff_texts(root, "loose.txt", false).unwrap(),
            GitDiffTexts {
                original: None,
                modified: Some("untracked\n".into()),
                binary: false,
            }
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn binary_and_oversized_files() {
        let repo = temp_repo("binary");
        let root = repo.to_str().unwrap();

        std::fs::write(repo.join("img.bin"), b"hello\0world").unwrap();
        sh(&repo, &["add", "img.bin"]);
        commit(&repo, "init");

        // Binary in both HEAD/index and worktree.
        assert_eq!(
            diff_texts(root, "img.bin", false).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );
        assert_eq!(
            diff_texts(root, "img.bin", true).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );

        // Text in HEAD, binary in worktree.
        std::fs::write(repo.join("became.bin"), "plain\n").unwrap();
        sh(&repo, &["add", "became.bin"]);
        commit(&repo, "text");
        std::fs::write(repo.join("became.bin"), b"\x00\x01\x02").unwrap();
        assert_eq!(
            diff_texts(root, "became.bin", false).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );

        // Over 2 MiB in worktree.
        let big = vec![b'a'; (MAX_READ_BYTES as usize) + 1];
        std::fs::write(repo.join("big.txt"), &big).unwrap();
        assert_eq!(
            diff_texts(root, "big.txt", false).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );

        // Over 2 MiB in index.
        sh(&repo, &["add", "big.txt"]);
        assert_eq!(
            diff_texts(root, "big.txt", true).unwrap(),
            GitDiffTexts { original: None, modified: None, binary: true }
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn subfolder_root_and_path_safety() {
        let repo = temp_repo("subfolder");
        let sub = repo.join("packages").join("web");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("app.ts"), "const a = 1;\n").unwrap();
        sh(&repo, &["add", "."]);
        commit(&repo, "init");

        std::fs::write(sub.join("app.ts"), "const a = 2;\n").unwrap();
        let sub_str = sub.to_str().unwrap();

        assert_eq!(
            diff_texts(sub_str, "app.ts", false).unwrap(),
            GitDiffTexts {
                original: Some("const a = 1;\n".into()),
                modified: Some("const a = 2;\n".into()),
                binary: false,
            }
        );

        // Path traversal rejected.
        assert_eq!(diff_texts(sub_str, "../secret.txt", false).unwrap_err().kind, "invalid_path");
        assert_eq!(diff_texts(sub_str, "/etc/passwd", false).unwrap_err().kind, "invalid_path");

        let _ = std::fs::remove_dir_all(&repo);
    }
}
