//! Downloadable extensions (phase 1: data only). A registry is a folder with an `index.json`; each
//! extension lives in `<registry>/<id>/…` and is verified (size + sha256) before it is installed into
//! `<app data dir>/extensions/<id>/`. Install state lives in `<app data dir>/extensions/state.json`.

use crate::files::FsError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const MAX_INDEX_BYTES: usize = 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MANIFEST_FILE: &str = "extension.json";
const STATE_FILE: &str = "state.json";

/// Serializes read-modify-write of `state.json`.
static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baton: Option<String>,
    /// Kind -> entries. Unknown kinds are kept verbatim.
    #[serde(default)]
    pub contributes: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baton: Option<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    pub files: Vec<RegistryFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub extensions: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    pub manifest: ExtensionManifest,
    pub enabled: bool,
    pub installed_at: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateEntry {
    enabled: bool,
    installed_at: u64,
    source: String,
}

type State = BTreeMap<String, StateEntry>;

// ---------- validation helpers ----------

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn check_id(id: &str) -> Result<(), FsError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(FsError::invalid_path("올바르지 않은 확장 id예요."))
    }
}

/// `/`-separated relative path without empty, `.`/`..` segments, backslashes or absolute forms.
pub(crate) fn valid_rel_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 256 || path.contains('\\') || path.contains('\0') || path.starts_with('/') {
        return false;
    }
    // Windows drive letters ("C:").
    if path.split('/').next().is_some_and(|s| s.contains(':')) {
        return false;
    }
    path.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

fn check_rel_path(path: &str) -> Result<(), FsError> {
    if valid_rel_path(path) {
        Ok(())
    } else {
        Err(FsError::invalid_path(format!("올바르지 않은 파일 경로예요: {path}")))
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `x.y.z` (missing parts are 0, a `-suffix` / `+build` is ignored).
pub(crate) fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut next = || -> Option<u64> {
        match parts.next() {
            Some(p) => p.parse().ok(),
            None => Some(0),
        }
    };
    let out = (next()?, next()?, next()?);
    if parts.next().is_some() {
        return None;
    }
    Some(out)
}

/// True when `required` is newer than `current` (unparseable values never block).
pub(crate) fn needs_newer_app(required: &str, current: &str) -> bool {
    match (parse_version(required), parse_version(current)) {
        (Some(r), Some(c)) => r > c,
        _ => false,
    }
}

fn check_app_version(baton: Option<&str>, app_version: &str) -> Result<(), FsError> {
    if let Some(req) = baton {
        if needs_newer_app(req, app_version) {
            return Err(FsError::invalid_path(format!("이 확장은 Baton {req} 이상이 필요해요.")));
        }
    }
    Ok(())
}

fn validate_entry(entry: &RegistryEntry) -> Result<(), FsError> {
    check_id(&entry.id)?;
    if entry.files.is_empty() || entry.files.len() > MAX_FILES {
        return Err(FsError::invalid_path("확장 파일 개수가 올바르지 않아요."));
    }
    let mut total = 0u64;
    let mut has_manifest = false;
    for (i, f) in entry.files.iter().enumerate() {
        check_rel_path(&f.path)?;
        if f.size > MAX_FILE_BYTES {
            return Err(FsError::invalid_path(format!("파일이 너무 커요: {}", f.path)));
        }
        if f.sha256.len() != 64 || !f.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(FsError::invalid_path(format!("sha256 형식이 올바르지 않아요: {}", f.path)));
        }
        if entry.files[..i].iter().any(|o| o.path == f.path) {
            return Err(FsError::invalid_path(format!("중복된 파일이에요: {}", f.path)));
        }
        total += f.size;
        has_manifest |= f.path == MANIFEST_FILE;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(FsError::invalid_path("확장 전체 크기가 너무 커요."));
    }
    if !has_manifest {
        return Err(FsError::invalid_path("extension.json이 목록에 없어요."));
    }
    Ok(())
}

fn verify_file(file: &RegistryFile, bytes: &[u8]) -> Result<(), FsError> {
    if bytes.len() as u64 != file.size {
        return Err(FsError::io(format!("파일 크기가 달라요: {}", file.path)));
    }
    if sha256_hex(bytes) != file.sha256 {
        return Err(FsError::io(format!("파일이 변조되었거나 손상되었어요: {}", file.path)));
    }
    Ok(())
}

fn parse_manifest(bytes: &[u8], entry: &RegistryEntry) -> Result<ExtensionManifest, FsError> {
    let manifest: ExtensionManifest = serde_json::from_slice(bytes)
        .map_err(|e| FsError::invalid_path(format!("extension.json을 읽지 못했어요: {e}")))?;
    if manifest.id != entry.id || manifest.version != entry.version {
        return Err(FsError::invalid_path("extension.json이 레지스트리 정보와 달라요."));
    }
    Ok(manifest)
}

// ---------- registry sources ----------

enum Source {
    Local(PathBuf),
    Remote(reqwest::Url),
}

fn is_local_host(host: &str) -> bool {
    host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
}

fn parse_source(url: &str) -> Result<Source, FsError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(FsError::invalid_path("레지스트리 주소가 비어 있어요."));
    }
    let p = Path::new(url);
    if p.is_absolute() {
        return Ok(Source::Local(p.to_path_buf()));
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| FsError::invalid_path("올바르지 않은 레지스트리 주소예요."))?;
    let host = parsed.host_str().unwrap_or("");
    match parsed.scheme() {
        "https" if !host.is_empty() => Ok(Source::Remote(parsed)),
        "http" if is_local_host(host) => Ok(Source::Remote(parsed)),
        _ => Err(FsError::invalid_path("레지스트리는 https 주소여야 해요.")),
    }
}

fn http_client() -> Result<reqwest::Client, FsError> {
    // reqwest is built without a bundled TLS provider (same as the updater plugin): install ring once.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let ok = attempt.previous().len() < 5
            && (attempt.url().scheme() == "https"
                || (attempt.url().scheme() == "http" && attempt.url().host_str().is_some_and(is_local_host)));
        if ok {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(15))
        .redirect(policy)
        .user_agent("Baton-extensions")
        .build()
        .map_err(|e| FsError::io(format!("네트워크를 준비하지 못했어요: {e}")))
}

impl Source {
    /// Reads `rel` (relative to the registry folder; segments already validated) with a size cap.
    async fn read(&self, client: &reqwest::Client, rel: &[&str], max: usize) -> Result<Vec<u8>, FsError> {
        match self {
            Source::Local(index) => {
                let mut path = index.parent().map(Path::to_path_buf).unwrap_or_default();
                if rel != ["index.json"] || index.file_name().is_none() {
                    path.extend(rel);
                } else {
                    path = index.clone();
                }
                tokio::task::spawn_blocking(move || read_capped(&path, max))
                    .await
                    .map_err(|e| FsError::io(e.to_string()))?
            }
            Source::Remote(index) => {
                let mut url = index.clone();
                url.set_query(None);
                url.set_fragment(None);
                if rel != ["index.json"] {
                    url.path_segments_mut()
                        .map_err(|_| FsError::invalid_path("올바르지 않은 레지스트리 주소예요."))?
                        .pop()
                        .extend(rel);
                }
                let mut resp = client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| FsError::io(format!("다운로드하지 못했어요: {e}")))?;
                if !resp.status().is_success() {
                    return Err(FsError::io(format!("다운로드하지 못했어요 (HTTP {}).", resp.status().as_u16())));
                }
                let mut out = Vec::new();
                while let Some(chunk) = resp.chunk().await.map_err(|e| FsError::io(format!("다운로드하지 못했어요: {e}")))? {
                    if out.len() + chunk.len() > max {
                        return Err(FsError::io("파일이 너무 커요."));
                    }
                    out.extend_from_slice(&chunk);
                }
                Ok(out)
            }
        }
    }
}

fn read_capped(path: &Path, max: usize) -> Result<Vec<u8>, FsError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FsError::not_found(format!("파일을 찾을 수 없어요: {}", path.display()))
        } else {
            FsError::io(format!("파일을 읽지 못했어요: {e}"))
        }
    })?;
    let mut buf = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut buf).map_err(|e| FsError::io(format!("파일을 읽지 못했어요: {e}")))?;
    if buf.len() > max {
        return Err(FsError::io("파일이 너무 커요."));
    }
    Ok(buf)
}

async fn fetch_registry_inner(url: &str) -> Result<Registry, FsError> {
    let source = parse_source(url)?;
    let client = http_client()?;
    let bytes = source.read(&client, &["index.json"], MAX_INDEX_BYTES).await?;
    let registry: Registry =
        serde_json::from_slice(&bytes).map_err(|e| FsError::invalid_path(format!("레지스트리를 읽지 못했어요: {e}")))?;
    if registry.version != 1 {
        return Err(FsError::invalid_path("지원하지 않는 레지스트리 버전이에요."));
    }
    Ok(registry)
}

// ---------- install / storage ----------

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load_state(root: &Path) -> State {
    std::fs::read(root.join(STATE_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(root: &Path, state: &State) -> Result<(), FsError> {
    std::fs::create_dir_all(root).map_err(|e| FsError::io(format!("확장 폴더를 만들지 못했어요: {e}")))?;
    let json = serde_json::to_vec_pretty(state).map_err(|e| FsError::io(e.to_string()))?;
    let tmp = root.join(format!(".state-{}.tmp", now_ms()));
    std::fs::write(&tmp, json).map_err(|e| FsError::io(format!("상태를 저장하지 못했어요: {e}")))?;
    std::fs::rename(&tmp, root.join(STATE_FILE)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        FsError::io(format!("상태를 저장하지 못했어요: {e}"))
    })
}

fn with_state<T>(root: &Path, f: impl FnOnce(&mut State) -> T) -> Result<T, FsError> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state(root);
    let out = f(&mut state);
    save_state(root, &state)?;
    Ok(out)
}

/// Writes files into a temp folder and swaps it into `<root>/<id>`.
fn place_files(root: &Path, id: &str, files: &[(String, Vec<u8>)]) -> Result<(), FsError> {
    std::fs::create_dir_all(root).map_err(|e| FsError::io(format!("확장 폴더를 만들지 못했어요: {e}")))?;
    let stamp = now_ms();
    let tmp = root.join(format!(".tmp-{id}-{stamp}"));
    let io = |e: std::io::Error| FsError::io(format!("확장을 설치하지 못했어요: {e}"));
    let write_all = || -> Result<(), FsError> {
        for (path, bytes) in files {
            let dest = tmp.join(path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            std::fs::write(&dest, bytes).map_err(io)?;
        }
        Ok(())
    };
    if let Err(e) = write_all() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let target = root.join(id);
    let old = root.join(format!(".old-{id}-{stamp}"));
    let had_old = target.exists();
    if had_old {
        if let Err(e) = std::fs::rename(&target, &old) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(io(e));
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        if had_old {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(io(e));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

async fn install_inner(root: PathBuf, app_version: String, url: String, id: String) -> Result<InstalledExtension, FsError> {
    check_id(&id)?;
    let registry = fetch_registry_inner(&url).await?;
    let entry = registry
        .extensions
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| FsError::not_found("레지스트리에서 확장을 찾을 수 없어요."))?;
    validate_entry(&entry)?;
    check_app_version(entry.baton.as_deref(), &app_version)?;

    let source = parse_source(&url)?;
    let client = http_client()?;
    let mut files = Vec::with_capacity(entry.files.len());
    for f in &entry.files {
        let mut rel: Vec<&str> = vec![entry.id.as_str()];
        rel.extend(f.path.split('/'));
        let bytes = source.read(&client, &rel, MAX_FILE_BYTES as usize).await?;
        verify_file(f, &bytes)?;
        files.push((f.path.clone(), bytes));
    }
    let manifest_bytes = &files.iter().find(|(p, _)| p == MANIFEST_FILE).expect("validated").1;
    let manifest = parse_manifest(manifest_bytes, &entry)?;
    check_app_version(manifest.baton.as_deref(), &app_version)?;

    tokio::task::spawn_blocking(move || {
        place_files(&root, &entry.id, &files)?;
        let installed_at = now_ms();
        let enabled = with_state(&root, |state| {
            let enabled = state.get(&entry.id).map(|s| s.enabled).unwrap_or(true);
            state.insert(entry.id.clone(), StateEntry { enabled, installed_at, source: url.clone() });
            enabled
        })?;
        Ok(InstalledExtension { manifest, enabled, installed_at, source: url })
    })
    .await
    .map_err(|e| FsError::io(e.to_string()))?
}

fn list_inner(root: &Path) -> Vec<InstalledExtension> {
    let state = load_state(root);
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !valid_id(&name) || !item.path().is_dir() {
            continue;
        }
        let manifest = std::fs::read(item.path().join(MANIFEST_FILE))
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<ExtensionManifest>(&b).map_err(|e| e.to_string()));
        match manifest {
            Ok(m) if m.id == name => {
                let s = state.get(&name);
                out.push(InstalledExtension {
                    manifest: m,
                    enabled: s.map(|s| s.enabled).unwrap_or(true),
                    installed_at: s.map(|s| s.installed_at).unwrap_or(0),
                    source: s.map(|s| s.source.clone()).unwrap_or_default(),
                });
            }
            Ok(_) => eprintln!("확장 {name}: id가 폴더 이름과 달라 건너뛰어요."),
            Err(e) => eprintln!("확장 {name}: 읽지 못해 건너뛰어요: {e}"),
        }
    }
    out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    out
}

fn read_file_inner(root: &Path, id: &str, path: &str) -> Result<String, FsError> {
    check_id(id)?;
    check_rel_path(path)?;
    let base = std::fs::canonicalize(root.join(id)).map_err(|_| FsError::not_found("설치된 확장을 찾을 수 없어요."))?;
    let full = std::fs::canonicalize(base.join(path)).map_err(|_| FsError::not_found("파일을 찾을 수 없어요."))?;
    if !full.starts_with(&base) {
        return Err(FsError::invalid_path("확장 폴더 밖의 파일은 읽을 수 없어요."));
    }
    let bytes = read_capped(&full, MAX_FILE_BYTES as usize)?;
    String::from_utf8(bytes).map_err(|_| FsError::io("텍스트 파일이 아니에요."))
}

fn uninstall_inner(root: &Path, id: &str) -> Result<(), FsError> {
    check_id(id)?;
    let dir = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| FsError::io(format!("확장을 삭제하지 못했어요: {e}")))?;
    }
    with_state(root, |s| {
        s.remove(id);
    })
}

fn set_enabled_inner(root: &Path, id: &str, enabled: bool) -> Result<(), FsError> {
    check_id(id)?;
    if !root.join(id).is_dir() {
        return Err(FsError::not_found("설치된 확장을 찾을 수 없어요."));
    }
    with_state(root, |s| {
        let now = now_ms();
        s.entry(id.to_string())
            .or_insert(StateEntry { enabled, installed_at: now, source: String::new() })
            .enabled = enabled;
    })
}

fn extensions_root(app: &tauri::AppHandle) -> Result<PathBuf, FsError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("extensions"))
        .map_err(|e| FsError::io(format!("앱 데이터 폴더를 찾지 못했어요: {e}")))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, FsError> + Send + 'static) -> Result<T, FsError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| FsError::io(e.to_string()))?
}

// ---------- commands ----------

#[tauri::command]
pub async fn ext_fetch_registry(url: String) -> Result<Registry, FsError> {
    fetch_registry_inner(&url).await
}

#[tauri::command]
pub async fn ext_install(app: tauri::AppHandle, url: String, id: String) -> Result<InstalledExtension, FsError> {
    let root = extensions_root(&app)?;
    install_inner(root, app.package_info().version.to_string(), url, id).await
}

#[tauri::command]
pub async fn ext_uninstall(app: tauri::AppHandle, id: String) -> Result<(), FsError> {
    let root = extensions_root(&app)?;
    blocking(move || uninstall_inner(&root, &id)).await
}

#[tauri::command]
pub async fn ext_set_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), FsError> {
    let root = extensions_root(&app)?;
    blocking(move || set_enabled_inner(&root, &id, enabled)).await
}

#[tauri::command]
pub async fn ext_list_installed(app: tauri::AppHandle) -> Result<Vec<InstalledExtension>, FsError> {
    let root = extensions_root(&app)?;
    blocking(move || Ok(list_inner(&root))).await
}

#[tauri::command]
pub async fn ext_read_file(app: tauri::AppHandle, id: String, path: String) -> Result<String, FsError> {
    let root = extensions_root(&app)?;
    blocking(move || read_file_inner(&root, &id, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("baton-ext-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn id_validation() {
        assert!(valid_id("lang-go"));
        assert!(valid_id("a1"));
        assert!(!valid_id(""));
        assert!(!valid_id("Lang"));
        assert!(!valid_id("a_b"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(valid_id(&"a".repeat(64)));
    }

    #[test]
    fn path_validation() {
        assert!(valid_rel_path("extension.json"));
        assert!(valid_rel_path("grammars/go.json"));
        assert!(!valid_rel_path(""));
        assert!(!valid_rel_path("/etc/passwd"));
        assert!(!valid_rel_path("../x"));
        assert!(!valid_rel_path("a/../x"));
        assert!(!valid_rel_path("a\\b"));
        assert!(!valid_rel_path("a//b"));
        assert!(!valid_rel_path("./a"));
        assert!(!valid_rel_path("C:/x"));
        assert!(!valid_rel_path("a/"));
    }

    #[test]
    fn sha256_check() {
        let h = sha256_hex(b"abc");
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let good = RegistryFile { path: "a".into(), sha256: h.clone(), size: 3 };
        assert!(verify_file(&good, b"abc").is_ok());
        assert!(verify_file(&good, b"abd").is_err());
        assert!(verify_file(&RegistryFile { size: 4, ..good }, b"abc").is_err());
    }

    #[test]
    fn manifest_keeps_unknown_kinds() {
        let entry = entry_for("x", "1.0.0", &[]);
        let raw = json!({"id":"x","name":"X","version":"1.0.0","contributes":{"languages":[{"id":"x"}],"themes":[{"a":1}]}});
        let m = parse_manifest(raw.to_string().as_bytes(), &entry).unwrap();
        assert!(m.contributes.contains_key("themes"));
        let back = serde_json::to_value(&m).unwrap();
        assert_eq!(back["contributes"]["themes"][0]["a"], 1);
        // id / version mismatch
        let bad = json!({"id":"y","name":"X","version":"1.0.0","contributes":{}});
        assert!(parse_manifest(bad.to_string().as_bytes(), &entry).is_err());
        let bad = json!({"id":"x","name":"X","version":"1.0.1","contributes":{}});
        assert!(parse_manifest(bad.to_string().as_bytes(), &entry).is_err());
    }

    #[test]
    fn version_compare() {
        assert!(needs_newer_app("0.2.6", "0.2.5"));
        assert!(!needs_newer_app("0.2.5", "0.2.5"));
        assert!(!needs_newer_app("0.2.4", "0.2.5"));
        assert!(needs_newer_app("1.0", "0.9.9"));
        assert!(!needs_newer_app("0.10.0", "0.10.0-beta"));
        assert!(needs_newer_app("0.10.0", "0.9.0"));
        assert!(!needs_newer_app("garbage", "0.2.5"));
        let err = check_app_version(Some("9.0.0"), "0.2.5").unwrap_err();
        assert_eq!(err.message, "이 확장은 Baton 9.0.0 이상이 필요해요.");
    }

    #[test]
    fn source_schemes() {
        assert!(matches!(parse_source("https://example.com/x/index.json"), Ok(Source::Remote(_))));
        assert!(matches!(parse_source("http://127.0.0.1:8000/index.json"), Ok(Source::Remote(_))));
        assert!(matches!(parse_source("http://localhost/index.json"), Ok(Source::Remote(_))));
        assert!(parse_source("http://example.com/index.json").is_err());
        assert!(parse_source("ftp://example.com/index.json").is_err());
        assert!(parse_source("file:///etc/index.json").is_err());
        assert!(parse_source("relative/index.json").is_err());
        // An absolute path on this platform (on Windows `/tmp/…` has no drive, so it isn't absolute).
        let local = std::env::temp_dir().join("reg").join("index.json");
        assert!(matches!(parse_source(&local.display().to_string()), Ok(Source::Local(_))));
        #[cfg(windows)]
        assert!(matches!(parse_source(r"C:\reg\index.json"), Ok(Source::Local(_))));
    }

    fn entry_for(id: &str, version: &str, files: &[(&str, &[u8])]) -> RegistryEntry {
        RegistryEntry {
            id: id.into(),
            name: id.into(),
            version: version.into(),
            description: None,
            publisher: None,
            baton: None,
            kinds: vec!["languages".into()],
            keywords: None,
            files: files
                .iter()
                .map(|(p, b)| RegistryFile { path: p.to_string(), sha256: sha256_hex(b), size: b.len() as u64 })
                .collect(),
        }
    }

    /// Writes a registry folder with one extension and returns the index.json path.
    fn make_registry(dir: &Path, id: &str, version: &str, baton: Option<&str>, grammar: &str) -> String {
        let manifest = json!({"id": id, "name": "Go", "version": version, "contributes": {"languages": [], "future": {}}}).to_string();
        let files: Vec<(&str, &[u8])> = vec![("extension.json", manifest.as_bytes()), ("grammars/go.json", grammar.as_bytes())];
        let mut entry = entry_for(id, version, &files);
        entry.baton = baton.map(String::from);
        std::fs::create_dir_all(dir.join(id).join("grammars")).unwrap();
        for (p, b) in &files {
            std::fs::write(dir.join(id).join(p), b).unwrap();
        }
        let index = json!({"version": 1, "extensions": [entry]});
        let path = dir.join("index.json");
        std::fs::write(&path, index.to_string()).unwrap();
        path.display().to_string()
    }

    #[tokio::test]
    async fn install_replace_uninstall_local() {
        let base = temp("flow");
        let reg = base.join("reg");
        let root = base.join("data").join("extensions");
        let url = make_registry(&reg, "lang-go", "1.0.0", None, "{\"v\":1}");

        let fetched = fetch_registry_inner(&url).await.unwrap();
        assert_eq!(fetched.extensions.len(), 1);

        let inst = install_inner(root.clone(), "0.2.5".into(), url.clone(), "lang-go".into()).await.unwrap();
        assert!(inst.enabled);
        assert_eq!(inst.manifest.version, "1.0.0");
        assert_eq!(read_file_inner(&root, "lang-go", "grammars/go.json").unwrap(), "{\"v\":1}");
        assert!(read_file_inner(&root, "lang-go", "../state.json").is_err());
        assert!(read_file_inner(&root, "lang-go", "nope.json").is_err());

        // Disabled state survives an upgrade.
        set_enabled_inner(&root, "lang-go", false).unwrap();
        make_registry(&reg, "lang-go", "1.1.0", None, "{\"v\":2}");
        let inst = install_inner(root.clone(), "0.2.5".into(), url.clone(), "lang-go".into()).await.unwrap();
        assert!(!inst.enabled);
        assert_eq!(read_file_inner(&root, "lang-go", "grammars/go.json").unwrap(), "{\"v\":2}");
        let listed = list_inner(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].manifest.version, "1.1.0");
        assert!(!listed[0].enabled);
        // No temp leftovers.
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty());

        // Broken installs are skipped in the listing.
        std::fs::create_dir_all(root.join("broken")).unwrap();
        assert_eq!(list_inner(&root).len(), 1);

        uninstall_inner(&root, "lang-go").unwrap();
        assert!(!root.join("lang-go").exists());
        assert!(list_inner(&root).is_empty());
        assert!(!load_state(&root).contains_key("lang-go"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn install_rejects_bad_input() {
        let base = temp("bad");
        let reg = base.join("reg");
        let root = base.join("ext");

        // Newer Baton required.
        let url = make_registry(&reg, "lang-go", "1.0.0", Some("9.0.0"), "{}");
        let err = install_inner(root.clone(), "0.2.5".into(), url.clone(), "lang-go".into()).await.unwrap_err();
        assert!(err.message.contains("9.0.0"));

        // Unknown id.
        assert!(install_inner(root.clone(), "0.2.5".into(), url.clone(), "nope".into()).await.is_err());

        // Tampered file content.
        let url = make_registry(&reg, "lang-go", "1.0.0", None, "{\"v\":1}");
        std::fs::write(reg.join("lang-go/grammars/go.json"), "{\"v\":9}").unwrap();
        let err = install_inner(root.clone(), "0.2.5".into(), url.clone(), "lang-go".into()).await.unwrap_err();
        assert!(err.message.contains("변조"));
        assert!(!root.join("lang-go").exists());

        // Entry validation.
        let mut e = entry_for("lang-go", "1.0.0", &[("extension.json", b"{}")]);
        assert!(validate_entry(&e).is_ok());
        e.files.push(RegistryFile { path: "../x".into(), sha256: sha256_hex(b""), size: 0 });
        assert!(validate_entry(&e).is_err());
        let e = entry_for("lang-go", "1.0.0", &[("other.json", b"{}")]);
        assert!(validate_entry(&e).is_err());
        let mut e = entry_for("lang-go", "1.0.0", &[("extension.json", b"{}")]);
        e.files[0].size = MAX_FILE_BYTES + 1;
        assert!(validate_entry(&e).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
