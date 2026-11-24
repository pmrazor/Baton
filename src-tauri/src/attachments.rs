//! Files attached to a message, turned into ACP prompt content.
//!
//! What each file becomes depends on what the agent accepts
//! (`promptCapabilities` from `initialize`):
//!   - an image the agent can see           → `image` (base64)
//!   - a small text file, embedded context  → `resource` with the text
//!   - anything else                        → `resource_link` (the agent reads the path)
//!
//! `resource_link` is part of every ACP agent's baseline, so nothing is refused.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};

/// Largest image sent inline; bigger ones go as a link.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Largest text file embedded in the message.
const MAX_TEXT_BYTES: u64 = 512 * 1024;

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "mov" | "m4v" | "webm"))
}

/// Let the webview show these images and videos (thumbnails) through the
/// asset protocol. Its scope starts empty; only attached media files join it.
#[tauri::command]
pub fn allow_previews(app: tauri::AppHandle, paths: Vec<String>) -> Vec<String> {
    use tauri::Manager;
    let scope = app.asset_protocol_scope();
    paths
        .into_iter()
        .filter(|p| {
            let path = Path::new(p);
            (image_mime(path).is_some() || is_video(path)) && path.is_file() && scope.allow_file(path).is_ok()
        })
        .collect()
}

/// Open an attachment in the system's default app.
#[tauri::command]
pub fn open_attachment(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !Path::new(&path).is_file() {
        return Err(format!("파일이 없어요: {path}"));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// `file://` URI of an absolute path, percent-encoded.
pub fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !text.starts_with('/') {
        out.push('/'); // Windows: file:///C:/…
    }
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Prompt content for `text` followed by the attached files.
pub fn prompt_blocks(text: &str, paths: &[String], caps: &Value) -> Result<Vec<Value>, String> {
    let images = caps.get("image").and_then(Value::as_bool).unwrap_or(false);
    let embedded = caps.get("embeddedContext").and_then(Value::as_bool).unwrap_or(false);
    let mut blocks = Vec::new();
    if !text.is_empty() || paths.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for raw in paths {
        let path = PathBuf::from(raw);
        let meta = std::fs::metadata(&path).map_err(|e| format!("첨부 파일을 읽지 못했어요 ({raw}): {e}"))?;
        if meta.is_dir() {
            return Err(format!("폴더는 첨부할 수 없어요: {raw}"));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| raw.clone());
        let uri = file_uri(&path);
        let size = meta.len();

        if let Some(mime) = image_mime(&path).filter(|_| images && size <= MAX_IMAGE_BYTES) {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            blocks.push(json!({
                "type": "image",
                "mimeType": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "uri": uri,
            }));
            continue;
        }
        if embedded && size <= MAX_TEXT_BYTES && image_mime(&path).is_none() {
            if let Ok(Ok(text)) = std::fs::read(&path).map(String::from_utf8) {
                blocks.push(json!({
                    "type": "resource",
                    "resource": { "uri": uri, "mimeType": "text/plain", "text": text },
                }));
                continue;
            }
        }
        let mut link = json!({ "type": "resource_link", "uri": uri, "name": name, "size": size });
        if let Some(mime) = image_mime(&path) {
            link["mimeType"] = json!(mime);
        }
        blocks.push(link);
    }
    Ok(blocks)
}

/// Keep a pasted image (which has no file of its own) in the workspace's
/// `.baton/attachments`, so it can be attached by path like any other file.
#[tauri::command]
pub fn save_attachment(workspace: String, name: String, data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let dir = crate::history::baton_subdir(Path::new(&workspace), "attachments")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' })
        .collect();
    let path = dir.join(format!("{stamp}-{}", if safe.is_empty() { "pasted.png".into() } else { safe }));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_are_encoded() {
        assert_eq!(file_uri(Path::new("/Users/me/My Project/a#1.txt")), "file:///Users/me/My%20Project/a%231.txt");
        assert_eq!(file_uri(Path::new("C:\\Users\\me\\a.png")), "file:///C:/Users/me/a.png");
    }

    #[test]
    fn files_become_the_richest_block_the_agent_takes() {
        let dir = std::env::temp_dir().join(format!("baton-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("shot.PNG");
        std::fs::write(&img, [0x89, b'P', b'N', b'G']).unwrap();
        let txt = dir.join("notes.md");
        std::fs::write(&txt, "# hello\n").unwrap();
        let bin = dir.join("data.bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        let paths: Vec<String> = [&img, &txt, &bin].iter().map(|p| p.display().to_string()).collect();

        let all = json!({ "image": true, "embeddedContext": true });
        let blocks = prompt_blocks("look", &paths, &all).unwrap();
        let types: Vec<&str> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["text", "image", "resource", "resource_link"]);
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[1]["data"], "iVBORw==");
        assert_eq!(blocks[2]["resource"]["text"], "# hello\n");
        assert_eq!(blocks[3]["name"], "data.bin");

        // An agent that takes neither gets links, which every agent understands.
        let none = json!({});
        let blocks = prompt_blocks("", &paths, &none).unwrap();
        let types: Vec<&str> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["resource_link", "resource_link", "resource_link"], "no empty text block");
        assert_eq!(blocks[0]["mimeType"], "image/png");

        assert!(prompt_blocks("x", &[dir.display().to_string()], &all).is_err(), "folders are refused");
        assert!(prompt_blocks("x", &["/no/such/file".into()], &all).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_alone_is_one_block() {
        assert_eq!(prompt_blocks("hi", &[], &json!({})).unwrap(), vec![json!({ "type": "text", "text": "hi" })]);
    }
}
