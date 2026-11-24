import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentInfo,
  AgentStatus,
  AuthStatus,
  ConfigOption,
  HubError,
  Launch,
  PermissionRequest,
  Profile,
  SessionModes,
  TaskInfo,
  Team,
} from "./types";

/** A session an agent has saved for a folder (ACP `session/list`). */
export interface AgentSessionInfo {
  agentId: string;
  profileId: string;
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface ImportResult {
  /** Replayed `session/update`s, when the agent can replay. */
  updates: unknown[];
  replayed: boolean;
  configOptions?: ConfigOption[] | null;
  modes?: SessionModes | null;
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: ConfigOption[] | null;
  modes?: SessionModes | null;
}

export const api = {
  listAgents: () => invoke<AgentInfo[]>("list_agents"),
  agentsConfigPath: () => invoke<string>("agents_config_path"),
  newSession: (agentId: string, cwd: string, launch: Launch) =>
    invoke<NewSessionResult>("new_session", { agentId, cwd, launch }),
  newLeadSession: (agentId: string, cwd: string, launch: Launch, teamId: string) =>
    invoke<NewSessionResult>("new_lead_session", { agentId, cwd, launch, teamId }),
  resumeLeadSession: (agentId: string, sessionId: string, cwd: string, launch: Launch, teamId: string) =>
    invoke<Omit<NewSessionResult, "sessionId">>("resume_lead_session", { agentId, sessionId, cwd, launch, teamId }),
  taskNote: (taskId: string, text: string) => invoke<void>("task_note", { taskId, text }),
  listAgentSessions: (cwd: string) => invoke<AgentSessionInfo[]>("list_agent_sessions", { cwd }),
  importSession: (agentId: string, sessionId: string, cwd: string, launch: Launch, teamId: string | null) =>
    invoke<ImportResult>("import_session", { agentId, sessionId, cwd, launch, teamId }),
  switchMode: (agentId: string, sessionId: string, cwd: string, teamId: string | null) =>
    invoke<Omit<NewSessionResult, "sessionId">>("switch_mode", { agentId, sessionId, cwd, teamId }),
  missingPaths: (paths: string[]) => invoke<string[]>("missing_paths", { paths }),
  mergeTask: (taskId: string) =>
    invoke<{ merged_files: string[]; conflicts: string[] }>("merge_task", { taskId }),
  discardTask: (taskId: string) => invoke<void>("discard_task", { taskId }),
  setLeadTeam: (agentId: string, sessionId: string, teamId: string) =>
    invoke<void>("set_lead_team", { agentId, sessionId, teamId }),
  listTeams: () => invoke<Team[]>("list_teams"),
  agentOptions: () => invoke<Record<string, ConfigOption[]>>("agent_options"),
  saveTeam: (team: Team) => invoke<Team>("save_team", { team }),
  deleteTeam: (id: string) => invoke<void>("delete_team", { id }),
  resumeSession: (agentId: string, sessionId: string, cwd: string, launch: Launch) =>
    invoke<Omit<NewSessionResult, "sessionId">>("resume_session", { agentId, sessionId, cwd, launch }),
  /** Conversations live in `<workspace>/.baton/sessions`. */
  saveSession: (workspace: string, key: string, data: unknown) =>
    invoke<void>("save_session", { workspace, key, data }),
  loadSessions: (workspaces: string[]) => invoke<unknown[]>("load_sessions", { workspaces }),
  deleteSession: (workspace: string, key: string) => invoke<void>("delete_session", { workspace, key }),
  /** Remove the agent's own copy (true if the agent supports deleting). */
  deleteAgentSession: (agentId: string, sessionId: string, cwd: string, launch: Launch) =>
    invoke<boolean>("delete_agent_session", { agentId, sessionId, cwd, launch }),
  sendPrompt: (agentId: string, sessionId: string, text: string) =>
    invoke<{
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
    }>("send_prompt", { agentId, sessionId, text }),
  cancelPrompt: (agentId: string, sessionId: string) => invoke<void>("cancel_prompt", { agentId, sessionId }),
  respondPermission: (key: string, optionId: string | null) => invoke<void>("respond_permission", { key, optionId }),
  setConfigOption: (agentId: string, sessionId: string, configId: string, value: unknown) =>
    invoke<{ configOptions?: ConfigOption[] }>("set_config_option", { agentId, sessionId, configId, value }),
  setMode: (agentId: string, sessionId: string, modeId: string) =>
    invoke<unknown>("set_mode", { agentId, sessionId, modeId }),
  stopAgent: (agentId: string) => invoke<void>("stop_agent", { agentId }),
  openLoginTerminal: (agentId: string, extraArgs: string[], profileId: string) =>
    invoke<void>("open_login_terminal", { agentId, extraArgs, profileId }),
  loginProfile: (agentId: string, profileId: string) => invoke<void>("login_profile", { agentId, profileId }),
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  createProfile: (agentId: string, name: string) => invoke<Profile>("create_profile", { agentId, name }),
  renameProfile: (id: string, name: string) => invoke<void>("rename_profile", { id, name }),
  deleteProfile: (agentId: string, id: string) => invoke<void>("delete_profile", { agentId, id }),
};

export function toHubError(e: unknown): HubError {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as Partial<HubError>;
    return { message: String(err.message), authRequired: !!err.authRequired, authMethods: err.authMethods ?? null };
  }
  return { message: String(e), authRequired: false, authMethods: null };
}

export interface HubEvents {
  onUpdate: (agentId: string, profileId: string, sessionId: string, update: unknown) => void;
  onAuth: (agentId: string, profileId: string, status: AuthStatus | null) => void;
  onPermission: (req: PermissionRequest) => void;
  onStatus: (agentId: string, status: AgentStatus, message: string | null) => void;
  onLog: (agentId: string, line: string) => void;
  onTask: (task: TaskInfo) => void;
  onTaskSession: (e: TaskSessionEvent) => void;
  onTaskBrief: (task: TaskInfo, text: string) => void;
}

export interface TaskSessionEvent {
  task: TaskInfo;
  session: {
    agentId: string;
    sessionId: string;
    cwd: string;
    launch: Launch;
    configOptions: ConfigOption[] | null;
    modes: SessionModes | null;
  };
  brief: string;
}

export async function subscribe(h: HubEvents): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<{ agentId: string; profileId: string; sessionId: string; update: unknown }>("acp-update", (e) =>
      h.onUpdate(e.payload.agentId, e.payload.profileId, e.payload.sessionId, e.payload.update),
    ),
    listen<{ agentId: string; profileId: string; authStatus: AuthStatus | null }>("agent-auth", (e) =>
      h.onAuth(e.payload.agentId, e.payload.profileId, e.payload.authStatus),
    ),
    listen<PermissionRequest>("acp-permission", (e) => h.onPermission(e.payload)),
    listen<{ agentId: string; status: AgentStatus; message: string | null }>("agent-status", (e) =>
      h.onStatus(e.payload.agentId, e.payload.status, e.payload.message),
    ),
    listen<{ agentId: string; line: string }>("agent-log", (e) => h.onLog(e.payload.agentId, e.payload.line)),
    listen<TaskInfo>("task-update", (e) => h.onTask(e.payload)),
    listen<TaskSessionEvent>("task-session", (e) => h.onTaskSession(e.payload)),
    listen<{ task: TaskInfo; text: string }>("task-brief", (e) => h.onTaskBrief(e.payload.task, e.payload.text)),
  ]);
  return () => offs.forEach((off) => off());
}
