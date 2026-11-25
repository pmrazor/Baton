import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentInfo,
  ApplyOutcome,
  AgentStatus,
  AuthStatus,
  ConfigOption,
  HubError,
  Launch,
  PermissionRequest,
  Profile,
  SessionModes,
  TaskChanges,
  TaskInfo,
  Team,
  UnmergedPatch,
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

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface FileContent {
  text: string;
  mtime: number;
}

export interface GitDiffTexts {
  original: string | null;
  modified: string | null;
  binary: boolean;
}

export type FsErrorKind =
  | "invalid_path"
  | "not_found"
  | "already_exists"
  | "too_large"
  | "binary"
  | "conflict"
  | "invalid_query"
  | "io";

export interface FsError {
  kind: FsErrorKind;
  message: string;
}

export function toFsError(e: unknown): FsError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const err = e as { kind: unknown; message: unknown };
    return { kind: String(err.kind) as FsErrorKind, message: String(err.message) };
  }
  return { kind: "io", message: String(e) };
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs such as `src/**, *.ts`; empty searches every file. */
  include: string;
  /** Comma-separated globs of files and folders to leave out. */
  exclude: string;
  /** Match cap; the backend defaults to 2000. */
  maxResults?: number;
}

export interface SearchLineMatch {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first match, in UTF-16 code units. */
  column: number;
  /** The line, trimmed around the match when long. */
  preview: string;
  /** `[start, end)` ranges inside `preview`, in UTF-16 code units. */
  ranges: [number, number][];
}

export interface SearchFileMatches {
  /** Relative to the searched root, `/`-separated. */
  path: string;
  matches: SearchLineMatch[];
}

export interface SearchResult {
  files: SearchFileMatches[];
  /** More matches exist than were returned. */
  truncated: boolean;
  searchedFiles: number;
}

/** One changed file in `git status`. Paths are relative to the repository root, `/`-separated. */
export interface GitFileStatus {
  path: string;
  /** The old path of a staged rename. */
  origPath?: string;
  /** Staged state: M, A, D, R, C, T, U, or "" when unchanged. */
  index: string;
  /** Working tree state: M, D, T, A, U, ?, or "" when unchanged. */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  repo: boolean;
  /** The repository's top folder; empty when `repo` is false. */
  repoRoot: string;
  /** The requested folder relative to `repoRoot` (`sub/` or ""). */
  prefix: string;
  /** The current branch, or the short commit when detached. */
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  /** Full HEAD commit hash, or "" when the repository has no commits yet. */
  head: string;
  files: GitFileStatus[];
}

export interface GitBranch {
  /** `main` locally, `origin/main` for a remote branch. */
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Author time in Unix seconds. */
  time: number;
  subject: string;
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  /** Single-letter git status: A, M, D, R, C, T… */
  status: string;
  origPath?: string;
}

export const api = {
  listAgents: () => invoke<AgentInfo[]>("list_agents"),
  agentsConfigPath: () => invoke<string>("agents_config_path"),
  /** Re-read PATH (after installing an agent) and list agents again. */
  refreshAgents: () => invoke<AgentInfo[]>("refresh_agents"),
  installAgent: (agentId: string) => invoke<void>("install_agent", { agentId }),
  newSession: (agentId: string, cwd: string, launch: Launch) =>
    invoke<NewSessionResult>("new_session", { agentId, cwd, launch }),
  newLeadSession: (agentId: string, cwd: string, launch: Launch, teamId: string) =>
    invoke<NewSessionResult>("new_lead_session", { agentId, cwd, launch, teamId }),
  resumeLeadSession: (agentId: string, sessionId: string, cwd: string, launch: Launch, teamId: string) =>
    invoke<Omit<NewSessionResult, "sessionId">>("resume_lead_session", { agentId, sessionId, cwd, launch, teamId }),
  taskNote: (taskId: string, text: string) => invoke<void>("task_note", { taskId, text }),
  listUnmerged: (workspace: string) => invoke<UnmergedPatch[]>("list_unmerged", { workspace }),
  applyUnmerged: (workspace: string, file: string) =>
    invoke<ApplyOutcome>("apply_unmerged", { workspace, file }),
  deleteUnmerged: (workspace: string, file: string) => invoke<void>("delete_unmerged", { workspace, file }),
  listAgentSessions: (cwd: string) => invoke<AgentSessionInfo[]>("list_agent_sessions", { cwd }),
  importSession: (agentId: string, sessionId: string, cwd: string, launch: Launch, teamId: string | null) =>
    invoke<ImportResult>("import_session", { agentId, sessionId, cwd, launch, teamId }),
  switchMode: (agentId: string, sessionId: string, cwd: string, teamId: string | null) =>
    invoke<Omit<NewSessionResult, "sessionId">>("switch_mode", { agentId, sessionId, cwd, teamId }),
  missingPaths: (paths: string[]) => invoke<string[]>("missing_paths", { paths }),
  /** Merge everything left, or only `files` (the worktree then keeps the rest). */
  mergeTask: (taskId: string, files?: string[]) =>
    invoke<{ merged_files: string[]; conflicts: string[]; remaining_files?: string[]; worktree_kept?: boolean }>(
      "merge_task",
      { taskId, files },
    ),
  taskChanges: (taskId: string) => invoke<TaskChanges>("task_changes", { taskId }),
  discardTask: (taskId: string) => invoke<void>("discard_task", { taskId }),
  setLeadTeam: (agentId: string, sessionId: string, teamId: string) =>
    invoke<void>("set_lead_team", { agentId, sessionId, teamId }),
  handoffLead: (fromAgentId: string, fromSessionId: string, toAgentId: string, toSessionId: string) =>
    invoke<void>("handoff_lead", { fromAgentId, fromSessionId, toAgentId, toSessionId }),
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
  /** `attachments`: file paths sent after the text. */
  sendPrompt: (agentId: string, sessionId: string, text: string, attachments: string[] = []) =>
    invoke<{
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
    }>("send_prompt", { agentId, sessionId, text, attachments }),
  /** Let the webview load these media files for thumbnails; returns the allowed ones. */
  allowPreviews: (paths: string[]) => invoke<string[]>("allow_previews", { paths }),
  openAttachment: (path: string) => invoke<void>("open_attachment", { path }),
  /** Store a pasted image (base64) in the workspace's .baton/attachments; returns its path. */
  saveAttachment: (workspace: string, name: string, data: string) =>
    invoke<string>("save_attachment", { workspace, name, data }),
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
  /** Start a shell in `cwd`; false when `id` was already running (reattached). */
  terminalOpen: (id: string, cwd: string, cols: number, rows: number) =>
    invoke<boolean>("terminal_open", { id, cwd, cols, rows }),
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** The running shells, to find them again after a webview reload. */
  terminalList: () => invoke<{ id: string; cwd: string }[]>("terminal_list"),
  fsList: (root: string, dir: string) => invoke<FsEntry[]>("fs_list", { root, dir }),
  fsRead: (root: string, path: string) => invoke<FileContent>("fs_read", { root, path }),
  fsWrite: (root: string, path: string, text: string, expectedMtime: number | null) =>
    invoke<number>("fs_write", { root, path, text, expectedMtime }),
  fsStat: (root: string, paths: string[]) => invoke<(number | null)[]>("fs_stat", { root, paths }),
  fsCreateFile: (root: string, path: string) => invoke<void>("fs_create_file", { root, path }),
  fsCreateDir: (root: string, path: string) => invoke<void>("fs_create_dir", { root, path }),
  fsRename: (root: string, from: string, to: string) => invoke<void>("fs_rename", { root, from, to }),
  fsCopy: (root: string, from: string, toDir: string) => invoke<string>("fs_copy", { root, from, toDir }),
  fsTrash: (root: string, path: string) => invoke<void>("fs_trash", { root, path }),
  searchText: (root: string, query: string, opts: SearchOptions) =>
    invoke<SearchResult>("search_text", { root, query, opts }),
  /** Git commands take any folder inside the repository; `paths` are repository-relative. */
  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  /** Tracked files return to their staged content; untracked files go to the trash. */
  gitDiscard: (root: string, paths: string[]) => invoke<void>("git_discard", { root, paths }),
  /** Returns the new commit's short hash. */
  gitCommit: (root: string, message: string, amend: boolean) =>
    invoke<string>("git_commit", { root, message, amend }),
  gitBranches: (root: string) => invoke<GitBranch[]>("git_branches", { root }),
  gitCheckout: (root: string, branch: string, create: boolean) =>
    invoke<void>("git_checkout", { root, branch, create }),
  gitFetch: (root: string) => invoke<void>("git_fetch", { root }),
  gitPull: (root: string) => invoke<void>("git_pull", { root }),
  gitPush: (root: string) => invoke<void>("git_push", { root }),
  gitInit: (root: string) => invoke<void>("git_init", { root }),
  gitLog: (root: string, skip = 0, limit = 200) => invoke<GitCommit[]>("git_log", { root, skip, limit }),
  gitCommitFiles: (root: string, hash: string) => invoke<GitCommitFile[]>("git_commit_files", { root, hash }),
  gitDiffCommitTexts: (root: string, hash: string, path: string, origPath?: string) =>
    invoke<GitDiffTexts>("git_diff_commit_texts", { root, hash, path, origPath }),
  gitBranchAt: (root: string, name: string, hash: string) =>
    invoke<void>("git_branch_at", { root, name, hash }),
  gitRefsStamp: (root: string) => invoke<string>("git_refs_stamp", { root }),
  gitDiffTexts: (root: string, path: string, staged: boolean) =>
    invoke<GitDiffTexts>("git_diff_texts", { root, path, staged }),
};

/** Terminal output (UTF-8 text) and shell exits, for every terminal. `gone`:
 *  the shell was ended because its folder was removed. */
export async function subscribeTerminals(
  onOutput: (id: string, data: string) => void,
  onExit: (id: string, code: number, gone: boolean) => void,
): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<{ id: string; data: string }>("terminal-output", (e) => onOutput(e.payload.id, e.payload.data)),
    listen<{ id: string; code: number; gone?: boolean }>("terminal-exit", (e) =>
      onExit(e.payload.id, e.payload.code, !!e.payload.gone),
    ),
  ]);
  return () => offs.forEach((off) => off());
}

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
  /** `attachments`: file paths the lead sent with the follow-up. */
  onTaskBrief: (task: TaskInfo, text: string, attachments: string[]) => void;
  /** An account's plan limits, read with the agent's usage command (Antigravity). */
  onAccountUsage: (agentId: string, profileId: string, usage: unknown) => void;
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
  /** File paths the lead attached to the task. */
  attachments?: string[];
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
    listen<{ task: TaskInfo; text: string; attachments?: string[] }>("task-brief", (e) =>
      h.onTaskBrief(e.payload.task, e.payload.text, e.payload.attachments ?? []),
    ),
    listen<{ agentId: string; profileId: string; usage: unknown }>("account-usage", (e) =>
      h.onAccountUsage(e.payload.agentId, e.payload.profileId, e.payload.usage),
    ),
  ]);
  return () => offs.forEach((off) => off());
}
