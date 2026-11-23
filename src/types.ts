// Shapes shared between the Rust hub and the UI. ACP payloads are kept loose
// (`unknown` / optional fields) because agents vary in what they send.

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  loginHint: string;
  running: boolean;
  launchOptions: LaunchOption[];
  /** Can hold several logged-in accounts (profiles). */
  multiAccount: boolean;
  loginNote: string;
}

/** A named account of one agent. "default" is the user's existing login. */
export interface Profile {
  id: string;
  agentId: string;
  name: string;
}

export const DEFAULT_PROFILE = "default";
export const profileOf = (launch: Launch | undefined) => launch?.profile ?? DEFAULT_PROFILE;
/** Key for per-account state (usage, identity). */
export const accountKey = (agentId: string, profileId: string) => `${agentId}/${profileId}`;

/** Who is logged in, as reported by the agent (Claude's `_auth/status_update`). */
export interface AuthStatus {
  kind: string;
  label?: string;
  account?: { email?: string; plan?: string; organization?: string };
}

/** A choice fixed when the agent process starts (e.g. dsh's permission mode). */
export interface LaunchOption {
  id: string;
  name: string;
  category?: string | null;
  default: string;
  choices: { value: string; name: string; description?: string }[];
}

export type Launch = Record<string, string>;

export type AgentStatus = "idle" | "starting" | "ready" | "exited" | "error";

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  type?: string;
  args?: string[];
}

export interface HubError {
  message: string;
  authRequired: boolean;
  authMethods: AuthMethod[] | null;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface PermissionRequest {
  key: string;
  agentId: string;
  sessionId: string;
  toolCall: Partial<ToolCallFields> | null;
  options: PermissionOption[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface ToolCallContent {
  type: "content" | "diff" | "terminal" | string;
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

export interface ToolCallFields {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  content: ToolCallContent[];
  locations: { path: string; line?: number | null }[];
  rawInput: unknown;
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; startedAt?: number; durationMs?: number }
  /** An instruction a lead agent gave this task (agent mode). Starts a turn like a user message. */
  | { kind: "brief"; id: string; text: string; label: string; startedAt?: number; durationMs?: number }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | ({ kind: "tool"; id: string; toolKind: string } & Omit<ToolCallFields, "kind">)
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export interface SelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean" | string;
  currentValue: string | boolean;
  options?: (SelectOption | { group: string; name: string; options: SelectOption[] })[];
}

export interface SessionModes {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string | null }[];
}

export interface Session {
  key: string;
  agentId: string;
  sessionId: string;
  cwd: string;
  title: string;
  items: ChatItem[];
  busy: boolean;
  configOptions: ConfigOption[];
  modes: SessionModes | null;
  createdAt: number;
  /** Last message or reply; drives sidebar ordering. */
  updatedAt: number;
  /** Opened via "새 대화" but no message sent yet; hidden from the sidebar. */
  draft: boolean;
  /** False for transcripts restored from disk until the agent session is resumed. */
  attached: boolean;
  /** Launch option values the session's process was started with. */
  launch: Launch;
  /** Why reconnecting failed; set to stop automatic retries until the user asks. */
  attachError?: string;
  /** Set on a lead (agent mode) conversation. */
  lead?: { teamId: string };
  /** Tasks this lead handed out, newest last. */
  tasks?: TaskInfo[];
  /** Set on a task's conversation: the lead it belongs to. */
  parent?: { key: string; taskId: string };
  /** Context-window usage reported by the agent (`usage_update`). */
  usage: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  /** Numbers from the last finished turn. */
  lastTurn: TurnStats | null;
}

export interface TurnStats {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
}

export const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`;

/** One account-level limit (e.g. a plan's 5-hour window). Agent-agnostic. */
export interface QuotaEntry {
  id: string;
  label: string;
  status: "ok" | "warning" | "limited";
  /** Percent used, 0–100, when the agent reports it. */
  utilization?: number;
  /** Epoch ms. */
  resetsAt?: number;
  detail?: string;
}

export interface AccountUsage {
  entries: Record<string, QuotaEntry>;
  updatedAt: number;
}

export type TaskStatus = "queued" | "starting" | "waiting_lock" | "running" | "done" | "failed" | "cancelled";

/** A task a lead delegated (mirrors the backend's TaskInfo). */
export interface TaskInfo {
  id: string;
  leadAgentId: string;
  leadSessionId: string;
  title: string;
  memberId: string;
  memberName: string;
  agentId: string;
  sessionId: string | null;
  status: TaskStatus;
  writes: boolean;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** Runs in its own git worktree; merged into the workspace on request. */
  isolated: boolean;
  /** Changed files, e.g. "M src/a.rs" (isolated tasks). */
  changes: string[];
  mergeState: "none" | "pending" | "merged" | "conflict" | "discarded" | null;
  conflicts: string[];
  /** The lead's user message (turn) this task was created in. */
  turnId?: string;
}

export const isTaskActive = (s: TaskStatus) => s !== "done" && s !== "failed" && s !== "cancelled";

export interface TeamMember {
  id: string;
  name: string;
  agentId: string;
  profileId: string;
  launch: Record<string, string>;
  config: Record<string, unknown>;
  role: string;
}

export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  maxParallel: number;
  /** How file-writing tasks share a git workspace. */
  isolation: "worktree" | "shared";
}

export const AUTO_TEAM = "auto";
