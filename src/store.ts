import type {
  AccountUsage,
  AgentInfo,
  AuthStatus,
  AgentStatus,
  AuthMethod,
  ChatItem,
  ConfigOption,
  Launch,
  PermissionRequest,
  Profile,
  Session,
  SessionModes,
  ToolCallFields,
  TurnStats,
} from "./types";
import { accountKey, sessionKey } from "./types";
import { quotasFromUpdate } from "./usage";

export interface AuthPrompt {
  agentId: string;
  profileId: string;
  message: string;
  methods: AuthMethod[];
}

export interface State {
  agents: AgentInfo[];
  status: Record<string, { status: AgentStatus; message?: string | null }>;
  logs: Record<string, string[]>;
  /** Folders the user has opened, in sidebar order. */
  workspaces: string[];
  /** Workspace new chats start in. */
  workspace: string | null;
  sessions: Session[];
  activeKey: string | null;
  permissions: PermissionRequest[];
  authPrompt: AuthPrompt | null;
  /** Account-level limits, keyed by accountKey(agent, profile). */
  accountUsage: Record<string, AccountUsage>;
  /** Logged-in identity per account, keyed by accountKey(agent, profile). */
  identities: Record<string, AuthStatus>;
  profiles: Profile[];
}

export const initialState: State = {
  agents: [],
  status: {},
  logs: {},
  workspaces: [],
  workspace: null,
  sessions: [],
  activeKey: null,
  permissions: [],
  authPrompt: null,
  accountUsage: {},
  identities: {},
  profiles: [],
};

export type Action =
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "agentStatus"; agentId: string; status: AgentStatus; message?: string | null }
  | { type: "log"; agentId: string; line: string }
  | { type: "workspaceAdd"; path: string }
  | { type: "workspaceSelect"; path: string }
  | { type: "workspaceRemove"; path: string }
  | { type: "turnDone"; key: string; stats: TurnStats }
  | {
      type: "sessionCreated";
      agentId: string;
      sessionId: string;
      cwd: string;
      title: string;
      launch: Launch;
      configOptions: ConfigOption[];
      modes: SessionModes | null;
    }
  | { type: "activate"; key: string | null }
  | { type: "restore"; sessions: Session[]; activeKey: string | null }
  | { type: "attached"; key: string; configOptions: ConfigOption[]; modes: SessionModes | null }
  | { type: "rekey"; key: string; sessionId: string; configOptions: ConfigOption[]; modes: SessionModes | null }
  | { type: "dropDrafts" }
  | { type: "closeSession"; key: string }
  | { type: "userMessage"; key: string; text: string }
  | { type: "busy"; key: string; busy: boolean }
  | { type: "notice"; key: string; text: string; tone: "info" | "error" }
  | { type: "update"; agentId: string; profileId: string; sessionId: string; update: any }
  | { type: "auth"; agentId: string; profileId: string; status: AuthStatus | null }
  | { type: "profiles"; profiles: Profile[] }
  | { type: "configOptions"; key: string; configOptions: ConfigOption[] }
  | { type: "mode"; key: string; modeId: string }
  | { type: "permissionAdd"; request: PermissionRequest }
  | { type: "permissionRemove"; key: string }
  | { type: "authPrompt"; prompt: AuthPrompt | null };

const MAX_LOG_LINES = 500;
// Prefix per app run so ids never collide with items restored from disk.
const RUN = Math.random().toString(36).slice(2, 8);
let idCounter = 0;
const nextId = () => `${RUN}-${++idCounter}`;

function mapSession(state: State, key: string, fn: (s: Session) => Session): State {
  return { ...state, sessions: state.sessions.map((s) => (s.key === key ? fn(s) : s)) };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "agents":
      return { ...state, agents: action.agents };
    case "agentStatus":
      return {
        ...state,
        status: { ...state.status, [action.agentId]: { status: action.status, message: action.message } },
      };
    case "log": {
      const prev = state.logs[action.agentId] ?? [];
      const next = [...prev, action.line].slice(-MAX_LOG_LINES);
      return { ...state, logs: { ...state.logs, [action.agentId]: next } };
    }
    case "workspaceAdd": {
      const workspaces = state.workspaces.includes(action.path) ? state.workspaces : [...state.workspaces, action.path];
      return { ...state, workspaces, workspace: action.path };
    }
    case "workspaceSelect":
      return { ...state, workspace: action.path };
    case "workspaceRemove": {
      // History is kept (hidden) so re-adding the folder brings it back.
      const workspaces = state.workspaces.filter((w) => w !== action.path);
      const sessions = state.sessions.filter((s) => s.cwd !== action.path || !s.draft);
      const workspace = state.workspace === action.path ? (workspaces[0] ?? null) : state.workspace;
      const active = sessions.find((s) => s.key === state.activeKey);
      const activeKey = active && active.cwd !== action.path ? state.activeKey : null;
      return { ...state, workspaces, workspace, sessions, activeKey };
    }
    case "turnDone":
      return mapSession(state, action.key, (s) => ({ ...s, lastTurn: action.stats, updatedAt: Date.now() }));
    case "sessionCreated": {
      const key = sessionKey(action.agentId, action.sessionId);
      const session: Session = {
        key,
        agentId: action.agentId,
        sessionId: action.sessionId,
        cwd: action.cwd,
        title: action.title,
        items: [],
        busy: false,
        configOptions: action.configOptions,
        modes: action.modes,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        draft: true,
        attached: true,
        launch: action.launch,
        usage: null,
        lastTurn: null,
      };
      return {
        ...state,
        sessions: [...state.sessions, session],
        activeKey: key,
        workspace: action.cwd,
        authPrompt: null,
      };
    }
    case "activate": {
      const cwd = state.sessions.find((s) => s.key === action.key)?.cwd;
      // Leaving an unused draft discards it.
      const sessions = state.sessions.filter((s) => !s.draft || s.key === action.key);
      return { ...state, sessions, activeKey: action.key, workspace: cwd ?? state.workspace };
    }
    case "restore": {
      const known = new Set(state.sessions.map((s) => s.key));
      const sessions = [...action.sessions.filter((s) => !known.has(s.key)), ...state.sessions];
      // Sessions of folders no longer listed stay loaded but hidden; re-adding the folder shows them.
      // With no folder list at all (first run, or data carried over from an older install),
      // rebuild it from the history so nothing is invisible.
      const workspaces =
        state.workspaces.length > 0 ? state.workspaces : [...new Set(sessions.map((s) => s.cwd))];
      const active = sessions.find((s) => s.key === action.activeKey && workspaces.includes(s.cwd));
      return {
        ...state,
        sessions,
        workspaces,
        activeKey: state.activeKey ?? active?.key ?? null,
        workspace: state.activeKey ? state.workspace : (active?.cwd ?? state.workspace ?? workspaces[0] ?? null),
      };
    }
    case "attached":
      return mapSession(state, action.key, (s) => ({
        ...s,
        attached: true,
        configOptions: action.configOptions.length ? action.configOptions : s.configOptions,
        modes: action.modes ?? s.modes,
      }));
    case "rekey": {
      const key = sessionKey(state.sessions.find((s) => s.key === action.key)?.agentId ?? "", action.sessionId);
      return {
        ...mapSession(state, action.key, (s) => ({
          ...s,
          key,
          sessionId: action.sessionId,
          attached: true,
          configOptions: action.configOptions,
          modes: action.modes,
        })),
        activeKey: state.activeKey === action.key ? key : state.activeKey,
      };
    }
    case "dropDrafts": {
      const sessions = state.sessions.filter((s) => !s.draft);
      const activeKey = sessions.some((s) => s.key === state.activeKey) ? state.activeKey : null;
      return { ...state, sessions, activeKey };
    }
    case "closeSession": {
      const sessions = state.sessions.filter((s) => s.key !== action.key);
      const activeKey = state.activeKey === action.key ? null : state.activeKey;
      return { ...state, sessions, activeKey };
    }
    case "userMessage":
      return mapSession(state, action.key, (s) => ({
        ...s,
        title: s.items.length === 0 ? action.text.slice(0, 40) : s.title,
        draft: false,
        updatedAt: Date.now(),
        items: [...s.items, { kind: "user", id: nextId(), text: action.text, startedAt: Date.now() }],
      }));
    case "busy":
      return mapSession(state, action.key, (s) => ({
        ...s,
        busy: action.busy,
        items: action.busy ? s.items : stampTurnDuration(s.items),
      }));
    case "notice":
      return mapSession(state, action.key, (s) => ({
        ...s,
        items: [...s.items, { kind: "notice", id: nextId(), text: action.text, tone: action.tone }],
      }));
    case "update": {
      const next = mapSession(state, sessionKey(action.agentId, action.sessionId), (s) => applyUpdate(s, action.update));
      const quotas = quotasFromUpdate(action.update);
      if (quotas.length === 0) return next;
      const account = accountKey(action.agentId, action.profileId);
      const entries = { ...next.accountUsage[account]?.entries };
      for (const q of quotas) entries[q.id] = q;
      return {
        ...next,
        accountUsage: { ...next.accountUsage, [account]: { entries, updatedAt: Date.now() } },
      };
    }
    case "auth": {
      const account = accountKey(action.agentId, action.profileId);
      const identities = { ...state.identities };
      if (action.status) identities[account] = action.status;
      else delete identities[account];
      return { ...state, identities };
    }
    case "profiles":
      return { ...state, profiles: action.profiles };
    case "configOptions":
      return mapSession(state, action.key, (s) => ({ ...s, configOptions: action.configOptions }));
    case "mode":
      return mapSession(state, action.key, (s) =>
        s.modes ? { ...s, modes: { ...s.modes, currentModeId: action.modeId } } : s,
      );
    case "permissionAdd":
      return { ...state, permissions: [...state.permissions, action.request] };
    case "permissionRemove":
      return { ...state, permissions: state.permissions.filter((p) => p.key !== action.key) };
    case "authPrompt":
      return { ...state, authPrompt: action.prompt };
  }
}

/** When a turn ends, record how long it took on the user message that started it. */
function stampTurnDuration(items: ChatItem[]): ChatItem[] {
  const idx = items.map((i) => i.kind).lastIndexOf("user");
  const user = items[idx];
  if (!user || user.kind !== "user" || !user.startedAt || user.durationMs !== undefined) return items;
  const stamped = { ...user, durationMs: Date.now() - user.startedAt };
  return items.map((it, i) => (i === idx ? stamped : it));
}

/** Append streamed text to the trailing item of the same kind, or start one. */
function appendText(items: ChatItem[], kind: "assistant" | "thought", text: string): ChatItem[] {
  const last = items.at(-1);
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind, id: nextId(), text }];
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function upsertTool(items: ChatItem[], u: Partial<ToolCallFields> & { toolCallId: string }): ChatItem[] {
  // ACP's `kind` is the tool category; ours is the ChatItem discriminator.
  const raw: Record<string, unknown> = { ...u, toolKind: u.kind };
  delete raw.kind;
  delete raw.sessionUpdate;
  // Updates only carry changed fields; drop nulls so they don't erase data.
  const patch = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));

  const idx = items.findIndex((i) => i.kind === "tool" && i.toolCallId === u.toolCallId);
  if (idx === -1) {
    const fresh: ToolItem = {
      kind: "tool",
      id: nextId(),
      toolCallId: u.toolCallId,
      title: "도구 실행",
      toolKind: "other",
      status: "pending",
      content: [],
      locations: [],
      rawInput: undefined,
      ...patch,
    };
    return [...items, fresh];
  }
  return items.map((it, i) => (i === idx ? ({ ...it, ...patch } as ToolItem) : it));
}

function applyUpdate(s: Session, u: any): Session {
  if (!u || typeof u !== "object") return s;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const kind = u.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought";
      const c = u.content ?? {};
      const text = c.type === "text" ? (c.text ?? "") : `\n[${c.type ?? "content"}]\n`;
      return { ...s, items: appendText(s.items, kind, text) };
    }
    case "tool_call":
    case "tool_call_update":
      return { ...s, items: upsertTool(s.items, u) };
    case "plan": {
      // One live plan per turn: replace the plan since the last user message.
      const lastUser = s.items.map((i) => i.kind).lastIndexOf("user");
      const idx = s.items.findIndex((i, n) => n > lastUser && i.kind === "plan");
      const plan: ChatItem = { kind: "plan", id: idx >= 0 ? s.items[idx].id : nextId(), entries: u.entries ?? [] };
      const items = idx >= 0 ? s.items.map((it, n) => (n === idx ? plan : it)) : [...s.items, plan];
      return { ...s, items };
    }
    case "config_option_update":
      return { ...s, configOptions: u.configOptions ?? s.configOptions };
    case "current_mode_update":
      return s.modes ? { ...s, modes: { ...s.modes, currentModeId: u.currentModeId } } : s;
    case "usage_update":
      return { ...s, usage: { used: u.used, size: u.size, cost: u.cost ?? s.usage?.cost ?? null } };
    case "session_info_update":
      return typeof u.title === "string" && u.title ? { ...s, title: u.title } : s;
    case "notice": {
      const text = u.message ?? u.text ?? JSON.stringify(u);
      return { ...s, items: [...s.items, { kind: "notice", id: nextId(), text: String(text), tone: "info" }] };
    }
    default:
      return s;
  }
}
