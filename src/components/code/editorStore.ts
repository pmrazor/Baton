// Module-level store for open code editor tabs per workspace root.
// Both FileTree and CodeEditor subscribe via `useSyncExternalStore`.

import { useSyncExternalStore } from "react";
import {
  findContainingRoot,
  nextActiveAfterClose,
  normalizeRelativePath,
  pathMatchesPrefix,
  rewritePathPrefix,
} from "./codeHelpers";

export interface EditorTab {
  /** Relative path within root, `/`-separated. */
  path: string;
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

export interface RootEditorView {
  tabs: EditorTab[];
  active: string | null;
  jump: JumpTarget | null;
}

interface RootRecord {
  tabs: EditorTab[];
  active: string | null;
  jump: JumpTarget | null;
  view: RootEditorView;
}

const EMPTY_VIEW: RootEditorView = Object.freeze({ tabs: [], active: null, jump: null });

const roots = new Map<string, RootRecord>();
const knownRoots = new Set<string>();
const subscribers = new Set<() => void>();
const closeListeners = new Set<(root: string, path: string) => void>();
const renameListeners = new Set<(root: string, from: string, to: string) => void>();
let jumpSeq = 0;

function emit() {
  subscribers.forEach((fn) => fn());
}

function getOrCreateRoot(root: string): RootRecord {
  knownRoots.add(root);
  let rec = roots.get(root);
  if (!rec) {
    rec = { tabs: [], active: null, jump: null, view: EMPTY_VIEW };
    roots.set(root, rec);
  }
  return rec;
}

function publish(rec: RootRecord) {
  rec.view = {
    tabs: rec.tabs.map((t) => ({ ...t })),
    active: rec.active,
    jump: rec.jump ? { ...rec.jump } : null,
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
export function onTabClosed(fn: (root: string, path: string) => void): () => void {
  closeListeners.add(fn);
  return () => {
    closeListeners.delete(fn);
  };
}

/** Register a callback invoked whenever an open tab's path is rewritten after rename/move. */
export function onTabRenamed(fn: (root: string, from: string, to: string) => void): () => void {
  renameListeners.add(fn);
  return () => {
    renameListeners.delete(fn);
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
  const existing = rec.tabs.find((t) => t.path === rel);
  const hasLine = typeof line === "number" && Number.isFinite(line) && line >= 1;
  if (existing && rec.active === rel && !hasLine) return;
  if (!existing) {
    rec.tabs.push({ path: rel, dirty: false, deleted: false, diskChanged: false, mtime: null });
  }
  rec.active = rel;
  if (hasLine) {
    rec.jump = { path: rel, line: Math.floor(line), seq: ++jumpSeq };
  }
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
export function activateTab(root: string, path: string): void {
  const rel = normalizeRelativePath(path);
  const rec = roots.get(root);
  if (!rec || rec.active === rel) return;
  if (!rec.tabs.some((t) => t.path === rel)) return;
  rec.active = rel;
  publish(rec);
}

/** Close a tab for `root` and choose the next active tab. */
export function closeTab(root: string, path: string): void {
  const rel = normalizeRelativePath(path);
  const rec = roots.get(root);
  if (!rec) return;
  if (!rec.tabs.some((t) => t.path === rel)) return;
  rec.active = nextActiveAfterClose(
    rec.tabs.map((t) => t.path),
    rec.active,
    rel,
  );
  rec.tabs = rec.tabs.filter((t) => t.path !== rel);
  if (rec.jump?.path === rel) rec.jump = null;
  closeListeners.forEach((fn) => fn(root, rel));
  publish(rec);
}

/** Update metadata flags on an open tab. */
export function setTabState(
  root: string,
  path: string,
  patch: Partial<Pick<EditorTab, "dirty" | "deleted" | "diskChanged" | "mtime">>,
): void {
  const rel = normalizeRelativePath(path);
  const rec = roots.get(root);
  if (!rec) return;
  const tab = rec.tabs.find((t) => t.path === rel);
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

/** Update open tabs (and active/jump paths) when a file or folder is renamed or moved. */
export function renamePath(root: string, from: string, to: string): void {
  const fromRel = normalizeRelativePath(from);
  const toRel = normalizeRelativePath(to);
  if (!root || !fromRel || !toRel || fromRel === toRel) return;
  const rec = roots.get(root);
  if (!rec) return;

  const renames: [string, string][] = [];
  for (const tab of rec.tabs) {
    if (!pathMatchesPrefix(tab.path, fromRel)) continue;
    const next = rewritePathPrefix(tab.path, fromRel, toRel);
    if (next !== tab.path) {
      renames.push([tab.path, next]);
    }
  }
  if (renames.length === 0) return;

  const renamedTargets = new Set(renames.map(([, next]) => next));
  // Drop any stale tab already occupying a renamed target path.
  const staleRemoved: string[] = [];
  rec.tabs = rec.tabs.filter((tab) => {
    if (!pathMatchesPrefix(tab.path, fromRel) && renamedTargets.has(tab.path)) {
      staleRemoved.push(tab.path);
      return false;
    }
    return true;
  });

  const renameMap = new Map(renames);
  for (const tab of rec.tabs) {
    const next = renameMap.get(tab.path);
    if (next !== undefined) {
      tab.path = next;
    }
  }
  if (rec.active && pathMatchesPrefix(rec.active, fromRel)) {
    rec.active = rewritePathPrefix(rec.active, fromRel, toRel);
  }
  if (rec.jump && pathMatchesPrefix(rec.jump.path, fromRel)) {
    rec.jump = { ...rec.jump, path: rewritePathPrefix(rec.jump.path, fromRel, toRel) };
  }

  for (const stale of staleRemoved) {
    closeListeners.forEach((fn) => fn(root, stale));
  }
  for (const [oldPath, newPath] of renames) {
    renameListeners.forEach((fn) => fn(root, oldPath, newPath));
  }
  publish(rec);
}

/** Sync open tabs when a file or folder is trashed: close clean tabs, mark dirty tabs deleted. */
export function handleDeletedPath(root: string, path: string): void {
  const rel = normalizeRelativePath(path);
  if (!root || !rel) return;
  const rec = roots.get(root);
  if (!rec) return;

  const toClose: string[] = [];
  let changed = false;

  for (const tab of rec.tabs) {
    if (!pathMatchesPrefix(tab.path, rel)) continue;
    if (tab.dirty) {
      if (!tab.deleted || tab.diskChanged) {
        tab.deleted = true;
        tab.diskChanged = false;
        changed = true;
      }
    } else {
      toClose.push(tab.path);
    }
  }

  for (const closing of toClose) {
    rec.active = nextActiveAfterClose(
      rec.tabs.map((t) => t.path),
      rec.active,
      closing,
    );
    rec.tabs = rec.tabs.filter((t) => t.path !== closing);
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

/** Clear all module state (intended for unit tests). */
export function resetEditorStore(): void {
  roots.clear();
  knownRoots.clear();
  subscribers.clear();
  closeListeners.clear();
  renameListeners.clear();
  jumpSeq = 0;
}
