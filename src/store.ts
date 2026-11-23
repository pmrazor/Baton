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
  TaskInfo,
  Team,
  ToolCallFields,
  TurnStats,
} from "./types";
import { accountKey, isTaskActive, sessionKey } from "./types";
import type { TaskSessionEvent } from "./api";
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
  teams: Team[];
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
  teams: [],
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
      lead?: { teamId: string };
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
  | { type: "teams"; teams: Team[] }
  | { type: "leadTeam"; key: string; teamId: string }
  | {
      type: "importSession";
      agentId: string;
      sessionId: string;
      cwd: string;
      launch: Launch;
      title: string;
      updatedAt: number;
      updates: unknown[];
      replayed: boolean;
      configOptions: ConfigOption[];
      modes: SessionModes | null;
      lead?: { teamId: string };
    }
  | { type: "modeSwitched"; key: string; lead?: { teamId: string }; configOptions?: ConfigOption[] | null; note: string }
  | { type: "taskUpdate"; task: TaskInfo }
  | { type: "taskSession"; event: TaskSessionEvent }
  | { type: "taskBrief"; task: TaskInfo; text: string }
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
        lead: action.lead,
        tasks: action.lead ? [] : undefined,
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
    case "teams":
      return { ...state, teams: action.teams };
    case "importSession": {
      const key = sessionKey(action.agentId, action.sessionId);
      if (state.sessions.some((s) => s.key === key)) return state;
      let session: Session = {
        key,
        agentId: action.agentId,
        sessionId: action.sessionId,
        cwd: action.cwd,
        title: action.title,
        items: [],
        busy: false,
        configOptions: action.configOptions,
        modes: action.modes,
        createdAt: action.updatedAt,
        updatedAt: action.updatedAt,
        draft: false,
        attached: true,
        launch: action.launch,
        lead: action.lead,
        tasks: action.lead ? [] : undefined,
        usage: null,
        lastTurn: null,
      };
      for (const u of action.updates) session = applyUpdate(session, u, true);
      session = { ...session, items: cleanReplay(session.items) };
      if (!action.replayed) {
        session.items.push({
          kind: "notice",
          id: nextId(),
          tone: "info",
          text: "이 에이전트는 지난 대화 내용을 다시 보내 주지 않아 화면에는 없지만, 에이전트는 기억하고 있어요.",
        });
      }
      return { ...state, sessions: [...state.sessions, session] };
    }
    case "modeSwitched":
      return mapSession(state, action.key, (s) => ({
        ...s,
        lead: action.lead,
        tasks: action.lead ? (s.tasks ?? []) : s.tasks,
        configOptions: action.configOptions?.length ? action.configOptions : s.configOptions,
        items: [...s.items, { kind: "notice", id: nextId(), text: action.note, tone: "info" }],
      }));
    case "leadTeam":
      return mapSession(state, action.key, (s) => (s.lead ? { ...s, lead: { teamId: action.teamId } } : s));
    case "taskUpdate":
      return applyTask(state, action.task);
    case "taskSession": {
      const { task, session, brief } = action.event;
      const key = sessionKey(session.agentId, session.sessionId);
      if (state.sessions.some((s) => s.key === key)) return applyTask(state, task);
      const now = Date.now();
      const sub: Session = {
        key,
        agentId: session.agentId,
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: task.title,
        items: [{ kind: "brief", id: nextId(), text: brief, label: "총괄이 맡긴 작업", startedAt: now }],
        busy: false,
        configOptions: session.configOptions ?? [],
        modes: session.modes ?? null,
        createdAt: now,
        updatedAt: now,
        draft: false,
        attached: true,
        launch: session.launch ?? {},
        parent: { key: sessionKey(task.leadAgentId, task.leadSessionId), taskId: task.id },
        usage: null,
        lastTurn: null,
      };
      return applyTask({ ...state, sessions: [...state.sessions, sub] }, task);
    }
    case "taskBrief": {
      if (!action.task.sessionId) return state;
      const key = sessionKey(action.task.agentId, action.task.sessionId);
      return mapSession(state, key, (s) => ({
        ...s,
        updatedAt: Date.now(),
        items: [
          ...s.items,
          { kind: "brief", id: nextId(), text: action.text, label: "총괄의 추가 지시", startedAt: Date.now() },
        ],
      }));
    }
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

/** Record a task's status on its lead, and mirror it on the task's own chat. */
function applyTask(state: State, task: TaskInfo): State {
  const leadKey = sessionKey(task.leadAgentId, task.leadSessionId);
  let next = mapSession(state, leadKey, (lead) => {
    const tasks = lead.tasks ?? [];
    const prev = tasks.find((t) => t.id === task.id);
    // A task belongs to the lead turn that was running when it first appeared.
    const turnId = prev?.turnId ?? lead.items.filter((i) => i.kind === "user").at(-1)?.id;
    const merged = { ...task, turnId };
    return {
      ...lead,
      tasks: prev ? tasks.map((t) => (t.id === task.id ? merged : t)) : [...tasks, merged],
    };
  });
  if (task.sessionId) {
    const running = task.status === "running";
    const finished = !isTaskActive(task.status);
    next = mapSession(next, sessionKey(task.agentId, task.sessionId), (s) => ({
      ...s,
      busy: running,
      updatedAt: Date.now(),
      items: finished ? stampTurnDuration(s.items) : s.items,
    }));
  }
  return next;
}

/** When a turn ends, record how long it took on the message that started it. */
function stampTurnDuration(items: ChatItem[]): ChatItem[] {
  const idx = items.findLastIndex((i) => i.kind === "user" || i.kind === "brief");
  const user = items[idx];
  if (!user || (user.kind !== "user" && user.kind !== "brief") || !user.startedAt || user.durationMs !== undefined)
    return items;
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

/**
 * Strip the notes Baton itself put in front of messages it sent (agent-mode
 * note, task preamble), which come back when a conversation is replayed.
 */
function cleanReplay(items: ChatItem[]): ChatItem[] {
  return items.map((it) => {
    if (it.kind !== "user") return it;
    let text = it.text;
    if (text.startsWith("[Baton agent mode")) {
      const i = text.indexOf("[User message]\n");
      if (i >= 0) text = text.slice(i + "[User message]\n".length);
    } else if (text.startsWith("[Baton] A lead agent")) {
      const i = text.indexOf("\n\n");
      if (i >= 0) text = text.slice(i + 2);
    }
    return text === it.text ? it : { ...it, text };
  });
}

/** `replay`: the update comes from a loaded conversation, so user messages count. */
function applyUpdate(s: Session, u: any, replay = false): Session {
  if (!u || typeof u !== "object") return s;
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      // Live turns already show the user's message; only a replay needs it.
      if (!replay) return s;
      const c = u.content ?? {};
      const text = c.type === "text" ? (c.text ?? "") : `[${c.type ?? "content"}]`;
      const last = s.items.at(-1);
      if (last && last.kind === "user") {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + text }] };
      }
      return { ...s, items: [...s.items, { kind: "user", id: nextId(), text }] };
    }
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
      const lastUser = s.items.findLastIndex((i) => i.kind === "user" || i.kind === "brief");
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
