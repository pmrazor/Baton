# Baton — project guide for coding agents

## What Baton is
Tauri 2 + Rust + React/TypeScript desktop app (macOS/Windows/Linux) that runs several coding agents
(Claude Code, Codex, Antigravity, DeepSeek `dsh`) as ACP (Agent Client Protocol) child processes and gives
them one workspace UI: chat, file tree + CodeMirror editor, git panel, search, terminals.
"Agent mode": a lead agent delegates tasks to team members through Baton's own MCP server; each
file-writing task runs in its own git worktree and is merged back by Baton.

## Layout
Backend `src-tauri/src/` (crate `baton_lib`; `main.rs` only calls into `lib.rs`):
- `lib.rs` — app setup, Tauri state, ALL `#[tauri::command]` wrappers for hub/orchestra/teams/profiles, and the
  `generate_handler![…]` list (every new command must be registered there; module commands like `files::fs_read` too).
- `hub.rs` — owns agent processes ("runtimes") and ACP sessions; turns agent traffic into events; usage/limits plumbing.
- `acp.rs` — ACP JSON-RPC 2.0 transport over a child's stdin/stdout (requests, responses, agent-initiated calls).
- `mcp.rs` — shared MCP servers (`mcp.json`) merged into every ACP session's `mcpServers`; connection check over stdio/http;
  TOML parse for import.
- `orchestra.rs` (largest) — agent mode: axum MCP server on 127.0.0.1 with per-lead bearer tokens; tools
  `list_agents, delegate, wait, get_result, send_followup, merge_task, discard_task, cancel`; task state machine,
  `run_turn` (one task turn), per-workspace write lock, inbox, limits, permission auto-handling for Baton tools.
- `worktree.rs` — per-task git worktrees from a snapshot incl. uncommitted files; linked dirs (`node_modules`,
  `target`, `.venv`, `venv`); three-way per-file merge back; `native_path` for git's `C:/…` output.
- `agents.rs` — agent definitions (`agents.json` in config dir, defaults for claude/codex/antigravity/dsh), install/launch.
- `teams.rs` — team rosters the lead may delegate to (agent + profile + settings + role line; "auto" built in).
- `profiles.rs` — named accounts per agent (own home dir via `profileEnv`); `login.rs` — terminal-based ACP auth.
- `usage.rs` — plan limits read outside ACP (same `groups/buckets` shape for UI and `list_agents`).
- `history.rs` — chat transcripts as JSON in `<workspace>/.baton/sessions/`; `legacy.rs` — migration from "Agent Hub".
- `guide.rs` — project-guide presence + staleness signals from git; per-workspace mode in `.baton/settings.json`; note
  injected into a lead's first prompt.
- `attachments.rs` — attached files → ACP prompt content (image / embedded resource / resource_link).
- `extensions.rs` — downloadable data-only extensions: registry fetch over https/local path, sha256-checked install into
  app data, `state.json`.
- `files.rs` — sandboxed workspace fs (list/read/atomic write/stat/rename/trash); defines `FsError`; rejects `..`/escaping symlinks.
- `git.rs` — Source-control commands (status, stage, commit, branches, push/pull, log); `gitdiff.rs` — original/modified
  texts for diff tabs; `gitblame.rs` — blame hunks for the editor gutter; `search.rs` — text search (`ignore` + `regex`) and `list_files`.
- `terminal.rs` — PTY terminals (`terminal-output` / `terminal-exit` events); `shell_env.rs` — login-shell PATH for GUI launches.

Frontend `src/`:
- `App.tsx` — shell, wires `subscribe()` events into the reducer, simple/pro layouts. `main.tsx` — entry.
- `store.ts` — the reducer (`reducer`, `initialState`, `Action`): sessions, messages, tasks, permissions, queues.
- `api.ts` — ALL `invoke` wrappers (one function per command) and event subscriptions (`subscribe`, `subscribeTerminals`).
- `types.ts` — shapes shared with Rust (keep in sync with serde structs, which use camelCase).
- `extensions/` — downloadable data-only extensions: `api.ts` (contract), `registry.ts` (contribution kinds),
  `languages.ts` (legacy/simple-mode grammars), `themes.ts` ("themes" kind: theme index, `isSafeColor`/`themeCssText`, applies the active theme as one `<style id="baton-theme">` + `baton.themeCache`, `onThemeChanged`), `catalog.ts` (registry cache/filtering).
- `mcp/` — shared MCP servers UI: `api.ts` (invoke wrappers), `helpers.ts` (validation, JSON/TOML import, checks).
- `commands/` — command center helpers: `registry.ts` (command registry + recent ordering), `fuzzy.ts` (fuzzy scoring/ranking), `conversationSearch.ts` (past conversation content search).
- Small modules: `composerBus.ts` (attach/insert into composer), `notify.ts` (desktop notifications, coalescing queue),
  `concurrency.ts` (other conversations working in the same folder), `handoff.ts` (lead handoff memo), `usage.ts` (quota extraction per agent
  family), `codeNav.ts`, `chatNav.ts`, `platform.ts`, `update.ts`; `styles.css` (tokens) and `scrollbars.css`.
- `components/` — `ChatView`, `Composer`, `Messages`, `Turn`, `TaskCard`, `Sidebar`, `SettingsModal`, `TeamsPanel`,
  `UsagePanel`, `ExtensionsPanel`, `AppearancePanel` (Settings → 화면 theme pickers), `McpPanel`, `NotificationsPanel`, `GuideBanner`, `TerminalView`, `ProLayout`
  (+`proLayoutState.ts`), `PermissionCard`, `ContextMenu`, `Popover`, banners…
  - `CommandCenter.tsx` — title-bar quick open (files + conversations), command palette (`>`), and go-to-line (`:`).
- `components/code/` — CodeMirror 6 editor: `CodeEditor.tsx`, `FileTree.tsx`, `editorStore.ts` (open tabs per root),
  `cmEngine.ts`/`cmDiffEngine.ts` (lazy-loaded), `codeHelpers.ts` (pure), `ExtensionHintBar.tsx`, `gitGutter.ts`, `blameGutter.ts`.
- `components/git/` — `GitPanel.tsx`, `gitHelpers.ts`, `gitGraph.ts` (commit graph lanes).
- `components/search/` — `SearchPanel.tsx`, `searchStore.ts`, `searchHelpers.ts`.
- `extensions/` — registry content: `index.json` + `<id>/extension.json` per extension (see `extensions/README.md`);
  `lang-*` grammar and `theme-*` color-theme extensions. `scripts/build-extension-index.mjs` regenerates the index with sha256.

## How a request flows
1. UI action → `api.ts` wrapper → `invoke("cmd", args)` → command in `lib.rs` (or `files::`/`git::`/… module) → hub/module logic.
2. Async results come back as Tauri events (`app.emit`): `acp-update`, `acp-permission`, `agent-status`, `agent-log`,
   `agent-auth`, `account-usage`, `task-update`, `task-session`, `task-brief`, `inbox-delivered`, `terminal-output`,
   `terminal-exit` → `listen` in `api.ts` (`subscribe`) → handlers in `App.tsx` → `store.ts` reducer.
3. Agent mode: lead calls an MCP tool (`delegate` …) → `orchestra.rs` tool handler → task created as a hub session →
   `run_turn` (acquires workspace write lock if the task writes, creates a worktree) → events stream to the UI →
   `wait`/`get_result` return the answer → `merge_task` (or `discard_task`) merges worktree changes into the workspace.
New command checklist: Rust fn + register in `generate_handler!` → wrapper in `api.ts` → types in `types.ts` → tests.

## Commands
- Dev: `npm run tauri dev` (runs vite via `beforeDevCommand`). Frontend only: `npm run dev`.
- Before reporting, run what applies to your change:
  - `npx tsc --noEmit -p .`
  - `npx vitest run`
  - `npm run build`
  - `cd src-tauri && cargo test --locked && cargo clippy --locked` (one pre-existing `single_match` clippy warning is expected)
- `npm run extensions:index` after editing `extensions/` (regenerates `extensions/index.json` with sha256).
- `npm run licenses` after dependency changes (regenerates `src/assets/licenses.json`). CI runs typecheck, tests, build, `cargo test --locked`.

## Conventions
- UI strings are Korean polite 해요체 (e.g. "찾을 수 없어요."). Code, comments, identifiers are English.
- Colors only via CSS custom properties from `src/styles.css` (`--bg`, `--surface`, `--text`, `--accent`, …); the file defines
  light values in `:root` and dark ones under `@media (prefers-color-scheme: dark)`. No hard-coded colors in components.
- Tests live next to sources: `*.test.ts` (vitest) and Rust `#[cfg(test)] mod tests` in the same file.
  Extract pure helpers (no Tauri/CodeMirror imports, e.g. `codeHelpers.ts`, `gitHelpers.ts`, `taskLabels.ts`) so they are unit-testable.
- Tauri commands return user-facing Korean errors; fs/git/search use `FsError` (`files.rs`) with kinds like `invalid_path`, `io`, `not_found`.
- Paths: workspace-relative `/`-separated paths validated against the root (no `..`, no escaping symlinks); handle Windows
  (`native_path`, case-insensitive compare in `concurrency.ts`) and preserve CRLF when reading/writing files.
- Blocking work (git, fs, pty) runs off the async runtime (`spawn_blocking` / plain threads); git is run with prompts disabled and timeouts.
- Heavy editor code is lazy-loaded (`cmEngine.ts`, `cmDiffEngine.ts`) to keep the main bundle small.
- Dependencies: pin new npm/Cargo deps to exact versions (no `^`) at least 2 weeks old; update `package-lock.json`/`Cargo.lock`.
- Per-workspace data lives in `<workspace>/.baton/` (sessions, unmerged work); it git-ignores itself.

## Working as a delegated task
- You are in a git worktree copy of the repo, not the user's checkout. Stay inside it; don't `cd` elsewhere.
- Read only the files your task names plus what they import. Use ripgrep-style search (`rg`, `grep -rn`) rather than listing directories or reading whole large files (`orchestra.rs`, `CodeEditor.tsx`, `GitPanel.tsx`, `FileTree.tsx` are 1000+ lines — read ranges).
- Don't run `npm install`/`npm ci`: `node_modules` (and `target`) are linked from the workspace. Don't edit lockfiles unless the task is a dependency change.
- Make the smallest change that solves the task; don't reformat or refactor unrelated code.
- Run the relevant checks above; if one fails for a pre-existing reason, say so.
- Finish with a short report: what you did, files changed, anything undone or uncertain. Don't commit unless asked.
