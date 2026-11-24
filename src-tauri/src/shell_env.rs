//! GUI apps on macOS (and some Linux launchers) start with a minimal PATH, so
//! `npx`, `dsh`, `claude` etc. installed via Homebrew/nvm are not found.
//! Borrow PATH from the user's login shell once at startup.
//!
//! An agent installed while the app runs adds itself to the shell's (or, on
//! Windows, the registry's) PATH, which this process doesn't see. `refresh_path`
//! reads it again; the result is kept here and handed to every program the app
//! starts, rather than changing the process environment while threads run.

use std::ffi::OsString;
use std::sync::RwLock;

static REFRESHED: RwLock<Option<OsString>> = RwLock::new(None);

/// Call once at startup, before any other thread exists.
pub fn inherit_login_shell_path() {
    #[cfg(unix)]
    if let Some(path) = read_user_path() {
        std::env::set_var("PATH", path);
    }
}

/// Re-read the user's PATH (after installing an agent).
pub fn refresh_path() {
    if let Some(path) = read_user_path() {
        *REFRESHED.write().unwrap() = Some(path);
    }
}

/// PATH read by `refresh_path`, if it ran: set it on programs the app starts.
pub fn refreshed_path() -> Option<OsString> {
    REFRESHED.read().unwrap().clone()
}

/// The PATH programs are looked up in.
pub fn path() -> Option<OsString> {
    refreshed_path().or_else(|| std::env::var_os("PATH"))
}

#[cfg(unix)]
fn read_user_path() -> Option<OsString> {
    use std::process::Command;

    const MARK: &str = "__BATON_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");

    let out = Command::new(&shell).args(["-ilc", &script]).output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let path = stdout.split(MARK).nth(1)?;
    (!path.is_empty()).then(|| OsString::from(path))
}

/// Installers update the machine and user PATH in the registry.
#[cfg(windows)]
fn read_user_path() -> Option<OsString> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(crate::acp::CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().trim_matches(';').to_string();
    (!path.is_empty()).then(|| OsString::from(path))
}
