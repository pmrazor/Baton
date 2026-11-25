// Module-level store for open code editor tabs per workspace root.
// Both FileTree and CodeEditor subscribe via `useSyncExternalStore`.

import { useSyncExternalStore } from "react";
import {
  commitDiffTabId,
  diffTabId,
  findContainingRoot,
  nextActiveAfterBulkClose,
  nextActiveAfterClose,
  normalizeRelativePath,
  normalizeTabId,
  pathMatchesPrefix,
  rewritePathPrefix,
} from "./codeHelpers";

export type EditorTabKind = "file" | "diff";

export interface OpenDiffOptions {
  staged: boolean;
}

export interface EditorTab {
  /** Unique tab id: normalized relative `path` for normal tabs, or `diff:staged:<path>` / `diff:worktree:<path>` for diff tabs. */
  id: string;
  /** Relative path within root, `/`-separated. */
  path: string;
  kind: EditorTabKind;
  /** Only set for diff tabs (`true` for HEAD vs index or commit diff, `false` for index/HEAD vs working tree). */
  staged?: boolean;
  /** Only set for commit diff tabs: the commit hash being compared against its first parent. */
  commitHash?: string;
  /** Optional previous path for renamed files in a commit diff. */
  origPath?: string;
  dirty: boolean;
  deleted: boolean;
  diskChanged: boolean;
  /** Last loaded or saved mtime (microseconds), or null before load completes. */
  mtime: number | null;
}

export interface JumpTarget {
  path: string;
  /** 1-based line number. */
  line: number;
  seq: number;
}

export interface RevealTarget {
  path: string;
  seq: number;
}

export interface RootEditorView {
  tabs: EditorTab[];
  active: string | null;
  jump: JumpTarget | null;
  reveal: RevealTarget | null;
}

interface RootRecord {
  tabs: EditorTab[];
  active: string | null;
  jump: JumpTarget | null;
  reveal: RevealTarget | null;
  view: RootEditorView;
}

const EMPTY_VIEW: RootEditorView = Object.freeze({ tabs: [], active: null, jump: null, reveal: null });

const roots = new Map<string, RootRecord>();
const knownRoots = new Set<string>();
const subscribers = new Set<() => void>();
const closeListeners = new Set<(root: string, id: string) => void>();
const renameListeners = new Set<(root: string, fromId: string, toId: string) => void>();
const revealListeners = new Set<(root: string, path: string) => void>();
let jumpSeq = 0;
let revealSeq = 0;

function emit() {
  subscribers.forEach((fn) => fn());
}

function getOrCreateRoot(root: string): RootRecord {
  knownRoots.add(root);
  let rec = roots.get(root);
  if (!rec) {
    rec = { tabs: [], active: null, jump: null, reveal: null, view: EMPTY_VIEW };
    roots.set(root, rec);
  }
  return rec;
}

function publish(rec: RootRecord) {
  rec.view = {
    tabs: rec.tabs.map((t) => ({ ...t })),
    active: rec.active,
    jump: rec.jump ? { ...rec.jump } : null,
    reveal: rec.reveal ? { ...rec.reveal } : null,
  };
  emit();
}

export function subscribeEditor(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Register a callback invoked whenever a tab is closed (used to drop CodeMirror state). */
export function onTabClosed(fn: (root: string, id: string) => void): () => void {
  closeListeners.add(fn);
  return () => {
    closeListeners.delete(fn);
  };
}

/** Register a callback invoked whenever an open tab's id/path is rewritten after rename/move. */
export function onTabRenamed(fn: (root: string, fromId: string, toId: string) => void): () => void {
  renameListeners.add(fn);
  return () => {
    renameListeners.delete(fn);
  };
}

/** Register a callback invoked whenever an editor tab asks to reveal a file in the FileTree. */
export function onRevealInTree(fn: (root: string, path: string) => void): () => void {
  revealListeners.add(fn);
  return () => {
    revealListeners.delete(fn);
  };
}

/** Record a workspace root so `openAbsolutePath` can match files inside it. */
export function registerRoot(root: string): void {
  if (root) knownRoots.add(root);
}

/** Snapshot for `useSyncExternalStore` (referentially stable until mutated). */
export function getRootEditorView(root: string): RootEditorView {
  return roots.get(root)?.view ?? EMPTY_VIEW;
}

/** React hook returning the open tabs and active tab for `root`. */
export function useEditorRoot(root: string): RootEditorView {
  return useSyncExternalStore(
    subscribeEditor,
    () => getRootEditorView(root),
    () => EMPTY_VIEW,
  );
}

/** Open or focus `path` (relative to `root`), optionally jumping to a 1-based `line`. */
export function openFile(root: string, path: string, line?: number): void {
  const rel = normalizeRelativePath(path);
  if (!root || !rel) return;
  const rec = getOrCreateRoot(root);
  const existing = rec.tabs.find((t) => t.id === rel);
  const hasLine = typeof line === "number" && Number.isFinite(line) && line >= 1;
  if (existing && rec.active === rel && !hasLine) return;
  if (!existing) {
    rec.tabs.push({
      id: rel,
      path: rel,
      kind: "file",
      dirty: false,
      deleted: false,
      diskChanged: false,
      mtime: null,
    });
  }
  rec.active = rel;
  if (hasLine) {
    rec.jump = { path: rel, line: Math.floor(line), seq: ++jumpSeq };
  }
  publish(rec);
}

/** Open or focus a diff tab for `path` (relative to `root`), separate from normal file tabs. */
export function openDiff(root: string, path: string, opts: OpenDiffOptions): void {
  const rel = normalizeRelativePath(path);
  if (!root || !rel) return;
  const staged = !!opts.staged;
  const id = diffTabId(rel, staged);
  const rec = getOrCreateRoot(root);
  const existing = rec.tabs.find((t) => t.id === id);
  if (existing && rec.active === id) return;
  if (!existing) {
    rec.tabs.push({
      id,
      path: rel,
      kind: "diff",
      staged,
      dirty: false,
      deleted: false,
      diskChanged: false,
      mtime: null,
    });
  }
  rec.active = id;
  publish(rec);
}

/** Open or focus a read-only commit diff tab for `(hash, path)`. */
export function openCommitDiff(root: string, hash: string, path: string, origPath?: string): void {
  const rel = normalizeRelativePath(path);
  const cleanHash = hash.trim();
  if (!root || !rel || !cleanHash) return;
  const id = commitDiffTabId(cleanHash, rel);
  const rec = getOrCreateRoot(root);
  const existing = rec.tabs.find((t) => t.id === id);
  if (existing && rec.active === id) return;
  if (!existing) {
    const cleanOrig = origPath ? normalizeRelativePath(origPath) : undefined;
    rec.tabs.push({
      id,
      path: rel,
      kind: "diff",
      staged: true,
      commitHash: cleanHash,
      ...(cleanOrig ? { origPath: cleanOrig } : {}),
      dirty: false,
      deleted: false,
      diskChanged: false,
      mtime: null,
    });
  }
  rec.active = id;
  publish(rec);
}

/** Find the known workspace root containing `absPath` and open it there. */
export function openAbsolutePath(absPath: string, line?: number): boolean {
  const match = findContainingRoot(knownRoots, absPath);
  if (!match) return false;
  openFile(match.root, match.path, line);
  return true;
}

/** Focus an already-open tab for `root`. */
export function activateTab(root: string, tabId: string): void {
  const id = normalizeTabId(tabId);
  const rec = roots.get(root);
  if (!rec || rec.active === id) return;
  if (!rec.tabs.some((t) => t.id === id)) return;
  rec.active = id;
  publish(rec);
}

/** Close a tab for `root` and choose the next active tab. */
export function closeTab(root: string, tabId: string): void {
  const id = normalizeTabId(tabId);
  const rec = roots.get(root);
  if (!rec) return;
  if (!rec.tabs.some((t) => t.id === id)) return;
  rec.active = nextActiveAfterClose(
    rec.tabs.map((t) => t.id),
    rec.active,
    id,
  );
  rec.tabs = rec.tabs.filter((t) => t.id !== id);
  if (rec.jump?.path === id) rec.jump = null;
  closeListeners.forEach((fn) => fn(root, id));
  publish(rec);
}

/** Close multiple tabs for `root` at once and pick the next active tab atomically. */
export function closeTabs(root: string, tabIds: readonly string[]): void {
  const rec = roots.get(root);
  if (!rec || tabIds.length === 0) return;
  const requested = new Set(tabIds.map(normalizeTabId));
  const closing = rec.tabs.filter((t) => requested.has(t.id)).map((t) => t.id);
  if (closing.length === 0) return;
  const closingSet = new Set(closing);
  rec.active = nextActiveAfterBulkClose(
    rec.tabs.map((t) => t.id),
    rec.active,
    closing,
  );
  rec.tabs = rec.tabs.filter((t) => !closingSet.has(t.id));
  if (rec.jump && closingSet.has(rec.jump.path)) rec.jump = null;
  for (const id of closing) {
    closeListeners.forEach((fn) => fn(root, id));
  }
  publish(rec);
}

/** Update metadata flags on an open tab. */
export function setTabState(
  root: string,
  tabId: string,
  patch: Partial<Pick<EditorTab, "dirty" | "deleted" | "diskChanged" | "mtime">>,
): void {
  const id = normalizeTabId(tabId);
  const rec = roots.get(root);
  if (!rec) return;
  const tab = rec.tabs.find((t) => t.id === id);
  if (!tab) return;
  let changed = false;
  if (patch.dirty !== undefined && tab.dirty !== patch.dirty) {
    tab.dirty = patch.dirty;
    changed = true;
  }
  if (patch.deleted !== undefined && tab.deleted !== patch.deleted) {
    tab.deleted = patch.deleted;
    changed = true;
  }
  if (patch.diskChanged !== undefined && tab.diskChanged !== patch.diskChanged) {
    tab.diskChanged = patch.diskChanged;
    changed = true;
  }
  if (patch.mtime !== undefined && tab.mtime !== patch.mtime) {
    tab.mtime = patch.mtime;
    changed = true;
  }
  if (changed) publish(rec);
}

/** Update open tabs (normal and diff) when a file or folder is renamed or moved. */
export function renamePath(root: string, from: string, to: string): void {
  const fromRel = normalizeRelativePath(from);
  const toRel = normalizeRelativePath(to);
  if (!root || !fromRel || !toRel || fromRel === toRel) return;
  const rec = roots.get(root);
  if (!rec) return;

  const renames: { oldId: string; newId: string; newPath: string }[] = [];
  for (const tab of rec.tabs) {
    if (tab.commitHash) continue;
    if (!pathMatchesPrefix(tab.path, fromRel)) continue;
    const nextPath = rewritePathPrefix(tab.path, fromRel, toRel);
    const nextId = tab.kind === "diff" ? diffTabId(nextPath, !!tab.staged) : nextPath;
    if (nextId !== tab.id || nextPath !== tab.path) {
      renames.push({ oldId: tab.id, newId: nextId, newPath: nextPath });
    }
  }
  if (renames.length === 0) return;

  const renamedOldIds = new Set(renames.map((r) => r.oldId));
  const renamedNewIds = new Set(renames.map((r) => r.newId));
  // Drop any stale tab already occupying a renamed target id.
  const staleRemoved: string[] = [];
  rec.tabs = rec.tabs.filter((tab) => {
    if (!renamedOldIds.has(tab.id) && renamedNewIds.has(tab.id)) {
      staleRemoved.push(tab.id);
      return false;
    }
    return true;
  });

  const renameMap = new Map(renames.map((r) => [r.oldId, r]));
  for (const tab of rec.tabs) {
    const next = renameMap.get(tab.id);
    if (next) {
      tab.id = next.newId;
      tab.path = next.newPath;
    }
  }
  if (rec.active) {
    const activeRename = renameMap.get(rec.active);
    if (activeRename) {
      rec.active = activeRename.newId;
    }
  }
  if (rec.jump && pathMatchesPrefix(rec.jump.path, fromRel)) {
    rec.jump = { ...rec.jump, path: rewritePathPrefix(rec.jump.path, fromRel, toRel) };
  }
  if (rec.reveal && pathMatchesPrefix(rec.reveal.path, fromRel)) {
    rec.reveal = { ...rec.reveal, path: rewritePathPrefix(rec.reveal.path, fromRel, toRel) };
  }

  for (const stale of staleRemoved) {
    closeListeners.forEach((fn) => fn(root, stale));
  }
  for (const { oldId, newId } of renames) {
    renameListeners.forEach((fn) => fn(root, oldId, newId));
  }
  publish(rec);
}

/** Sync open tabs (normal and diff) when a file or folder is trashed: close clean tabs, mark dirty tabs deleted. */
export function handleDeletedPath(root: string, path: string): void {
  const rel = normalizeRelativePath(path);
  if (!root || !rel) return;
  const rec = roots.get(root);
  if (!rec) return;

  const toClose: string[] = [];
  let changed = false;

  for (const tab of rec.tabs) {
    if (tab.commitHash) continue;
    if (!pathMatchesPrefix(tab.path, rel)) continue;
    if (tab.dirty) {
      if (!tab.deleted || tab.diskChanged) {
        tab.deleted = true;
        tab.diskChanged = false;
        changed = true;
      }
    } else {
      toClose.push(tab.id);
    }
  }

  for (const closing of toClose) {
    rec.active = nextActiveAfterClose(
      rec.tabs.map((t) => t.id),
      rec.active,
      closing,
    );
    rec.tabs = rec.tabs.filter((t) => t.id !== closing);
    if (rec.jump?.path === closing) rec.jump = null;
    closeListeners.forEach((fn) => fn(root, closing));
    changed = true;
  }

  if (changed) publish(rec);
}

/** Mark a pending line jump as handled once the editor scrolled to it. */
export function clearJump(root: string, seq: number): void {
  const rec = roots.get(root);
  if (!rec || !rec.jump || rec.jump.seq !== seq) return;
  rec.jump = null;
  publish(rec);
}

/** Request the FileTree (and sidebar) to expand folders and select `path` under `root`. */
export function revealInTree(root: string, path: string): void {
  const rel = normalizeRelativePath(path);
  if (!root || !rel) return;
  const rec = getOrCreateRoot(root);
  rec.reveal = { path: rel, seq: ++revealSeq };
  publish(rec);
  revealListeners.forEach((fn) => fn(root, rel));
}

/** Mark a pending tree reveal request as handled. */
export function clearReveal(root: string, seq: number): void {
  const rec = roots.get(root);
  if (!rec || !rec.reveal || rec.reveal.seq !== seq) return;
  rec.reveal = null;
  publish(rec);
}

/** Clear all module state (intended for unit tests). */
export function resetEditorStore(): void {
  roots.clear();
  knownRoots.clear();
  subscribers.clear();
  closeListeners.clear();
  renameListeners.clear();
  revealListeners.clear();
  jumpSeq = 0;
  revealSeq = 0;
}
