pub mod acp;
pub mod agents;
mod history;
mod hub;
mod legacy;
mod login;
mod profiles;
mod shell_env;

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Manager, State};

use hub::{AgentInfo, Hub, HubError, Launch};
use profiles::{Profile, Profiles, DEFAULT_PROFILE};

#[tauri::command]
async fn list_agents(hub: State<'_, Hub>) -> Result<Vec<AgentInfo>, HubError> {
    Ok(hub.list().await)
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
    hub.new_session(&agent_id, &cwd, &launch.unwrap_or_default()).await
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
    hub.resume_session(&agent_id, &session_id, &cwd, &launch.unwrap_or_default()).await
}

#[tauri::command]
async fn send_prompt(
    hub: State<'_, Hub>,
    agent_id: String,
    session_id: String,
    text: String,
) -> Result<Value, HubError> {
    hub.prompt(&agent_id, &session_id, &text).await
}

#[tauri::command]
async fn cancel_prompt(hub: State<'_, Hub>, agent_id: String, session_id: String) -> Result<(), HubError> {
    hub.cancel(&agent_id, &session_id).await
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
        .setup(|app| {
            legacy::migrate(app.handle());
            let dir = app.path().app_config_dir()?;
            let defs = agents::load_or_init(&dir).unwrap_or_else(|e| {
                eprintln!("agents.json 로드 실패, 기본값 사용: {e}");
                agents::default_agents()
            });
            let profiles = Arc::new(Profiles::load(&dir, &app.path().app_data_dir()?));
            app.manage(Hub::new(app.handle().clone(), defs, profiles.clone()));
            app.manage(profiles);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            agents_config_path,
            new_session,
            resume_session,
            send_prompt,
            cancel_prompt,
            respond_permission,
            set_config_option,
            set_mode,
            stop_agent,
            open_login_terminal,
            login_profile,
            list_profiles,
            create_profile,
            rename_profile,
            delete_profile,
            history::save_session,
            history::load_sessions,
            history::delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Baton");
}
