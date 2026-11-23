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
} from "./types";

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
  resumeSession: (agentId: string, sessionId: string, cwd: string, launch: Launch) =>
    invoke<Omit<NewSessionResult, "sessionId">>("resume_session", { agentId, sessionId, cwd, launch }),
  saveSession: (key: string, data: unknown) => invoke<void>("save_session", { key, data }),
  loadSessions: () => invoke<unknown[]>("load_sessions"),
  deleteSession: (key: string) => invoke<void>("delete_session", { key }),
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
  ]);
  return () => offs.forEach((off) => off());
}
