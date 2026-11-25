//! Workspace file browsing, reading, atomic writing, and stat polling for the
//! built-in file tree and code editor.
//!
//! Every operation resolves paths strictly inside the workspace `root`,
//! rejecting `..`, absolute paths, and symlinks pointing outside `root`.

use std::collections::HashSet;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Maximum text file size the editor will open (2 MiB).
pub(crate) const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Folders always hidden in the tree, even outside a git repository.
const ALWAYS_HIDDEN: &[&str] = &[".git", "node_modules", "target", ".baton"];

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FsEntry {
    pub name: String,
    /// Relative to `root`, always `/`-separated.
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileContent {
    pub text: String,
    /// Modification time in microseconds since the Unix epoch.
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FsError {
    /// Machine-readable category: `invalid_path`, `not_found`, `already_exists`,
    /// `too_large`, `binary`, `conflict`, or `io`.
    pub kind: &'static str,
    pub message: String,
}

impl FsError {
    pub(crate) fn invalid_path(message: impl Into<String>) -> Self {
        Self { kind: "invalid_path", message: message.into() }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self { kind: "not_found", message: message.into() }
    }

    fn already_exists(message: impl Into<String>) -> Self {
        Self { kind: "already_exists", message: message.into() }
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self { kind: "too_large", message: message.into() }
    }

    fn binary(message: impl Into<String>) -> Self {
        Self { kind: "binary", message: message.into() }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self { kind: "conflict", message: message.into() }
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self { kind: "io", message: message.into() }
    }
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

pub(crate) fn canonical_root(root: &str) -> Result<PathBuf, FsError> {
    let p = Path::new(root);
    if !p.is_dir() {
        return Err(FsError::not_found("작업 폴더를 찾을 수 없어요."));
    }
    std::fs::canonicalize(p).map_err(|e| FsError::io(format!("작업 폴더 경로를 확인하지 못했어요: {e}")))
}

/// Validate a path relative to `root` and split it into safe path segments.
pub(crate) fn parse_rel_segments(rel: &str, allow_empty: bool) -> Result<Vec<String>, FsError> {
    if rel.contains('\0') {
        return Err(FsError::invalid_path("올바르지 않은 경로예요."));
    }
    if rel.starts_with('/') || rel.starts_with('\\') || Path::new(rel).is_absolute() {
        return Err(FsError::invalid_path("절대 경로에는 접근할 수 없어요."));
    }
    // Reject Windows drive-letter prefixes (e.g. "C:foo") on every platform.
    let bytes = rel.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(FsError::invalid_path("절대 경로에는 접근할 수 없어요."));
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(FsError::invalid_path("작업 폴더 밖의 경로에는 접근할 수 없어요."));
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    let mut segments = Vec::new();
    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(FsError::invalid_path("작업 폴더 밖의 경로에는 접근할 수 없어요."));
        }
        segments.push(seg.to_string());
    }
    if segments.is_empty() && !allow_empty {
        return Err(FsError::invalid_path("파일 경로가 비어 있어요."));
    }
    Ok(segments)
}

pub(crate) fn join_segments(root: &Path, segments: &[String]) -> PathBuf {
    let mut path = root.to_path_buf();
    for seg in segments {
        path.push(seg);
    }
    path
}

fn resolve_existing(canon_root: &Path, segments: &[String]) -> Result<PathBuf, FsError> {
    let raw = join_segments(canon_root, segments);
    let canon = std::fs::canonicalize(&raw).map_err(|e| match e.kind() {
        ErrorKind::NotFound => FsError::not_found("파일이나 폴더를 찾을 수 없어요."),
        _ => FsError::io(format!("경로를 확인하지 못했어요: {e}")),
    })?;
    if !canon.starts_with(canon_root) {
        return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로에는 접근할 수 없어요."));
    }
    Ok(canon)
}

/// Resolve a path that may not exist yet by validating the deepest existing
/// ancestor with `canonicalize` to prevent symlink escapes outside `canon_root`.
fn resolve_new_target(canon_root: &Path, segments: &[String]) -> Result<PathBuf, FsError> {
    let mut current = canon_root.to_path_buf();
    let mut idx = 0;

    while idx < segments.len() {
        let candidate = current.join(&segments[idx]);
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => {
                let canon = std::fs::canonicalize(&candidate).map_err(|e| match e.kind() {
                    ErrorKind::NotFound => FsError::invalid_path("유효하지 않은 심볼릭 링크 경로예요."),
                    _ => FsError::io(format!("경로를 확인하지 못했어요: {e}")),
                })?;
                if !canon.starts_with(canon_root) {
                    return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로에는 생성할 수 없어요."));
                }
                if idx + 1 < segments.len() && !canon.is_dir() {
                    return Err(FsError::invalid_path("상위 경로가 폴더가 아니에요."));
                }
                current = canon;
                idx += 1;
            }
            Err(e) if e.kind() == ErrorKind::NotFound => break,
            Err(e) => return Err(FsError::io(format!("경로를 확인하지 못했어요: {e}"))),
        }
    }

    for seg in &segments[idx..] {
        current.push(seg);
    }
    Ok(current)
}

fn mtime_us(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_micros() as u64)
}

/// Ask git which of `entries` are ignored under `canon_root`.
fn git_ignored(canon_root: &Path, entries: &[FsEntry]) -> HashSet<String> {
    if entries.is_empty() || crate::worktree::repo_root(canon_root).is_none() {
        return HashSet::new();
    }
    let mut payload = Vec::new();
    for entry in entries {
        payload.extend_from_slice(entry.path.as_bytes());
        if entry.dir {
            payload.push(b'/');
        }
        payload.push(0);
    }

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(canon_root)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut cmd);

    let Ok(mut child) = cmd.spawn() else {
        return HashSet::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }
    let Ok(out) = child.wait_with_output() else {
        return HashSet::new();
    };
    // `git check-ignore` exits 0 when at least one path is ignored, 1 when none are.
    if out.status.code() != Some(0) {
        return HashSet::new();
    }
    out.stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).trim_end_matches('/').to_string())
        .collect()
}

pub fn list_dir(root: &str, dir: &str) -> Result<Vec<FsEntry>, FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(dir, true)?;
    let canon_dir = resolve_existing(&canon_root, &segments)?;
    if !canon_dir.is_dir() {
        return Err(FsError::invalid_path("폴더 경로가 아니에요."));
    }

    let prefix = segments.join("/");
    let read_dir = std::fs::read_dir(&canon_dir)
        .map_err(|e| FsError::io(format!("폴더를 읽지 못했어요: {e}")))?;

    let mut entries = Vec::new();
    for item in read_dir {
        let Ok(entry) = item else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if ALWAYS_HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let is_dir = std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false);
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        entries.push(FsEntry { name, path, dir: is_dir });
    }

    let ignored = git_ignored(&canon_root, &entries);
    if !ignored.is_empty() {
        entries.retain(|e| !ignored.contains(&e.path));
    }

    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

pub fn read_file(root: &str, path: &str) -> Result<FileContent, FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(path, false)?;
    let canon = resolve_existing(&canon_root, &segments)?;
    let meta = std::fs::metadata(&canon)
        .map_err(|e| FsError::io(format!("파일 정보를 읽지 못했어요: {e}")))?;
    if !meta.is_file() {
        return Err(FsError::invalid_path("파일이 아니에요."));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(FsError::too_large("2MB가 넘는 파일은 편집기에서 열 수 없어요."));
    }
    let bytes = std::fs::read(&canon)
        .map_err(|e| FsError::io(format!("파일을 읽지 못했어요: {e}")))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(FsError::too_large("2MB가 넘는 파일은 편집기에서 열 수 없어요."));
    }
    if bytes.contains(&0) {
        return Err(FsError::binary("바이너리 파일은 편집기에서 열 수 없어요."));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| FsError::binary("UTF-8 텍스트 파일이 아니어서 편집기에서 열 수 없어요."))?;
    let mtime = mtime_us(&meta);
    Ok(FileContent { text, mtime })
}

pub fn write_file(root: &str, path: &str, text: &str, expected_mtime: Option<u64>) -> Result<u64, FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(path, false)?;
    let raw = join_segments(&canon_root, &segments);

    let (write_target, existing_perms) = match std::fs::symlink_metadata(&raw) {
        Ok(_) => {
            let canon = std::fs::canonicalize(&raw)
                .map_err(|e| FsError::io(format!("파일 경로를 확인하지 못했어요: {e}")))?;
            if !canon.starts_with(&canon_root) {
                return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로에는 저장할 수 없어요."));
            }
            let meta = std::fs::metadata(&canon)
                .map_err(|e| FsError::io(format!("파일 정보를 읽지 못했어요: {e}")))?;
            if !meta.is_file() {
                return Err(FsError::invalid_path("폴더에는 파일 내용을 저장할 수 없어요."));
            }
            if let Some(expected) = expected_mtime {
                if mtime_us(&meta) != expected {
                    return Err(FsError::conflict("파일이 디스크에서 바뀌었어요."));
                }
            }
            (canon, Some(meta.permissions()))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            if expected_mtime.is_some() {
                return Err(FsError::conflict("파일이 디스크에서 삭제되었거나 바뀌었어요."));
            }
            let parent = raw.parent().ok_or_else(|| FsError::invalid_path("상위 폴더가 없어요."))?;
            let canon_parent = std::fs::canonicalize(parent).map_err(|err| match err.kind() {
                ErrorKind::NotFound => FsError::not_found("상위 폴더를 찾을 수 없어요."),
                _ => FsError::io(format!("상위 폴더를 확인하지 못했어요: {err}")),
            })?;
            if !canon_parent.starts_with(&canon_root) || !canon_parent.is_dir() {
                return Err(FsError::invalid_path("작업 폴더 밖에는 저장할 수 없어요."));
            }
            let file_name = segments.last().ok_or_else(|| FsError::invalid_path("파일 이름이 없어요."))?;
            (canon_parent.join(file_name), None)
        }
        Err(e) => return Err(FsError::io(format!("파일 상태를 확인하지 못했어요: {e}"))),
    };

    let parent = write_target
        .parent()
        .ok_or_else(|| FsError::invalid_path("상위 폴더를 확인할 수 없어요."))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".baton-tmp-{}-{seq}", std::process::id()));

    if let Err(e) = std::fs::write(&tmp, text.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FsError::io(format!("임시 파일을 쓰지 못했어요: {e}")));
    }
    if let Some(perms) = existing_perms {
        let _ = std::fs::set_permissions(&tmp, perms);
    }
    if let Err(e) = std::fs::rename(&tmp, &write_target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(FsError::io(format!("파일을 저장하지 못했어요: {e}")));
    }

    let meta = std::fs::metadata(&write_target)
        .map_err(|e| FsError::io(format!("저장된 파일 정보를 읽지 못했어요: {e}")))?;
    Ok(mtime_us(&meta))
}

pub fn stat_files(root: &str, paths: &[String]) -> Result<Vec<Option<u64>>, FsError> {
    let canon_root = canonical_root(root)?;
    let mut out = Vec::with_capacity(paths.len());
    for rel in paths {
        let segments = parse_rel_segments(rel, false)?;
        let raw = join_segments(&canon_root, &segments);
        match std::fs::symlink_metadata(&raw) {
            Err(e) if e.kind() == ErrorKind::NotFound => out.push(None),
            Err(e) => return Err(FsError::io(format!("파일 상태를 확인하지 못했어요: {e}"))),
            Ok(_) => match std::fs::canonicalize(&raw) {
                Err(e) if e.kind() == ErrorKind::NotFound => out.push(None),
                Err(e) => return Err(FsError::io(format!("파일 경로를 확인하지 못했어요: {e}"))),
                Ok(canon) => {
                    if !canon.starts_with(&canon_root) {
                        return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로에는 접근할 수 없어요."));
                    }
                    match std::fs::metadata(&canon) {
                        Ok(meta) if meta.is_file() => out.push(Some(mtime_us(&meta))),
                        Ok(_) => out.push(None),
                        Err(e) if e.kind() == ErrorKind::NotFound => out.push(None),
                        Err(e) => return Err(FsError::io(format!("파일 정보를 읽지 못했어요: {e}"))),
                    }
                }
            },
        }
    }
    Ok(out)
}

pub fn create_file(root: &str, path: &str) -> Result<(), FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(path, false)?;
    let target = resolve_new_target(&canon_root, &segments)?;
    let name = segments.last().map(String::as_str).unwrap_or(path);

    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(FsError::already_exists(format!("이미 있어요: {name}")));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| FsError::io(format!("상위 폴더를 만들지 못했어요: {e}")))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| match e.kind() {
            ErrorKind::AlreadyExists => FsError::already_exists(format!("이미 있어요: {name}")),
            _ => FsError::io(format!("파일을 만들지 못했어요: {e}")),
        })?;
    Ok(())
}

pub fn create_dir(root: &str, path: &str) -> Result<(), FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(path, false)?;
    let target = resolve_new_target(&canon_root, &segments)?;
    let name = segments.last().map(String::as_str).unwrap_or(path);

    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(FsError::already_exists(format!("이미 있어요: {name}")));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| FsError::io(format!("상위 폴더를 만들지 못했어요: {e}")))?;
    }
    std::fs::create_dir(&target).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => FsError::already_exists(format!("이미 있어요: {name}")),
        _ => FsError::io(format!("폴더를 만들지 못했어요: {e}")),
    })?;
    Ok(())
}

fn entry_exists(path: &Path) -> Result<bool, FsError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(FsError::io(format!("경로를 확인하지 못했어요: {e}"))),
    }
}

fn split_copy_name(name: &str, is_dir: bool) -> (&str, &str) {
    if is_dir {
        return (name, "");
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot < name.len() - 1 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    }
}

fn next_available_copy_name(dir: &Path, name: &str, is_dir: bool) -> Result<String, FsError> {
    if !entry_exists(&dir.join(name))? {
        return Ok(name.to_string());
    }
    let (stem, ext) = split_copy_name(name, is_dir);
    let first = format!("{stem} copy{ext}");
    if !entry_exists(&dir.join(&first))? {
        return Ok(first);
    }
    let mut n: u64 = 2;
    loop {
        let candidate = format!("{stem} copy {n}{ext}");
        if !entry_exists(&dir.join(&candidate))? {
            return Ok(candidate);
        }
        n += 1;
    }
}

pub fn rename_entry(root: &str, from: &str, to: &str) -> Result<(), FsError> {
    let canon_root = canonical_root(root)?;
    let from_segs = parse_rel_segments(from, false)?;
    let to_segs = parse_rel_segments(to, false)?;

    let from_canon = resolve_existing(&canon_root, &from_segs)?;
    if from_canon == canon_root {
        return Err(FsError::invalid_path("작업 폴더 자체는 옮기거나 이름을 바꿀 수 없어요."));
    }
    let from_parent_canon = resolve_existing(&canon_root, &from_segs[..from_segs.len() - 1])?;
    let from_name = from_segs.last().expect("non-empty segments");
    let from_path = from_parent_canon.join(from_name);

    let to_parent_segs = &to_segs[..to_segs.len() - 1];
    let to_name = to_segs.last().expect("non-empty segments");
    let to_parent = resolve_new_target(&canon_root, to_parent_segs)?;
    if entry_exists(&to_parent)? && !to_parent.is_dir() {
        return Err(FsError::invalid_path("상위 경로가 폴더가 아니에요."));
    }
    let to_path = to_parent.join(to_name);

    if from_canon.is_dir()
        && (to_parent.starts_with(&from_canon) || (to_path == from_canon && from_name == to_name))
    {
        return Err(FsError::invalid_path("폴더를 자기 자신이나 하위 폴더로 옮길 수 없어요."));
    }

    if entry_exists(&to_path)? {
        let same_entry_case_change = from_parent_canon == to_parent
            && from_name != to_name
            && std::fs::canonicalize(&to_path).ok().as_deref() == Some(from_canon.as_path());
        if !same_entry_case_change {
            return Err(FsError::already_exists(format!("이미 있어요: {to_name}")));
        }
    }

    if !to_parent.exists() {
        std::fs::create_dir_all(&to_parent)
            .map_err(|e| FsError::io(format!("상위 폴더를 만들지 못했어요: {e}")))?;
    }

    std::fs::rename(&from_path, &to_path)
        .map_err(|e| FsError::io(format!("이름을 바꾸거나 옮기지 못했어요: {e}")))?;
    Ok(())
}

fn copy_dir_recursive(
    canon_root: &Path,
    src_dir: &Path,
    dst_dir: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<(), FsError> {
    let canon_src = std::fs::canonicalize(src_dir)
        .map_err(|e| FsError::io(format!("폴더 경로를 확인하지 못했어요: {e}")))?;
    if !canon_src.starts_with(canon_root) {
        return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로는 복사할 수 없어요."));
    }
    if !visited.insert(canon_src.clone()) {
        return Err(FsError::invalid_path("순환하는 심볼릭 링크가 있어 복사할 수 없어요."));
    }

    std::fs::create_dir(dst_dir)
        .map_err(|e| FsError::io(format!("폴더를 만들지 못했어요: {e}")))?;

    let entries = std::fs::read_dir(&canon_src)
        .map_err(|e| FsError::io(format!("폴더를 읽지 못했어요: {e}")))?;
    for item in entries {
        let entry = item.map_err(|e| FsError::io(format!("항목을 읽지 못했어요: {e}")))?;
        let child_src = entry.path();
        let child_dst = dst_dir.join(entry.file_name());
        let child_canon = std::fs::canonicalize(&child_src).map_err(|e| match e.kind() {
            ErrorKind::NotFound => FsError::invalid_path("유효하지 않은 심볼릭 링크 경로예요."),
            _ => FsError::io(format!("경로를 확인하지 못했어요: {e}")),
        })?;
        if !child_canon.starts_with(canon_root) {
            return Err(FsError::invalid_path("작업 폴더 밖을 가리키는 경로는 복사할 수 없어요."));
        }
        if child_canon.is_dir() {
            copy_dir_recursive(canon_root, &child_canon, &child_dst, visited)?;
        } else {
            std::fs::copy(&child_canon, &child_dst)
                .map_err(|e| FsError::io(format!("파일을 복사하지 못했어요: {e}")))?;
        }
    }

    visited.remove(&canon_src);
    Ok(())
}

pub fn copy_entry(root: &str, from: &str, to_dir: &str) -> Result<String, FsError> {
    let canon_root = canonical_root(root)?;
    let from_segs = parse_rel_segments(from, false)?;
    let from_canon = resolve_existing(&canon_root, &from_segs)?;
    if from_canon == canon_root {
        return Err(FsError::invalid_path("작업 폴더 자체는 복사할 수 없어요."));
    }
    let to_dir_segs = parse_rel_segments(to_dir, true)?;
    let to_dir_canon = resolve_existing(&canon_root, &to_dir_segs)?;
    if !to_dir_canon.is_dir() {
        return Err(FsError::invalid_path("대상 경로가 폴더가 아니에요."));
    }
    if from_canon.is_dir() && to_dir_canon.starts_with(&from_canon) {
        return Err(FsError::invalid_path("폴더를 자기 자신이나 하위 폴더로 복사할 수 없어요."));
    }

    let orig_name = from_segs.last().expect("non-empty segments");
    let is_dir = from_canon.is_dir();
    let dest_name = next_available_copy_name(&to_dir_canon, orig_name, is_dir)?;
    let dest_path = to_dir_canon.join(&dest_name);

    if is_dir {
        let mut visited = HashSet::new();
        copy_dir_recursive(&canon_root, &from_canon, &dest_path, &mut visited)?;
    } else {
        std::fs::copy(&from_canon, &dest_path)
            .map_err(|e| FsError::io(format!("파일을 복사하지 못했어요: {e}")))?;
    }

    let rel = if to_dir_segs.is_empty() {
        dest_name
    } else {
        format!("{}/{dest_name}", to_dir_segs.join("/"))
    };
    Ok(rel)
}

fn validate_trash_target(root: &str, path: &str) -> Result<PathBuf, FsError> {
    let canon_root = canonical_root(root)?;
    let segments = parse_rel_segments(path, true)?;
    if segments.is_empty() {
        return Err(FsError::invalid_path("작업 폴더 자체는 삭제할 수 없어요."));
    }
    let canon = resolve_existing(&canon_root, &segments)?;
    if canon == canon_root {
        return Err(FsError::invalid_path("작업 폴더 자체는 삭제할 수 없어요."));
    }
    let parent_canon = resolve_existing(&canon_root, &segments[..segments.len() - 1])?;
    let name = segments.last().expect("non-empty segments");
    Ok(parent_canon.join(name))
}

pub fn trash_entry(root: &str, path: &str) -> Result<(), FsError> {
    let target = validate_trash_target(root, path)?;
    trash::delete(&target).map_err(|e| FsError::io(format!("휴지통으로 옮기지 못했어요: {e}")))
}

#[tauri::command]
pub async fn fs_list(root: String, dir: String) -> Result<Vec<FsEntry>, FsError> {
    tokio::task::spawn_blocking(move || list_dir(&root, &dir))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_read(root: String, path: String) -> Result<FileContent, FsError> {
    tokio::task::spawn_blocking(move || read_file(&root, &path))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_write(
    root: String,
    path: String,
    text: String,
    expected_mtime: Option<u64>,
) -> Result<u64, FsError> {
    tokio::task::spawn_blocking(move || write_file(&root, &path, &text, expected_mtime))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_stat(root: String, paths: Vec<String>) -> Result<Vec<Option<u64>>, FsError> {
    tokio::task::spawn_blocking(move || stat_files(&root, &paths))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_create_file(root: String, path: String) -> Result<(), FsError> {
    tokio::task::spawn_blocking(move || create_file(&root, &path))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_create_dir(root: String, path: String) -> Result<(), FsError> {
    tokio::task::spawn_blocking(move || create_dir(&root, &path))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_rename(root: String, from: String, to: String) -> Result<(), FsError> {
    tokio::task::spawn_blocking(move || rename_entry(&root, &from, &to))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_copy(root: String, from: String, to_dir: String) -> Result<String, FsError> {
    tokio::task::spawn_blocking(move || copy_entry(&root, &from, &to_dir))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[tauri::command]
pub async fn fs_trash(root: String, path: String) -> Result<(), FsError> {
    tokio::task::spawn_blocking(move || trash_entry(&root, &path))
        .await
        .map_err(|e| FsError::io(format!("작업 실행에 실패했어요: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    #[test]
    fn rejects_path_escapes_and_absolute_paths() {
        let base = temp_workspace("escape");
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "top secret").unwrap();
        std::fs::write(root.join("ok.txt"), "hello").unwrap();

        let root_str = root.to_str().unwrap();

        for bad in [
            "..",
            "../outside/secret.txt",
            "sub/../../outside/secret.txt",
            "/etc/passwd",
            "\\etc\\passwd",
            "C:\\Windows\\win.ini",
        ] {
            assert_eq!(list_dir(root_str, bad).unwrap_err().kind, "invalid_path", "list {bad}");
            assert_eq!(read_file(root_str, bad).unwrap_err().kind, "invalid_path", "read {bad}");
            assert_eq!(write_file(root_str, bad, "x", None).unwrap_err().kind, "invalid_path", "write {bad}");
            assert_eq!(
                stat_files(root_str, &[bad.to_string()]).unwrap_err().kind,
                "invalid_path",
                "stat {bad}"
            );
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link-file")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link-dir")).unwrap();

            assert_eq!(read_file(root_str, "link-file").unwrap_err().kind, "invalid_path");
            assert_eq!(write_file(root_str, "link-file", "x", None).unwrap_err().kind, "invalid_path");
            assert_eq!(
                stat_files(root_str, &["link-file".to_string()]).unwrap_err().kind,
                "invalid_path"
            );
            assert_eq!(list_dir(root_str, "link-dir").unwrap_err().kind, "invalid_path");
            assert_eq!(read_file(root_str, "link-dir/secret.txt").unwrap_err().kind, "invalid_path");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lists_sorted_and_hides_ignored_and_builtin_dirs() {
        // Non-git folder: hides .git, node_modules, target, .baton; keeps dotfiles.
        let plain = temp_workspace("list-plain");
        for d in [".git", "node_modules", "target", ".baton", "Beta", "alpha"] {
            std::fs::create_dir_all(plain.join(d)).unwrap();
        }
        std::fs::write(plain.join("b.txt"), "b").unwrap();
        std::fs::write(plain.join("A.txt"), "a").unwrap();
        std::fs::write(plain.join(".env"), "KEY=1").unwrap();

        let entries = list_dir(plain.to_str().unwrap(), "").unwrap();
        let names: Vec<(&str, bool)> = entries.iter().map(|e| (e.name.as_str(), e.dir)).collect();
        assert_eq!(
            names,
            vec![
                ("alpha", true),
                ("Beta", true),
                (".env", false),
                ("A.txt", false),
                ("b.txt", false),
            ]
        );
        let _ = std::fs::remove_dir_all(&plain);

        // Git repo: also respects .gitignore.
        let repo = temp_workspace("list-git");
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join(".gitignore"), "*.log\ndist/\n.secret\n").unwrap();
        std::fs::create_dir_all(repo.join("dist")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("debug.log"), "x").unwrap();
        std::fs::write(repo.join(".secret"), "x").unwrap();
        std::fs::write(repo.join(".env"), "ok").unwrap();
        std::fs::write(repo.join("src/main.rs"), "fn main() {}\n").unwrap();

        let root_entries = list_dir(repo.to_str().unwrap(), "").unwrap();
        let root_names: Vec<&str> = root_entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(root_names, vec!["src", ".env", ".gitignore"]);

        let sub_entries = list_dir(repo.to_str().unwrap(), "src").unwrap();
        assert_eq!(sub_entries.len(), 1);
        assert_eq!(sub_entries[0].path, "src/main.rs");
        assert!(!sub_entries[0].dir);

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn enforces_read_limits_and_preserves_line_endings() {
        let root = temp_workspace("read");
        let root_str = root.to_str().unwrap();

        // CRLF + LF preserved verbatim.
        std::fs::write(root.join("crlf.txt"), "one\r\ntwo\nthree\r\n").unwrap();
        let content = read_file(root_str, "crlf.txt").unwrap();
        assert_eq!(content.text, "one\r\ntwo\nthree\r\n");
        assert!(content.mtime > 0);

        // Over 2 MiB rejected.
        let big = vec![b'a'; (MAX_READ_BYTES as usize) + 1];
        std::fs::write(root.join("big.txt"), &big).unwrap();
        assert_eq!(read_file(root_str, "big.txt").unwrap_err().kind, "too_large");

        // NUL byte rejected as binary.
        std::fs::write(root.join("nul.bin"), b"hello\0world").unwrap();
        assert_eq!(read_file(root_str, "nul.bin").unwrap_err().kind, "binary");

        // Invalid UTF-8 rejected as binary.
        std::fs::write(root.join("bad.utf8"), [0xff, 0xfe, 0x80]).unwrap();
        assert_eq!(read_file(root_str, "bad.utf8").unwrap_err().kind, "binary");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_checks_mtime_conflict_and_stat_reports_missing() {
        let root = temp_workspace("write");
        let root_str = root.to_str().unwrap();
        std::fs::write(root.join("note.txt"), "v1\n").unwrap();

        let initial = read_file(root_str, "note.txt").unwrap();

        // Wrong expected_mtime is rejected without touching the file.
        let err = write_file(root_str, "note.txt", "stale\n", Some(initial.mtime.saturating_sub(1))).unwrap_err();
        assert_eq!(err.kind, "conflict");
        assert_eq!(std::fs::read_to_string(root.join("note.txt")).unwrap(), "v1\n");

        // Matching expected_mtime writes atomically and returns the new mtime.
        let new_mtime = write_file(root_str, "note.txt", "v2\r\n", Some(initial.mtime)).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("note.txt")).unwrap(), "v2\r\n");
        assert!(new_mtime > 0);

        // fs_stat returns mtime for existing files and None for missing files.
        let stats = stat_files(root_str, &["note.txt".into(), "missing.txt".into()]).unwrap();
        assert_eq!(stats, vec![Some(new_mtime), None]);

        // Unconditional write (None) overwrites cleanly.
        let forced = write_file(root_str, "note.txt", "v3\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("note.txt")).unwrap(), "v3\n");
        assert!(forced > 0);

        // No stray temp files left behind.
        let leftover: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".baton-tmp-"))
            .collect();
        assert!(leftover.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_files_and_dirs_and_rejects_duplicates() {
        let root = temp_workspace("create");
        let root_str = root.to_str().unwrap();

        // Create a top-level file and a nested file (missing parents created).
        create_file(root_str, "hello.txt").unwrap();
        assert!(root.join("hello.txt").is_file());

        create_file(root_str, "src/utils/helper.ts").unwrap();
        assert!(root.join("src/utils/helper.ts").is_file());

        // Creating an existing file fails with already_exists.
        let err = create_file(root_str, "hello.txt").unwrap_err();
        assert_eq!(err.kind, "already_exists");
        assert_eq!(err.message, "이미 있어요: hello.txt");

        // Create a top-level folder and a nested folder.
        create_dir(root_str, "docs").unwrap();
        assert!(root.join("docs").is_dir());

        create_dir(root_str, "a/b/c").unwrap();
        assert!(root.join("a/b/c").is_dir());

        // Creating an existing folder fails with already_exists.
        let err = create_dir(root_str, "docs").unwrap_err();
        assert_eq!(err.kind, "already_exists");
        assert_eq!(err.message, "이미 있어요: docs");

        // Creating a file where a folder exists (and vice versa) also fails with already_exists.
        assert_eq!(create_file(root_str, "docs").unwrap_err().kind, "already_exists");
        assert_eq!(create_dir(root_str, "hello.txt").unwrap_err().kind, "already_exists");

        // Creating inside an existing file fails as invalid_path.
        assert_eq!(create_file(root_str, "hello.txt/child.txt").unwrap_err().kind, "invalid_path");
        assert_eq!(create_dir(root_str, "hello.txt/sub").unwrap_err().kind, "invalid_path");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_rejects_escapes_absolute_paths_and_symlink_parents() {
        let base = temp_workspace("create-escape");
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let root_str = root.to_str().unwrap();

        for bad in [
            "../x",
            "sub/../../x",
            "/tmp/baton-abs-test",
            "\\etc\\evil",
            "C:\\Windows\\evil.txt",
            "",
            ".",
        ] {
            assert_eq!(create_file(root_str, bad).unwrap_err().kind, "invalid_path", "create_file {bad}");
            assert_eq!(create_dir(root_str, bad).unwrap_err().kind, "invalid_path", "create_dir {bad}");
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link-dir")).unwrap();

            assert_eq!(create_file(root_str, "link-dir/escape.txt").unwrap_err().kind, "invalid_path");
            assert_eq!(
                create_file(root_str, "link-dir/nested/escape.txt").unwrap_err().kind,
                "invalid_path"
            );
            assert_eq!(create_dir(root_str, "link-dir/escape-dir").unwrap_err().kind, "invalid_path");
            assert_eq!(
                create_dir(root_str, "link-dir/nested/escape-dir").unwrap_err().kind,
                "invalid_path"
            );
            assert!(!outside.join("escape.txt").exists());
            assert!(!outside.join("nested").exists());
            assert!(!outside.join("escape-dir").exists());
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn renames_and_moves_files_and_folders() {
        let root = temp_workspace("rename");
        let root_str = root.to_str().unwrap();

        std::fs::write(root.join("a.txt"), "alpha").unwrap();
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::write(root.join("src/nested/mod.rs"), "pub fn f() {}").unwrap();
        std::fs::create_dir_all(root.join("dest")).unwrap();

        // Rename file in place.
        rename_entry(root_str, "a.txt", "b.txt").unwrap();
        assert!(!root.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "alpha");

        // Move file into another folder.
        rename_entry(root_str, "b.txt", "dest/b.txt").unwrap();
        assert!(!root.join("b.txt").exists());
        assert_eq!(std::fs::read_to_string(root.join("dest/b.txt")).unwrap(), "alpha");

        // Rename folder in place.
        rename_entry(root_str, "src", "lib").unwrap();
        assert!(!root.join("src").exists());
        assert_eq!(std::fs::read_to_string(root.join("lib/nested/mod.rs")).unwrap(), "pub fn f() {}");

        // Move folder into another folder.
        rename_entry(root_str, "lib", "dest/lib").unwrap();
        assert!(!root.join("lib").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("dest/lib/nested/mod.rs")).unwrap(),
            "pub fn f() {}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_rejects_existing_target_and_moving_folder_into_self() {
        let root = temp_workspace("rename-err");
        let root_str = root.to_str().unwrap();

        std::fs::write(root.join("one.txt"), "1").unwrap();
        std::fs::write(root.join("two.txt"), "2").unwrap();
        std::fs::create_dir_all(root.join("folder/sub")).unwrap();
        std::fs::write(root.join("folder/sub/file.txt"), "x").unwrap();

        // Target already exists.
        let err = rename_entry(root_str, "one.txt", "two.txt").unwrap_err();
        assert_eq!(err.kind, "already_exists");
        assert_eq!(err.message, "이미 있어요: two.txt");
        assert_eq!(std::fs::read_to_string(root.join("one.txt")).unwrap(), "1");
        assert_eq!(std::fs::read_to_string(root.join("two.txt")).unwrap(), "2");

        // Moving folder into itself or its own descendant is rejected.
        assert_eq!(rename_entry(root_str, "folder", "folder").unwrap_err().kind, "invalid_path");
        assert_eq!(rename_entry(root_str, "folder", "folder/folder").unwrap_err().kind, "invalid_path");
        assert_eq!(
            rename_entry(root_str, "folder", "folder/sub/moved").unwrap_err().kind,
            "invalid_path"
        );
        assert_eq!(
            rename_entry(root_str, "folder", "folder/new-sub/moved").unwrap_err().kind,
            "invalid_path"
        );
        assert!(root.join("folder/sub/file.txt").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copies_files_and_folders_with_copy_naming() {
        let root = temp_workspace("copy");
        let root_str = root.to_str().unwrap();

        std::fs::write(root.join("note.txt"), "hello").unwrap();
        std::fs::write(root.join("README"), "readme").unwrap();
        std::fs::write(root.join(".env"), "KEY=1").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("pkg/inner")).unwrap();
        std::fs::write(root.join("pkg/a.rs"), "fn a() {}").unwrap();
        std::fs::write(root.join("pkg/inner/b.rs"), "fn b() {}").unwrap();

        // Copy into a folder without clash preserves original name.
        assert_eq!(copy_entry(root_str, "note.txt", "sub").unwrap(), "sub/note.txt");
        assert_eq!(std::fs::read_to_string(root.join("sub/note.txt")).unwrap(), "hello");

        // Name clashes use "name copy.ext", then "name copy 2.ext", and so on.
        assert_eq!(copy_entry(root_str, "note.txt", "").unwrap(), "note copy.txt");
        assert_eq!(copy_entry(root_str, "note.txt", "").unwrap(), "note copy 2.txt");
        assert_eq!(copy_entry(root_str, "note.txt", "").unwrap(), "note copy 3.txt");
        assert_eq!(std::fs::read_to_string(root.join("note copy 2.txt")).unwrap(), "hello");

        // Extensionless files and dotfiles.
        assert_eq!(copy_entry(root_str, "README", "").unwrap(), "README copy");
        assert_eq!(copy_entry(root_str, ".env", "").unwrap(), ".env copy");

        // Recursive folder copy with clash naming.
        assert_eq!(copy_entry(root_str, "pkg", "").unwrap(), "pkg copy");
        assert_eq!(copy_entry(root_str, "pkg", "").unwrap(), "pkg copy 2");
        assert_eq!(std::fs::read_to_string(root.join("pkg copy/a.rs")).unwrap(), "fn a() {}");
        assert_eq!(
            std::fs::read_to_string(root.join("pkg copy 2/inner/b.rs")).unwrap(),
            "fn b() {}"
        );

        // Copying a folder into itself or its descendant is rejected.
        assert_eq!(copy_entry(root_str, "pkg", "pkg").unwrap_err().kind, "invalid_path");
        assert_eq!(copy_entry(root_str, "pkg", "pkg/inner").unwrap_err().kind, "invalid_path");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_refuses_root_and_escapes_and_ops_reject_escapes() {
        let base = temp_workspace("ops-escape");
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("ok.txt"), "ok").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();

        let root_str = root.to_str().unwrap();

        // Refusing to trash the root itself.
        for root_path in ["", ".", "./"] {
            assert_eq!(
                trash_entry(root_str, root_path).unwrap_err().kind,
                "invalid_path",
                "trash root {root_path}"
            );
        }

        // Valid target passes trash validation (without touching OS trash in CI).
        let validated = validate_trash_target(root_str, "ok.txt").unwrap();
        assert_eq!(validated, std::fs::canonicalize(root.join("ok.txt")).unwrap());

        // Missing target fails with not_found.
        assert_eq!(validate_trash_target(root_str, "missing.txt").unwrap_err().kind, "not_found");

        // Path escapes rejected across rename, copy, and trash.
        for bad in [
            "..",
            "../outside/secret.txt",
            "sub/../../outside/secret.txt",
            "/etc/passwd",
            "\\etc\\passwd",
            "C:\\Windows\\win.ini",
        ] {
            assert_eq!(rename_entry(root_str, bad, "x.txt").unwrap_err().kind, "invalid_path");
            assert_eq!(rename_entry(root_str, "ok.txt", bad).unwrap_err().kind, "invalid_path");
            assert_eq!(copy_entry(root_str, bad, "").unwrap_err().kind, "invalid_path");
            assert_eq!(copy_entry(root_str, "ok.txt", bad).unwrap_err().kind, "invalid_path");
            assert_eq!(trash_entry(root_str, bad).unwrap_err().kind, "invalid_path");
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link-file")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link-dir")).unwrap();
            std::os::unix::fs::symlink(&root, root.join("link-root")).unwrap();

            assert_eq!(rename_entry(root_str, "link-file", "moved.txt").unwrap_err().kind, "invalid_path");
            assert_eq!(
                rename_entry(root_str, "ok.txt", "link-dir/moved.txt").unwrap_err().kind,
                "invalid_path"
            );
            assert_eq!(copy_entry(root_str, "link-file", "").unwrap_err().kind, "invalid_path");
            assert_eq!(copy_entry(root_str, "ok.txt", "link-dir").unwrap_err().kind, "invalid_path");
            assert_eq!(trash_entry(root_str, "link-file").unwrap_err().kind, "invalid_path");
            assert_eq!(trash_entry(root_str, "link-dir/secret.txt").unwrap_err().kind, "invalid_path");
            assert_eq!(trash_entry(root_str, "link-root").unwrap_err().kind, "invalid_path");
            assert!(!outside.join("moved.txt").exists());
            assert!(!outside.join("ok.txt").exists());
        }

        let _ = std::fs::remove_dir_all(&base);
    }
}
