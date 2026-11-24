//! Interactive terminals for the 터미널 tab: the user's shell in a PTY, one per
//! id (the webview uses `<folder>#<n>`, several per folder).
//!
//! Output reaches the webview as `terminal-output { id, data }`, where `data`
//! is UTF-8 text. A character split across two reads is held back until the
//! rest of it arrives; bytes that are not UTF-8 become U+FFFD. Reads are
//! batched for a few milliseconds so a burst of output is one event, not
//! hundreds. `terminal-exit { id, code, gone }` follows the last output;
//! `gone` is true when the shell was ended because its folder was removed.
//!
//! Each terminal has three threads, all plain blocking ones (never the async
//! runtime): a reader, a writer fed by a channel, and a waiter that reaps the
//! shell. A fourth forwards the reader's chunks as batched events.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

/// How long output is held to batch it with what follows.
const BATCH: Duration = Duration::from_millis(8);
/// Send at once when this much is waiting.
const MAX_BATCH: usize = 64 * 1024;
/// After the shell exits, how long to wait for the rest of its output (a
/// background job may keep the PTY open).
const EXIT_GRACE: Duration = Duration::from_millis(500);

/// A running shell.
struct Term {
    /// Tells this shell apart from a later one under the same id.
    gen: u64,
    /// The folder it started in, to end it when that folder is removed.
    cwd: PathBuf,
    /// Set before killing it because its folder was removed; reported in `terminal-exit`.
    gone: Arc<AtomicBool>,
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// A running shell, for `terminal_list`.
#[derive(Serialize, Debug, PartialEq)]
pub struct TerminalInfo {
    id: String,
    cwd: String,
}

#[derive(Default)]
pub struct Terminals {
    map: Mutex<HashMap<String, Term>>,
    next_gen: AtomicU64,
}

impl Terminals {
    /// Start a shell for `id`. Does nothing (returns false) if one is running,
    /// so a reloaded webview reattaches to it.
    fn open(&self, app: &AppHandle, id: String, cwd: &str, cols: u16, rows: u16) -> Result<bool, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("폴더를 찾을 수 없어요: {cwd}"));
        }
        // Held while spawning, so two opens of one id can't both start a
        // shell, and a shell that exits at once is forgotten only after it's added.
        let mut map = self.map.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(false);
        }
        let gen = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let gone = Arc::new(AtomicBool::new(false));
        let (emit_app, emit_id, emit_gone) = (app.clone(), id.clone(), gone.clone());
        let emit = move |event: Output| {
            let _ = match event {
                Output::Data(data) => emit_app.emit("terminal-output", json!({ "id": emit_id, "data": data })),
                Output::Exit(code) => emit_app.emit(
                    "terminal-exit",
                    json!({ "id": emit_id, "code": code, "gone": emit_gone.load(Ordering::Relaxed) }),
                ),
            };
        };
        let (exit_app, exit_id) = (app.clone(), id.clone());
        let on_exit = move || exit_app.state::<Terminals>().forget(&exit_id, gen);
        let term = start(shell_command(cwd), cols, rows, gen, emit, on_exit)?;
        map.insert(id, Term { cwd: PathBuf::from(cwd), gone, ..term });
        Ok(true)
    }

    /// The running shells, so a reloaded webview can rebuild its tabs.
    fn list(&self) -> Vec<TerminalInfo> {
        let map = self.map.lock().unwrap();
        let mut list: Vec<_> = map
            .iter()
            .map(|(id, t)| TerminalInfo { id: id.clone(), cwd: t.cwd.display().to_string() })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Drop a shell that has exited, unless the id was reopened since.
    fn forget(&self, id: &str, gen: u64) {
        let mut map = self.map.lock().unwrap();
        if map.get(id).is_some_and(|t| t.gen == gen) {
            map.remove(id);
        }
    }

    fn write(&self, id: &str, data: String) -> Result<(), String> {
        let map = self.map.lock().unwrap();
        let term = map.get(id).ok_or("터미널이 실행 중이 아니에요")?;
        term.input.send(data.into_bytes()).map_err(|_| "터미널이 닫혔어요".to_string())
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.map.lock().unwrap();
        let Some(term) = map.get(id) else { return Ok(()) };
        term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    /// Kill the shell; `terminal-exit` follows once it's gone.
    fn close(&self, id: &str) {
        let term = self.map.lock().unwrap().remove(id);
        if let Some(mut term) = term {
            let _ = term.killer.kill();
        }
    }

    /// End every shell whose folder is `root` or inside it, once that folder
    /// has been removed (a task's worktree). Their `terminal-exit` says `gone`.
    /// Returns the ids ended.
    pub fn close_under(&self, root: &Path) -> Vec<String> {
        let ended: Vec<(String, Term)> = {
            let mut map = self.map.lock().unwrap();
            let ids: Vec<String> = map.iter().filter(|(_, t)| is_under(&t.cwd, root)).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| map.remove(&id).map(|t| (id, t))).collect()
        };
        ended
            .into_iter()
            .map(|(id, mut term)| {
                term.gone.store(true, Ordering::Relaxed);
                let _ = term.killer.kill();
                id
            })
            .collect()
    }

    /// On app exit: end every shell.
    pub fn kill_all(&self) {
        for term in self.map.lock().unwrap().values_mut() {
            let _ = term.killer.kill();
        }
    }
}

enum Output {
    Data(String),
    Exit(u32),
}

enum Msg {
    Data(Vec<u8>),
    Eof,
    Exit(u32),
}

/// Whether `path` is `root` or inside it. Compares whole components, so
/// `/a/wt-10` is not under `/a/wt-1`.
fn is_under(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// The user's shell, in `cwd`.
fn shell_command(cwd: &str) -> CommandBuilder {
    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        let shell = ["pwsh", "powershell"]
            .into_iter()
            .find(|s| crate::agents::command_exists(s))
            .map(String::from)
            .or_else(|| std::env::var("COMSPEC").ok())
            .unwrap_or_else(|| "cmd.exe".into());
        CommandBuilder::new(shell)
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = crate::shell_env::refreshed_path() {
        cmd.env("PATH", path);
    }
    cmd
}

/// Spawn `cmd` in a new PTY and start its threads. `emit` gets the output and,
/// last, the exit code; `on_exit` runs as soon as the process has ended.
fn start(
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    gen: u64,
    emit: impl FnMut(Output) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<Term, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Our copy of the slave must go, or the reader never sees the shell end.
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel::<Msg>();
    let out = tx.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if out.send(Msg::Data(chunk[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                // Linux reports EIO once the shell's side is closed.
                Err(_) => break,
            }
        }
        let _ = out.send(Msg::Eof);
    });

    let (input, input_rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in input_rx {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // Dropping the master here also ends the reader on Windows, where
        // ConPTY output stays open until the pseudoconsole is closed.
        on_exit();
        let _ = tx.send(Msg::Exit(code));
    });

    std::thread::spawn(move || forward(rx, emit));
    Ok(Term { gen, cwd: PathBuf::new(), gone: Arc::default(), master: pair.master, input, killer })
}

/// Batch the reader's chunks into `Output::Data`, then send `Output::Exit`.
fn forward(rx: mpsc::Receiver<Msg>, mut emit: impl FnMut(Output)) {
    let mut buf = Vec::new();
    let mut flush_at: Option<Instant> = None;
    let mut exit: Option<(u32, Instant)> = None;
    let mut eof = false;
    loop {
        let deadline = [flush_at, exit.map(|(_, t)| t)].into_iter().flatten().min();
        let msg = match deadline {
            Some(t) => rx.recv_timeout(t.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(Msg::Data(data)) => {
                buf.extend_from_slice(&data);
                flush_at.get_or_insert_with(|| Instant::now() + BATCH);
            }
            Ok(Msg::Eof) => eof = true,
            Ok(Msg::Exit(code)) => exit = Some((code, Instant::now() + EXIT_GRACE)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let now = Instant::now();
        if buf.len() >= MAX_BATCH || flush_at.is_some_and(|t| t <= now) {
            let text = take_utf8(&mut buf);
            if !text.is_empty() {
                emit(Output::Data(text));
            }
            flush_at = None;
        }
        if exit.is_some_and(|(_, t)| eof || t <= now) {
            break;
        }
    }
    if !buf.is_empty() {
        emit(Output::Data(String::from_utf8_lossy(&buf).into_owned()));
    }
    emit(Output::Exit(exit.map_or(1, |(code, _)| code)));
}

/// Decode `buf`, leaving in it an incomplete character at the end.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let rest = buf.split_off(buf.len() - incomplete_tail(buf));
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text
}

/// Length of a UTF-8 sequence cut off at the end of `bytes` (0 if none).
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue; // continuation byte: the start is further back
        }
        let len = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if len > back { back } else { 0 };
    }
    0
}

#[tauri::command]
pub async fn terminal_open(app: AppHandle, id: String, cwd: String, cols: u16, rows: u16) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || app.state::<Terminals>().open(&app, id, &cwd, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

/// Only queues the input for the terminal's writer thread.
#[tauri::command]
pub fn terminal_write(terminals: State<'_, Terminals>, id: String, data: String) -> Result<(), String> {
    terminals.write(&id, data)
}

#[tauri::command]
pub fn terminal_resize(terminals: State<'_, Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminals.resize(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_list(terminals: State<'_, Terminals>) -> Vec<TerminalInfo> {
    terminals.list()
}

/// Off the main thread: closing a Windows pseudoconsole can wait on its output.
#[tauri::command]
pub async fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || app.state::<Terminals>().close(&id)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_split_character_for_the_next_read() {
        let mut buf = "가나".as_bytes().to_vec();
        buf.truncate(4); // "가" and the first byte of "나"
        assert_eq!(take_utf8(&mut buf), "가");
        assert_eq!(buf.len(), 1);
        buf.extend_from_slice(&"나".as_bytes()[1..]);
        assert_eq!(take_utf8(&mut buf), "나");
        assert!(buf.is_empty());
    }

    #[test]
    fn replaces_invalid_bytes() {
        let mut buf = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_utf8(&mut buf), "a\u{FFFD}b");
        assert!(buf.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_command_and_reports_its_exit() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        // The sleep keeps the PTY open while "hi" is read: some systems drop
        // unread output when the last writer closes.
        cmd.args(["-c", "printf hi; sleep 1; exit 3"]);
        let (tx, rx) = mpsc::channel();
        let _term = start(cmd, 80, 24, 0, move |o| {
            let _ = tx.send(o);
        }, || {}).unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut text = String::new();
        let code = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("terminal timed out") {
                Output::Data(data) => text.push_str(&data),
                Output::Exit(code) => break code,
            }
        };
        assert!(text.contains("hi"), "output was {text:?}");
        assert_eq!(code, 3);
    }

    #[test]
    fn matches_whole_path_components() {
        let root = Path::new("/a/wt-1");
        assert!(is_under(Path::new("/a/wt-1"), root));
        assert!(is_under(Path::new("/a/wt-1/"), root));
        assert!(is_under(Path::new("/a/wt-1/src/app"), root));
        assert!(is_under(Path::new("/a/wt-1/src"), Path::new("/a/wt-1/")));
        assert!(!is_under(Path::new("/a/wt-10"), root));
        assert!(!is_under(Path::new("/a/wt-10/src"), root));
        assert!(!is_under(Path::new("/a"), root));
        assert!(!is_under(Path::new("/b/wt-1"), root));
    }

    #[cfg(unix)]
    #[test]
    fn closes_only_the_shells_under_a_removed_folder() {
        let terminals = Terminals::default();
        let (tx, rx) = mpsc::channel();
        for (id, cwd) in [("wt#1", "/a/wt-1"), ("src#1", "/a/wt-1/src"), ("other#1", "/a/wt-10")] {
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.args(["-c", "sleep 30"]);
            let tx = tx.clone();
            let emit = move |o| {
                if let Output::Exit(_) = o {
                    let _ = tx.send(id);
                }
            };
            let term = start(cmd, 80, 24, 0, emit, || {}).unwrap();
            terminals.map.lock().unwrap().insert(id.into(), Term { cwd: cwd.into(), ..term });
        }

        let mut ended = terminals.close_under(Path::new("/a/wt-1/"));
        ended.sort();
        assert_eq!(ended, ["src#1", "wt#1"]);
        assert_eq!(terminals.list(), [TerminalInfo { id: "other#1".into(), cwd: "/a/wt-10".into() }]);
        // The ended shells still report their exit.
        let mut exited: Vec<_> = (0..2).map(|_| rx.recv_timeout(Duration::from_secs(20)).expect("no exit")).collect();
        exited.sort();
        assert_eq!(exited, ["src#1", "wt#1"]);
        terminals.kill_all();
    }
}
