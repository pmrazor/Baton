//! ACP "terminal" auth: the client re-runs the agent command with extra args
//! in an interactive terminal so the user can log in there.

use std::process::Command;

fn shell_quote(arg: &str) -> String {
    if cfg!(windows) {
        if arg.chars().any(|c| c.is_whitespace() || c == '"') {
            format!("\"{}\"", arg.replace('"', "\\\""))
        } else {
            arg.to_string()
        }
    } else if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./@:=+".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// A shell line that runs `command args…` with `env` set for that command only.
pub fn command_line(command: &str, args: &[String], env: &[(String, String)]) -> String {
    let cmd = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    if env.is_empty() {
        return cmd;
    }
    if cfg!(windows) {
        let sets: Vec<String> = env.iter().map(|(k, v)| format!("set \"{k}={v}\"")).collect();
        format!("{} && {cmd}", sets.join(" && "))
    } else {
        let vars: Vec<String> = env.iter().map(|(k, v)| format!("{k}={}", shell_quote(v))).collect();
        format!("{} {cmd}", vars.join(" "))
    }
}

pub fn open_in_terminal(cmdline: &str) -> Result<(), String> {
    let result = if cfg!(target_os = "macos") {
        let escaped = cmdline.replace('\\', "\\\\").replace('"', "\\\"");
        Command::new("osascript")
            .args([
                "-e",
                "tell application \"Terminal\" to activate",
                "-e",
                &format!("tell application \"Terminal\" to do script \"{escaped}\""),
            ])
            .spawn()
    } else if cfg!(windows) {
        Command::new("cmd").args(["/C", "start", "", "cmd", "/K", cmdline]).spawn()
    } else {
        let script = format!("{cmdline}; echo; read -p '완료되면 Enter를 누르세요...' _");
        ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
            .iter()
            .find_map(|term| {
                let mut cmd = Command::new(term);
                if *term == "gnome-terminal" {
                    cmd.args(["--", "sh", "-c", &script]);
                } else {
                    cmd.args(["-e", "sh", "-c", &script]);
                }
                cmd.spawn().ok()
            })
            .ok_or_else(|| std::io::Error::other("터미널 프로그램을 찾지 못했습니다"))
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::command_line;

    #[test]
    fn quotes_env_paths_with_spaces() {
        let env = vec![("CLAUDE_CONFIG_DIR".to_string(), "/Users/me/Library/Application Support/x".to_string())];
        let line = command_line("npx", &["-y".into(), "pkg@1.0".into(), "--cli".into()], &env);
        assert_eq!(line, "CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/x' npx -y pkg@1.0 --cli");
    }

    #[test]
    fn no_env_is_plain_command() {
        assert_eq!(command_line("dsh", &["web".into()], &[]), "dsh web");
    }
}
