//! GUI apps on macOS (and some Linux launchers) start with a minimal PATH, so
//! `npx`, `dsh`, `claude` etc. installed via Homebrew/nvm are not found.
//! Borrow PATH from the user's login shell once at startup.

#[cfg(unix)]
pub fn inherit_login_shell_path() {
    use std::process::Command;

    const MARK: &str = "__BATON_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");

    let Ok(out) = Command::new(&shell).args(["-ilc", &script]).output() else { return };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let Some(path) = stdout.split(MARK).nth(1) else { return };
    if !path.is_empty() {
        std::env::set_var("PATH", path);
    }
}

#[cfg(not(unix))]
pub fn inherit_login_shell_path() {}
