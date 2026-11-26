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
  /** Has its own login command, run in a terminal. */
  canLogin: boolean;
  /** Its program was found on this computer. */
  installed: boolean;
  install: InstallInfo | null;
}

export interface InstallInfo {
  /** What the install button runs in a terminal; null = install by hand (see url). */
  command: string | null;
  url: string;
  note: string;
  /** Required programs that are missing, e.g. "npm". */
  missing: string[];
}

/** A file attached to a message (sent to the agent by path). */
export interface Attachment {
  path: string;
  name: string;
  image: boolean;
  /** Shown as a thumbnail; sent to the agent as a file link. */
  video?: boolean;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

export function attachmentOf(path: string): Attachment {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return { path, name, image: IMAGE_EXT.test(name), ...(VIDEO_EXT.test(name) ? { video: true } : {}) };
}

/** Agents that can be started here, for pickers. */
export const installedAgents = (agents: AgentInfo[]) => agents.filter((a) => a.installed);

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
  | {
      kind: "user";
      id: string;
      text: string;
      startedAt?: number;
      durationMs?: number;
      attachments?: Attachment[];
      /** Small note over the bubble, e.g. a message delivered while the agent was working. */
      tag?: string;
    }
  /** An instruction a lead agent gave this task (agent mode). Starts a turn like a user message. */
  | {
      kind: "brief";
      id: string;
      text: string;
      label: string;
      startedAt?: number;
      durationMs?: number;
      /** Files the lead passed on with the instruction. */
      attachments?: Attachment[];
    }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | ({ kind: "tool"; id: string; toolKind: string } & Omit<ToolCallFields, "kind">)
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error"; link?: { key: string; label: string } }
  /** The agent condensed earlier history to stay within its context window. */
  | {
      kind: "compaction";
      id: string;
      compactionId: string;
      status: "in_progress" | "completed" | "failed" | "cancelled" | string;
      summary: string;
      error?: string | null;
    };

/** A slash command the agent accepts (ACP `available_commands_update`). */
export interface AgentCommand {
  name: string;
  description: string;
  /** Shown when the command takes free text after its name. */
  hint?: string;
}

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

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
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
  /** A finished task whose worktree was cleaned up: history only, no reconnecting. */
  archived?: boolean;
  /** Slash commands the agent advertised for this session. */
  commands?: AgentCommand[];
  /** Set on a lead (agent mode) conversation. */
  lead?: { teamId: string };
  /** Tasks this lead handed out, newest last. */
  tasks?: TaskInfo[];
  /** Set on a task's conversation: the lead it belongs to. */
  parent?: { key: string; taskId: string };
  /** Set when this lead hit its usage limit; cleared when a later prompt succeeds. */
  limited?: { resetsAt?: number; dismissed?: boolean };
  /** Key of the replacement lead chat this conversation was handed off to. */
  handedTo?: string;
  /** Key of the previous lead chat this conversation took over from. */
  handedFrom?: string;
  /** Context-window usage reported by the agent (`usage_update`). */
  usage: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  /** Numbers from the last finished turn. */
  lastTurn: TurnStats | null;
  /** Messages queued while this session is busy (mirrors backend inbox). */
  queued?: QueuedMessage[];
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

/** Cumulative token usage across every turn a delegated task ran. */
export interface TaskUsage {
  /** Input not served from the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens?: number;
}

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
  /** Files already merged by partial merges; `changes` then lists only what is left. */
  merged?: string[];
  /** Member switches after a limit error, e.g. "a → b (usage limit)". */
  reassigned: string[];
  /** True when the task ended or was moved because of a usage limit. */
  limitHit: boolean;
  /** Cumulative token usage across all turns the task ran; absent when unreported. */
  usage?: TaskUsage | null;
  /** The lead's user message (turn) this task was created in. */
  turnId?: string;
}

/** A worktree task's unmerged files (`task_changes`). */
export interface TaskChanges {
  /** Snapshot commit; its diff against its parent shows the task's changes. */
  result: string;
  files: { status: string; path: string }[];
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
  /** Member id that takes a task when this one hits its plan limit; unset picks one automatically. */
  fallback?: string | null;
}

export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  maxParallel: number;
  /** How file-writing tasks share a git workspace. */
  isolation: "worktree" | "shared";
  /** Shipped with the app (auto + one per service): copy it to change it. */
  builtin?: boolean;
}

export const AUTO_TEAM = "auto";

/** Teams worth offering: the user's own, and built-in ones with a member that can run here. */
export const usableTeams = (teams: Team[], agents: AgentInfo[]) =>
  teams.filter((t) => !t.builtin || t.members.some((m) => agents.some((a) => a.id === m.agentId && a.installed)));

/** A leftover patch from a cleaned-up worktree (`.baton/unmerged`). */
export interface UnmergedPatch {
  file: string;
  /** ms since the epoch. */
  modified: number;
  size: number;
  /** Paths the patch changes. */
  files: string[];
}

export interface ApplyOutcome {
  applied: boolean;
  /** Files left with conflict markers. */
  conflicts: string[];
  message: string;
}
