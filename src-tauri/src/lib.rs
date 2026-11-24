pub mod acp;
pub mod agents;
mod attachments;
mod history;
mod hub;
mod legacy;
mod login;
mod orchestra;
mod profiles;
mod shell_env;
mod teams;
mod terminal;
pub mod usage;
mod worktree;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Manager, State};

use hub::{AgentInfo, Hub, HubError, Launch};
use orchestra::Orchestra;
use profiles::{Profile, Profiles, DEFAULT_PROFILE};
use teams::{Team, Teams};
use terminal::Terminals;

#[tauri::command]
async fn list_agents(hub: State<'_, Hub>) -> Result<Vec<AgentInfo>, HubError> {
    Ok(hub.list().await)
}

/// Read PATH again (an agent may have just been installed) and list agents.
#[tauri::command]
async fn refresh_agents(hub: State<'_, Hub>) -> Result<Vec<AgentInfo>, HubError> {
    let _ = tokio::task::spawn_blocking(shell_env::refresh_path).await;
    Ok(hub.list().await)
}

/// Run the agent's official install command in a terminal, where the user
/// sees what runs.
#[tauri::command]
fn install_agent(hub: State<'_, Hub>, agent_id: String) -> Result<(), HubError> {
    let def = hub.def(&agent_id)?;
    let command = def
        .install
        .as_ref()
        .and_then(|i| i.command())
        .ok_or_else(|| plain_error("이 에이전트는 자동 설치 명령이 없어요. 설치 안내 페이지를 참고해 주세요."))?;
    login::open_in_terminal(command).map_err(plain_error)
}

#[tauri::command]
fn agents_config_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(agents::config_path(&dir).display().to_string())
}

#[tauri::command]
async fn new_session(
    hub: State<'_, Hub>,
    agent_id: String,
    cwd: String,
    launch: Option<Launch>,
) -> Result<Value, HubError> {
    hub.new_session(&agent_id, &cwd, &launch.unwrap_or_default(), json!([]), &Default::default(), Value::Null)
        .await
}

/// Reattach a session the agent persisted earlier (after an app restart).
#[tauri::command]
async fn resume_session(
    hub: State<'_, Hub>,
    agent_id: String,
    session_id: String,
    cwd: String,
    launch: Option<Launch>,
) -> Result<Value, HubError> {
    hub.resume_session(&agent_id, &session_id, &cwd, &launch.unwrap_or_default(), json!([]), Value::Null)
        .await
}

#[tauri::command]
async fn send_prompt(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<Value, HubError> {
    let attachments = attachments.unwrap_or_default();
    let text = orchestra.lead_prompt(&agent_id, &session_id, &text, &attachments);
    hub.prompt(&agent_id, &session_id, &text, &attachments).await
}

#[tauri::command]
async fn cancel_prompt(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    session_id: String,
) -> Result<(), HubError> {
    // Stopping a lead also stops the tasks it handed out.
    orchestra.cancel_lead_tasks(&agent_id, &session_id).await;
    hub.cancel(&agent_id, &session_id).await
}

/// Agent mode: a lead session wired to Baton's MCP server and the given team.
#[tauri::command]
async fn new_lead_session(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    cwd: String,
    launch: Option<Launch>,
    team_id: String,
) -> Result<Value, HubError> {
    let (token, mcp) = orchestra.register_lead(&agent_id, &cwd, &team_id, None);
    let config = hub.def(&agent_id)?.lead_config.clone();
    let meta = Orchestra::lead_meta(&agent_id);
    match hub.new_session(&agent_id, &cwd, &launch.unwrap_or_default(), mcp, &config, meta).await {
        Ok(session) => {
            if let Some(id) = session.get("sessionId").and_then(Value::as_str) {
                orchestra.bind_lead(&token, id);
            }
            Ok(session)
        }
        Err(e) => {
            orchestra.forget_lead(&token);
            Err(e)
        }
    }
}

#[tauri::command]
async fn resume_lead_session(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    session_id: String,
    cwd: String,
    launch: Option<Launch>,
    team_id: String,
) -> Result<Value, HubError> {
    let (token, mcp) = orchestra.register_lead(&agent_id, &cwd, &team_id, Some(session_id.clone()));
    let meta = Orchestra::lead_meta(&agent_id);
    let res = hub.resume_session(&agent_id, &session_id, &cwd, &launch.unwrap_or_default(), mcp, meta).await;
    if res.is_err() {
        orchestra.forget_lead(&token);
    }
    res
}

/// Saved sessions of every agent (and account) for a folder, for importing.
#[tauri::command]
async fn list_agent_sessions(
    hub: State<'_, Hub>,
    profiles: State<'_, Arc<Profiles>>,
    cwd: String,
) -> Result<Vec<Value>, HubError> {
    let mut out = Vec::new();
    let agents: Vec<_> = hub.list().await.into_iter().map(|a| (a.id, a.multi_account)).collect();
    for (agent_id, multi) in agents {
        let mut accounts = vec![DEFAULT_PROFILE.to_string()];
        if multi {
            accounts.extend(profiles.list().into_iter().filter(|p| p.agent_id == agent_id).map(|p| p.id));
        }
        for profile_id in accounts {
            let launch = Launch::from([(profiles::PROFILE_KEY.to_string(), profile_id.clone())]);
            // One agent failing (not installed, logged out) shouldn't hide the others.
            match hub.list_sessions(&agent_id, &cwd, &launch).await {
                Ok(sessions) => out.extend(sessions.into_iter().map(|mut s| {
                    s["agentId"] = json!(agent_id);
                    s["profileId"] = json!(profile_id);
                    s
                })),
                Err(e) => eprintln!("session/list {agent_id}/{profile_id}: {}", e.message),
            }
        }
    }
    Ok(out)
}

/// Bring a saved session into the app, as a chat or (with `team_id`) as a lead.
#[tauri::command]
async fn import_session(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    session_id: String,
    cwd: String,
    launch: Option<Launch>,
    team_id: Option<String>,
) -> Result<Value, HubError> {
    let (token, mcp, meta) = match &team_id {
        Some(team) => {
            let (token, mcp) = orchestra.register_lead(&agent_id, &cwd, team, Some(session_id.clone()));
            (Some(token), mcp, Orchestra::lead_meta(&agent_id))
        }
        None => (None, json!([]), Value::Null),
    };
    let res = hub.load_session(&agent_id, &session_id, &cwd, &launch.unwrap_or_default(), mcp, meta).await;
    if let (Err(_), Some(token)) = (&res, &token) {
        orchestra.forget_lead(token);
    }
    res
}

/// Switch a running conversation between chat (`team_id` = null) and agent mode.
#[tauri::command]
async fn switch_mode(
    hub: State<'_, Hub>,
    orchestra: State<'_, Orchestra>,
    agent_id: String,
    session_id: String,
    cwd: String,
    team_id: Option<String>,
) -> Result<Value, HubError> {
    orchestra.forget_session(&agent_id, &session_id);
    match team_id {
        Some(team) => {
            let (token, mcp) = orchestra.register_lead(&agent_id, &cwd, &team, Some(session_id.clone()));
            let res = hub.reattach(&agent_id, &session_id, mcp, Orchestra::lead_meta(&agent_id)).await;
            if res.is_err() {
                orchestra.forget_lead(&token);
            }
            res
        }
        None => hub.reattach(&agent_id, &session_id, json!([]), Value::Null).await,
    }
}

/// Merge a finished worktree task into the workspace (the user's button).
#[tauri::command]
async fn merge_task(orchestra: State<'_, Orchestra>, task_id: String) -> Result<Value, HubError> {
    orchestra.merge(&task_id).await.map_err(plain_error)
}

/// Throw away a worktree task's changes.
#[tauri::command]
async fn discard_task(orchestra: State<'_, Orchestra>, task_id: String) -> Result<Value, HubError> {
    orchestra.discard(&task_id).await.map_err(plain_error)
}

/// Leftover patches saved when worktrees were cleaned up.
#[tauri::command]
async fn list_unmerged(workspace: String) -> Result<Vec<worktree::UnmergedPatch>, String> {
    tokio::task::spawn_blocking(move || worktree::list_unmerged(Path::new(&workspace)))
        .await
        .map_err(|e| e.to_string())
}

/// Apply a leftover patch to the working tree; it is deleted only if it applied cleanly.
#[tauri::command]
async fn apply_unmerged(workspace: String, file: String) -> Result<worktree::ApplyOutcome, String> {
    tokio::task::spawn_blocking(move || worktree::apply_unmerged(Path::new(&workspace), &file))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_unmerged(workspace: String, file: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree::delete_unmerged(Path::new(&workspace), &file))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete the agent's own copy of a conversation (when the agent supports it).
#[tauri::command]
async fn delete_agent_session(
    hub: State<'_, Hub>,
    agent_id: String,
    session_id: String,
    cwd: String,
    launch: Option<Launch>,
) -> Result<bool, HubError> {
    hub.delete_agent_session(&agent_id, &session_id, &cwd, &launch.unwrap_or_default()).await
}

/// Which of these folders no longer exist (deleted, renamed, drive unplugged).
#[tauri::command]
fn missing_paths(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !std::path::Path::new(p).is_dir()).collect()
}

/// Change the team of a running lead conversation.
#[tauri::command]
fn set_lead_team(orchestra: State<'_, Orchestra>, agent_id: String, session_id: String, team_id: String) {
    orchestra.set_team(&agent_id, &session_id, &team_id);
}

/// The user wrote in a task's own chat; the lead sees it with the task's result.
#[tauri::command]
fn task_note(orchestra: State<'_, Orchestra>, task_id: String, text: String) {
    orchestra.add_note(&task_id, &text);
}

/// Each agent's last reported config options (models, modes, effort).
#[tauri::command]
fn agent_options(hub: State<'_, Hub>) -> HashMap<String, Value> {
    hub.agent_options()
}

#[tauri::command]
fn list_teams(teams: State<'_, Teams>) -> Vec<Team> {
    teams.all()
}

#[tauri::command]
fn save_team(teams: State<'_, Teams>, team: Team) -> Result<Team, HubError> {
    teams.save_team(team).map_err(plain_error)
}

#[tauri::command]
fn delete_team(teams: State<'_, Teams>, id: String) -> Result<(), HubError> {
    teams.delete(&id).map_err(plain_error)
}

#[tauri::command]
fn respond_permission(hub: State<'_, Hub>, key: String, option_id: Option<String>) -> Result<(), HubError> {
    hub.respond_permission(&key, option_id)
}

#[tauri::command]
async fn set_config_option(
    hub: State<'_, Hub>,
    agent_id: String,
    session_id: String,
    config_id: String,
    value: Value,
) -> Result<Value, HubError> {
    let params = json!({ "sessionId": session_id, "configId": config_id, "value": value });
    hub.call_session(&agent_id, &session_id, "session/set_config_option", params).await
}

#[tauri::command]
async fn set_mode(hub: State<'_, Hub>, agent_id: String, session_id: String, mode_id: String) -> Result<Value, HubError> {
    let params = json!({ "sessionId": session_id, "modeId": mode_id });
    hub.call_session(&agent_id, &session_id, "session/set_mode", params).await
}

#[tauri::command]
async fn stop_agent(hub: State<'_, Hub>, agent_id: String) -> Result<(), HubError> {
    hub.stop(&agent_id).await;
    Ok(())
}

fn plain_error(message: impl Into<String>) -> HubError {
    HubError { message: message.into(), auth_required: false, auth_methods: Value::Null }
}

/// Env that points a login at a profile's own home folder (empty for default).
fn profile_env(hub: &Hub, agent_id: &str, profile_id: Option<&str>) -> Result<Vec<(String, String)>, HubError> {
    let def = hub.def(agent_id)?;
    let Some((var, home)) = hub.profile_env(def, profile_id.unwrap_or(DEFAULT_PROFILE)) else {
        return Ok(Vec::new());
    };
    std::fs::create_dir_all(&home).map_err(|e| plain_error(e.to_string()))?;
    Ok(vec![(var, home.display().to_string())])
}

/// Run one of the agent's ACP `terminal` auth methods (its `args` appended to
/// the agent command) in a system terminal, for the given profile.
#[tauri::command]
fn open_login_terminal(
    hub: State<'_, Hub>,
    agent_id: String,
    extra_args: Vec<String>,
    profile_id: Option<String>,
) -> Result<(), HubError> {
    let def = hub.def(&agent_id)?;
    let args: Vec<String> = def.args.iter().chain(&extra_args).cloned().collect();
    let env = profile_env(&hub, &agent_id, profile_id.as_deref())?;
    login::open_in_terminal(&login::command_line(&def.command, &args, &env)).map_err(plain_error)
}

/// Run the agent's own login command (`loginArgs`) for a profile.
#[tauri::command]
fn login_profile(hub: State<'_, Hub>, agent_id: String, profile_id: String) -> Result<(), HubError> {
    let def = hub.def(&agent_id)?;
    if def.login_args.is_empty() {
        return Err(plain_error("이 에이전트는 로그인 명령이 설정돼 있지 않아요"));
    }
    let env = profile_env(&hub, &agent_id, Some(&profile_id))?;
    login::open_in_terminal(&login::command_line(&def.command, &def.login_args, &env)).map_err(plain_error)
}

#[tauri::command]
fn list_profiles(profiles: State<'_, Arc<Profiles>>) -> Vec<Profile> {
    profiles.list()
}

#[tauri::command]
fn create_profile(
    hub: State<'_, Hub>,
    profiles: State<'_, Arc<Profiles>>,
    agent_id: String,
    name: String,
) -> Result<Profile, HubError> {
    if hub.def(&agent_id)?.profile_env.is_none() {
        return Err(plain_error("이 에이전트는 여러 계정을 지원하지 않아요"));
    }
    if name.trim().is_empty() {
        return Err(plain_error("계정 이름을 입력해 주세요"));
    }
    profiles.create(&agent_id, &name).map_err(plain_error)
}

#[tauri::command]
fn rename_profile(profiles: State<'_, Arc<Profiles>>, id: String, name: String) -> Result<(), HubError> {
    if name.trim().is_empty() {
        return Err(plain_error("계정 이름을 입력해 주세요"));
    }
    profiles.rename(&id, &name).map_err(plain_error)
}

/// Stop the profile's agent processes, then delete it with its login folder.
#[tauri::command]
async fn delete_profile(
    hub: State<'_, Hub>,
    profiles: State<'_, Arc<Profiles>>,
    agent_id: String,
    id: String,
) -> Result<(), HubError> {
    hub.stop_profile(&agent_id, &id).await;
    profiles.delete(&id).map(|_| ()).map_err(plain_error)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell_env::inherit_login_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            legacy::migrate(app.handle());
            let dir = app.path().app_config_dir()?;
            let defs = agents::load_or_init(&dir).unwrap_or_else(|e| {
                eprintln!("agents.json 로드 실패, 기본값 사용: {e}");
                agents::default_agents()
            });
            let profiles = Arc::new(Profiles::load(&dir, &app.path().app_data_dir()?));
            let options_file = dir.join("agent-options.json");
            app.manage(Hub::new(app.handle().clone(), defs, profiles.clone(), options_file));
            app.manage(profiles);
            app.manage(Teams::load(&dir));
            app.manage(Orchestra::start(app.handle().clone())?);
            app.manage(Terminals::default());
            // Dev aid: BATON_DEBUG_LEAD=<workspace> registers a lead with no
            // chat behind it and prints its MCP endpoint, for testing tools by hand.
            if let Ok(cwd) = std::env::var("BATON_DEBUG_LEAD") {
                let orchestra = app.state::<Orchestra>();
                let (token, mcp) = orchestra.register_lead("claude", &cwd, teams::AUTO_TEAM, Some("debug-lead".into()));
                eprintln!("BATON_DEBUG_LEAD token={token} mcp={mcp}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            agents_config_path,
            new_session,
            resume_session,
            new_lead_session,
            resume_lead_session,
            task_note,
            set_lead_team,
            list_agent_sessions,
            import_session,
            switch_mode,
            merge_task,
            missing_paths,
            delete_agent_session,
            discard_task,
            list_unmerged,
            apply_unmerged,
            delete_unmerged,
            agent_options,
            list_teams,
            save_team,
            delete_team,
            send_prompt,
            cancel_prompt,
            respond_permission,
            set_config_option,
            set_mode,
            stop_agent,
            open_login_terminal,
            refresh_agents,
            attachments::save_attachment,
            attachments::allow_previews,
            attachments::open_attachment,
            install_agent,
            login_profile,
            list_profiles,
            create_profile,
            rename_profile,
            delete_profile,
            history::save_session,
            history::load_sessions,
            history::delete_session,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Baton")
        .run(|app, event| {
            // Shells in the terminal tab end with the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<Terminals>().kill_all();
            }
        });
}
