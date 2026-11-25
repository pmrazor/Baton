import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  ExternalLink,
  FileCode2,
  RefreshCw,
  Rows2,
  X,
} from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, toFsError, type FsError, type GitDiffTexts } from "../../api";
import ContextMenu from "../ContextMenu";
import {
  buildEditorTabMenuSections,
  detectPlatform,
  diffTabLabel,
  fileName,
  joinPath,
  shortHash,
  tabIdsToClose,
  type BulkCloseAction,
  type EditorTabMenuActionId,
} from "./codeHelpers";
import {
  activateTab,
  clearJump,
  closeTab,
  closeTabs,
  getRootEditorView,
  onTabClosed,
  onTabRenamed,
  openFile,
  registerRoot,
  revealInTree,
  setTabState,
  useEditorRoot,
} from "./editorStore";
import type * as CmEngineModule from "./cmEngine";
import type * as CmDiffEngineModule from "./cmDiffEngine";
import "./code.css";

export interface CodeEditorProps {
  root: string;
}

type CmEngine = typeof CmEngineModule;
type CmDiffEngine = typeof CmDiffEngineModule;
type DiffViewMode = CmDiffEngineModule.DiffViewMode;

type TabLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "empty" }
  | { status: "binary" }
  | { status: "unsupported"; error: FsError }
  | { status: "error"; error: FsError };

interface TabRuntime {
  load: TabLoadState;
  saving: boolean;
  /** Disk mtime that the user chose to ignore while dirty. */
  ignoredMtime: number | null;
  /** Latest disk mtime seen by the poller while dirty. */
  latestDiskMtime: number | null;
  /** Last diff payload fetched from `git_diff_texts` (diff tabs only). */
  lastDiff: GitDiffTexts | null;
  /** Current number of changed chunks (diff tabs only). */
  chunkCount: number;
  /** True while a manual refresh is in flight (diff tabs only). */
  refreshing: boolean;
}

const POLL_INTERVAL_MS = 2000;
const DIFF_POLL_INTERVAL_MS = 3000;
const DIFF_MODE_STORAGE_KEY = "baton.diffViewMode";
const PLATFORM = detectPlatform();

let enginePromise: Promise<CmEngine> | null = null;
function loadEngine(): Promise<CmEngine> {
  enginePromise ??= import("./cmEngine");
  return enginePromise;
}

let diffEnginePromise: Promise<CmDiffEngine> | null = null;
function loadDiffEngine(): Promise<CmDiffEngine> {
  diffEnginePromise ??= import("./cmDiffEngine");
  return diffEnginePromise;
}

function readDiffViewMode(): DiffViewMode {
  try {
    const raw = window.localStorage.getItem(DIFF_MODE_STORAGE_KEY);
    if (raw === "unified" || raw === "split") return raw;
  } catch {
    // Ignore storage access errors.
  }
  return "split";
}

function writeDiffViewMode(mode: DiffViewMode): void {
  try {
    window.localStorage.setItem(DIFF_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage access errors.
  }
}

function keyOf(root: string, tabId: string): string {
  return `${root}\0${tabId}`;
}

function sameDiffTexts(a: GitDiffTexts | null, b: GitDiffTexts): boolean {
  return a !== null && a.binary === b.binary && a.original === b.original && a.modified === b.modified;
}

const runtimes = new Map<string, TabRuntime>();
const inflightLoads = new Set<string>();

onTabClosed((root, id) => {
  const k = keyOf(root, id);
  runtimes.delete(k);
  inflightLoads.delete(k);
});

onTabRenamed((root, fromId, toId) => {
  const oldKey = keyOf(root, fromId);
  const newKey = keyOf(root, toId);
  if (oldKey === newKey) return;
  const rt = runtimes.get(oldKey);
  if (rt) {
    runtimes.delete(oldKey);
    runtimes.set(newKey, rt);
  }
  if (inflightLoads.delete(oldKey)) {
    inflightLoads.add(newKey);
  }
});

function getRuntime(key: string): TabRuntime {
  let rt = runtimes.get(key);
  if (!rt) {
    rt = {
      load: { status: "loading" },
      saving: false,
      ignoredMtime: null,
      latestDiskMtime: null,
      lastDiff: null,
      chunkCount: 0,
      refreshing: false,
    };
    runtimes.set(key, rt);
  }
  return rt;
}

export default function CodeEditor({ root }: CodeEditorProps) {
  const { tabs, active, jump } = useEditorRoot(root);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const [diffMode, setDiffMode] = useState<DiffViewMode>(readDiffViewMode);
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  const stripRef = useRef<HTMLDivElement>(null);
  const cmHostRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<CmEngineModule.EditorView | null>(null);
  const engineRef = useRef<CmEngine | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const diffHostRef = useRef<HTMLDivElement>(null);
  const diffEngineRef = useRef<CmDiffEngine | null>(null);
  const mountedDiffKeyRef = useRef<string | null>(null);
  const diffModeRef = useRef<DiffViewMode>(diffMode);
  diffModeRef.current = diffMode;

  const activeTab = active ? (tabs.find((t) => t.id === active) ?? null) : null;
  const activeKey = active ? keyOf(root, active) : null;
  const activeRuntime = activeKey ? runtimes.get(activeKey) : undefined;
  const isDiffTab = activeTab?.kind === "diff";

  useEffect(() => {
    registerRoot(root);
    setMenu(null);
  }, [root]);

  // Keep the active tab scrolled into view.
  useEffect(() => {
    stripRef.current
      ?.querySelector(".code-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const diffCallbacksRef = useRef<CmDiffEngineModule.DiffCallbacks>({
    onDirtyChange: () => undefined,
    onSave: () => undefined,
    onChunksChange: () => undefined,
  });

  const reloadTabFromDisk = useCallback(
    async (tabRoot: string, tabId: string) => {
      const tab = getRootEditorView(tabRoot).tabs.find((t) => t.id === tabId && t.kind === "file");
      if (!tab) return;
      const k = keyOf(tabRoot, tabId);
      const rt = getRuntime(k);
      try {
        const [content, engine] = await Promise.all([api.fsRead(tabRoot, tab.path), loadEngine()]);
        engineRef.current = engine;
        // Tab might have been closed while reading.
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.id === tabId)) return;
        const existing = engine.getSession(k);
        if (existing) {
          engine.reloadSessionText(k, content.text, cmViewRef.current);
        } else {
          engine.ensureTabSession(k, tab.path, content.text, cmViewRef.current);
        }
        rt.load = { status: "ready" };
        rt.ignoredMtime = null;
        rt.latestDiskMtime = content.mtime;
        setTabState(tabRoot, tabId, {
          mtime: content.mtime,
          dirty: false,
          deleted: false,
          diskChanged: false,
        });
      } catch (err) {
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.id === tabId)) return;
        const fsErr = toFsError(err);
        if (fsErr.kind === "too_large" || fsErr.kind === "binary") {
          rt.load = { status: "unsupported", error: fsErr };
        } else if (fsErr.kind === "not_found") {
          setTabState(tabRoot, tabId, { deleted: true, diskChanged: false });
          if (rt.load.status !== "ready") {
            rt.load = { status: "error", error: fsErr };
          }
        } else {
          rt.load = { status: "error", error: fsErr };
        }
      }
      rerender();
    },
    [rerender],
  );

  const reloadDiffTab = useCallback(
    async (tabRoot: string, tabId: string, opts?: { silent?: boolean; force?: boolean }) => {
      const tab = getRootEditorView(tabRoot).tabs.find((t) => t.id === tabId && t.kind === "diff");
      if (!tab) return;
      const isCommitDiff = !!tab.commitHash;
      const readOnly = !!tab.staged || isCommitDiff;
      const k = keyOf(tabRoot, tabId);
      const rt = getRuntime(k);

      if (!opts?.silent) {
        rt.refreshing = true;
        rerender();
      }

      try {
        const [diff, mtimes] = await Promise.all([
          isCommitDiff
            ? api.gitDiffCommitTexts(tabRoot, tab.commitHash!, tab.path, tab.origPath)
            : api.gitDiffTexts(tabRoot, tab.path, !!tab.staged),
          readOnly ? Promise.resolve<[number | null]>([null]) : api.fsStat(tabRoot, [tab.path]),
        ]);

        // Tab might have been closed or become dirty while polling.
        const latest = getRootEditorView(tabRoot).tabs.find((t) => t.id === tabId && t.kind === "diff");
        if (!latest) return;
        if (opts?.silent && latest.dirty) return;

        const diskMtime = readOnly ? null : (mtimes[0] ?? null);
        if (!opts?.force && rt.load.status !== "loading" && sameDiffTexts(rt.lastDiff, diff)) {
          // Even when texts didn't change, keep unstaged mtime synced.
          if (!readOnly && latest.mtime !== diskMtime) {
            rt.latestDiskMtime = diskMtime;
            setTabState(tabRoot, tabId, { mtime: diskMtime, deleted: diff.modified === null });
          }
          return;
        }

        rt.lastDiff = diff;
        rt.ignoredMtime = null;
        rt.latestDiskMtime = diskMtime;

        if (diff.binary) {
          rt.load = { status: "binary" };
          rt.chunkCount = 0;
          setTabState(tabRoot, tabId, {
            mtime: diskMtime,
            dirty: false,
            deleted: false,
            diskChanged: false,
          });
          return;
        }

        if (diff.original === diff.modified) {
          rt.load = { status: "empty" };
          rt.chunkCount = 0;
          setTabState(tabRoot, tabId, {
            mtime: diskMtime,
            dirty: false,
            deleted: !readOnly && diff.modified === null,
            diskChanged: false,
          });
          return;
        }

        const diffEngine = diffEngineRef.current ?? (await loadDiffEngine());
        diffEngineRef.current = diffEngine;
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.id === tabId)) return;

        const callbacks: CmDiffEngineModule.DiffCallbacks = {
          onDirtyChange: (ck, d) => diffCallbacksRef.current.onDirtyChange(ck, d),
          onSave: (ck) => diffCallbacksRef.current.onSave(ck),
          onChunksChange: (ck, c) => diffCallbacksRef.current.onChunksChange(ck, c),
        };
        const session = diffEngine.ensureDiffSession(
          k,
          latest.path,
          readOnly,
          diff.original,
          diff.modified,
          diffModeRef.current,
          callbacks,
        );
        rt.chunkCount = session.chunkCount;
        rt.load = { status: "ready" };
        setTabState(tabRoot, tabId, {
          mtime: diskMtime,
          dirty: false,
          deleted: !readOnly && diff.modified === null,
          diskChanged: false,
        });
      } catch (err) {
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.id === tabId)) return;
        if (!opts?.silent || rt.load.status === "loading") {
          rt.load = { status: "error", error: toFsError(err) };
        }
      } finally {
        rt.refreshing = false;
        rerender();
      }
    },
    [rerender],
  );

  const saveTab = useCallback(
    async (tabRoot: string, tabId: string) => {
      const k = keyOf(tabRoot, tabId);
      const rt = runtimes.get(k);
      const engine = engineRef.current;
      if (!rt || rt.load.status !== "ready" || rt.saving || !engine) return;
      const text = engine.getSessionText(k, cmViewRef.current);
      if (text === null) return;
      const currentTab = getRootEditorView(tabRoot).tabs.find((t) => t.id === tabId && t.kind === "file");
      if (!currentTab) return;

      rt.saving = true;
      try {
        const newMtime = await api.fsWrite(tabRoot, currentTab.path, text, currentTab.mtime);
        engine.markSessionSaved(k, cmViewRef.current);
        rt.ignoredMtime = null;
        rt.latestDiskMtime = newMtime;
        setTabState(tabRoot, tabId, {
          mtime: newMtime,
          dirty: false,
          deleted: false,
          diskChanged: false,
        });
        // Keep any clean unstaged diff tab for the same file in sync.
        const matchingDiff = getRootEditorView(tabRoot).tabs.find(
          (t) => t.kind === "diff" && !t.staged && t.path === currentTab.path && !t.dirty,
        );
        if (matchingDiff) {
          void reloadDiffTab(tabRoot, matchingDiff.id, { silent: true });
        }
      } catch (err) {
        const fsErr = toFsError(err);
        if (fsErr.kind === "conflict") {
          const overwrite = await ask(
            `'${fileName(currentTab.path)}' 파일이 디스크에서 바뀌었어요. 지금 내용으로 덮어쓸까요, 아니면 디스크에서 다시 불러올까요?`,
            {
              title: "파일 충돌",
              kind: "warning",
              okLabel: "덮어쓰기",
              cancelLabel: "다시 불러오기",
            },
          );
          if (overwrite) {
            try {
              const forcedMtime = await api.fsWrite(tabRoot, currentTab.path, text, null);
              engine.markSessionSaved(k, cmViewRef.current);
              rt.ignoredMtime = null;
              rt.latestDiskMtime = forcedMtime;
              setTabState(tabRoot, tabId, {
                mtime: forcedMtime,
                dirty: false,
                deleted: false,
                diskChanged: false,
              });
            } catch (writeErr) {
              rt.load = { status: "error", error: toFsError(writeErr) };
              rerender();
            }
          } else {
            await reloadTabFromDisk(tabRoot, tabId);
          }
        } else {
          await ask(`파일을 저장하지 못했어요: ${fsErr.message}`, {
            title: "저장 실패",
            kind: "error",
            okLabel: "확인",
            cancelLabel: "닫기",
          });
        }
      } finally {
        rt.saving = false;
      }
    },
    [reloadDiffTab, reloadTabFromDisk, rerender],
  );

  const saveDiffTab = useCallback(
    async (tabRoot: string, tabId: string) => {
      const k = keyOf(tabRoot, tabId);
      const rt = runtimes.get(k);
      const diffEngine = diffEngineRef.current;
      if (!rt || rt.load.status !== "ready" || rt.saving || !diffEngine) return;
      const currentTab = getRootEditorView(tabRoot).tabs.find((t) => t.id === tabId && t.kind === "diff");
      if (!currentTab || currentTab.staged) return;
      const session = diffEngine.getDiffSession(k);
      if (!session || !session.editable) return;
      const text = diffEngine.getDiffModifiedText(k);
      if (text === null) return;

      rt.saving = true;
      try {
        const newMtime = await api.fsWrite(tabRoot, currentTab.path, text, currentTab.mtime);
        diffEngine.markDiffSessionSaved(k);
        rt.ignoredMtime = null;
        rt.latestDiskMtime = newMtime;
        if (rt.lastDiff) {
          rt.lastDiff = { ...rt.lastDiff, modified: text };
        }
        setTabState(tabRoot, tabId, {
          mtime: newMtime,
          dirty: false,
          deleted: false,
          diskChanged: false,
        });
        // Keep any clean normal tab for the same file in sync.
        const matchingNormal = getRootEditorView(tabRoot).tabs.find(
          (t) => t.kind === "file" && t.path === currentTab.path && !t.dirty,
        );
        if (matchingNormal) {
          void reloadTabFromDisk(tabRoot, matchingNormal.id);
        }
      } catch (err) {
        const fsErr = toFsError(err);
        if (fsErr.kind === "conflict") {
          const overwrite = await ask(
            `'${fileName(currentTab.path)}' 파일이 디스크에서 바뀌었어요. 지금 내용으로 덮어쓸까요, 아니면 디스크에서 다시 불러올까요?`,
            {
              title: "파일 충돌",
              kind: "warning",
              okLabel: "덮어쓰기",
              cancelLabel: "다시 불러오기",
            },
          );
          if (overwrite) {
            try {
              const forcedMtime = await api.fsWrite(tabRoot, currentTab.path, text, null);
              diffEngine.markDiffSessionSaved(k);
              rt.ignoredMtime = null;
              rt.latestDiskMtime = forcedMtime;
              if (rt.lastDiff) {
                rt.lastDiff = { ...rt.lastDiff, modified: text };
              }
              setTabState(tabRoot, tabId, {
                mtime: forcedMtime,
                dirty: false,
                deleted: false,
                diskChanged: false,
              });
            } catch (writeErr) {
              rt.load = { status: "error", error: toFsError(writeErr) };
              rerender();
            }
          } else {
            await reloadDiffTab(tabRoot, tabId, { force: true });
          }
        } else {
          await ask(`파일을 저장하지 못했어요: ${fsErr.message}`, {
            title: "저장 실패",
            kind: "error",
            okLabel: "확인",
            cancelLabel: "닫기",
          });
        }
      } finally {
        rt.saving = false;
      }
    },
    [reloadDiffTab, reloadTabFromDisk, rerender],
  );

  const callbacksRef = useRef<CmEngineModule.EngineCallbacks>({
    onDirtyChange: () => undefined,
    onSave: () => undefined,
  });

  callbacksRef.current = {
    onDirtyChange: (k, dirty) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      setTabState(k.slice(0, sepIdx), k.slice(sepIdx + 1), { dirty });
    },
    onSave: (k) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      void saveTab(k.slice(0, sepIdx), k.slice(sepIdx + 1));
    },
  };

  diffCallbacksRef.current = {
    onDirtyChange: (k, dirty) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      setTabState(k.slice(0, sepIdx), k.slice(sepIdx + 1), { dirty });
    },
    onSave: (k) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      void saveDiffTab(k.slice(0, sepIdx), k.slice(sepIdx + 1));
    },
    onChunksChange: (k, count) => {
      const rt = runtimes.get(k);
      if (rt && rt.chunkCount !== count) {
        rt.chunkCount = count;
        rerender();
      }
    },
  };

  // Load active tab (normal or diff) on demand.
  useEffect(() => {
    if (!activeTab || !activeKey) return;
    const rt = runtimes.get(activeKey);
    if (rt && rt.load.status !== "loading") return;
    if (inflightLoads.has(activeKey)) return;

    getRuntime(activeKey).load = { status: "loading" };
    inflightLoads.add(activeKey);
    rerender();

    void (async () => {
      try {
        if (activeTab.kind === "diff") {
          await reloadDiffTab(root, activeTab.id, { force: true });
        } else {
          await reloadTabFromDisk(root, activeTab.id);
        }
      } finally {
        inflightLoads.delete(activeKey);
      }
    })();
  }, [root, activeTab, activeKey, reloadDiffTab, reloadTabFromDisk, rerender]);

  // Mount or switch CodeMirror when an active normal file tab is ready.
  const isNormalReady = !isDiffTab && activeRuntime?.load.status === "ready";
  useEffect(() => {
    if (!isNormalReady || !active || !activeKey) {
      if (cmViewRef.current) {
        engineRef.current?.saveViewSnapshot(cmViewRef.current);
        engineRef.current?.releaseView(cmViewRef.current);
        cmViewRef.current.destroy();
        cmViewRef.current = null;
        activeKeyRef.current = null;
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      const engine = engineRef.current ?? (await loadEngine());
      engineRef.current = engine;
      if (cancelled) return;
      const host = cmHostRef.current;
      const session = engine.getSession(activeKey);
      if (!host || !session) return;

      const callbacks: CmEngineModule.EngineCallbacks = {
        onDirtyChange: (k, d) => callbacksRef.current.onDirtyChange(k, d),
        onSave: (k) => callbacksRef.current.onSave(k),
      };

      if (!cmViewRef.current) {
        cmViewRef.current = engine.createEditorView(host, session, callbacks);
        activeKeyRef.current = activeKey;
      } else if (activeKeyRef.current !== activeKey) {
        engine.switchViewSession(cmViewRef.current, session, callbacks);
        activeKeyRef.current = activeKey;
      }

      const pending = getRootEditorView(root).jump;
      if (pending && pending.path === active && cmViewRef.current) {
        engine.jumpToLine(cmViewRef.current, pending.line);
        clearJump(root, pending.seq);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [root, active, activeKey, isNormalReady]);

  // Mount or switch DiffSession DOM when an active diff tab is ready.
  const isDiffReady = isDiffTab && activeRuntime?.load.status === "ready";
  useEffect(() => {
    if (!isDiffReady || !activeKey) {
      if (mountedDiffKeyRef.current) {
        diffEngineRef.current?.detachDiffSession(mountedDiffKeyRef.current);
        mountedDiffKeyRef.current = null;
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      const diffEngine = diffEngineRef.current ?? (await loadDiffEngine());
      diffEngineRef.current = diffEngine;
      if (cancelled) return;
      const host = diffHostRef.current;
      const session = diffEngine.getDiffSession(activeKey);
      if (!host || !session) return;

      if (mountedDiffKeyRef.current && mountedDiffKeyRef.current !== activeKey) {
        diffEngine.detachDiffSession(mountedDiffKeyRef.current);
      }
      const callbacks: CmDiffEngineModule.DiffCallbacks = {
        onDirtyChange: (k, d) => diffCallbacksRef.current.onDirtyChange(k, d),
        onSave: (k) => diffCallbacksRef.current.onSave(k),
        onChunksChange: (k, c) => diffCallbacksRef.current.onChunksChange(k, c),
      };
      diffEngine.mountDiffSession(host, session, diffMode, callbacks);
      mountedDiffKeyRef.current = activeKey;
    })();

    return () => {
      cancelled = true;
    };
  }, [activeKey, isDiffReady, diffMode]);

  // Handle jump-to-line requests on an already-mounted normal tab.
  useEffect(() => {
    if (!jump || !isNormalReady || jump.path !== active) return;
    const view = cmViewRef.current;
    const engine = engineRef.current;
    if (!view || !engine || activeKeyRef.current !== activeKey) return;
    engine.jumpToLine(view, jump.line);
    clearJump(root, jump.seq);
  }, [root, active, activeKey, isNormalReady, jump]);

  // Destroy the EditorView and detach any mounted DiffSession cleanly on unmount while keeping sessions cached.
  useEffect(() => {
    return () => {
      if (cmViewRef.current) {
        engineRef.current?.saveViewSnapshot(cmViewRef.current);
        engineRef.current?.releaseView(cmViewRef.current);
        cmViewRef.current.destroy();
        cmViewRef.current = null;
        activeKeyRef.current = null;
      }
      if (mountedDiffKeyRef.current) {
        diffEngineRef.current?.detachDiffSession(mountedDiffKeyRef.current);
        mountedDiffKeyRef.current = null;
      }
    };
  }, []);

  // Poll `fs_stat` every 2s and on window focus for normal tabs and unstaged diff tabs.
  useEffect(() => {
    if (tabs.length === 0) return;
    let polling = false;
    let disposed = false;

    const poll = async () => {
      if (polling || disposed) return;
      const snapshot = getRootEditorView(root);
      const watchedTabs = snapshot.tabs.filter(
        (t) => t.kind === "file" || (t.kind === "diff" && !t.staged),
      );
      if (watchedTabs.length === 0) return;
      const uniquePaths = Array.from(new Set(watchedTabs.map((t) => t.path)));
      polling = true;
      try {
        const mtimes = await api.fsStat(root, uniquePaths);
        if (disposed) return;
        const mtimeByPath = new Map<string, number | null>();
        for (let i = 0; i < uniquePaths.length; i++) {
          mtimeByPath.set(uniquePaths[i], mtimes[i] ?? null);
        }

        const latestTabs = getRootEditorView(root).tabs;
        for (const tab of latestTabs) {
          if (tab.kind === "diff" && tab.staged) continue;
          if (!mtimeByPath.has(tab.path)) continue;
          const diskMtime = mtimeByPath.get(tab.path) ?? null;
          const k = keyOf(root, tab.id);
          const rt = runtimes.get(k);
          if (!rt || rt.saving || inflightLoads.has(k)) continue;

          if (diskMtime === null) {
            if (tab.kind === "diff") {
              if (!tab.dirty && rt.lastDiff?.modified !== null) {
                void reloadDiffTab(root, tab.id, { silent: true });
              } else if (tab.dirty && !tab.deleted) {
                setTabState(root, tab.id, { deleted: true, diskChanged: false });
              }
            } else if (!tab.deleted) {
              setTabState(root, tab.id, { deleted: true, diskChanged: false });
            }
            continue;
          }

          if (tab.deleted) {
            if (tab.kind === "diff" && !tab.dirty) {
              void reloadDiffTab(root, tab.id, { silent: true });
              continue;
            }
            setTabState(root, tab.id, { deleted: false });
          }

          if (tab.mtime !== null && diskMtime !== tab.mtime) {
            if (!tab.dirty) {
              if (tab.kind === "diff") {
                void reloadDiffTab(root, tab.id, { silent: true });
              } else {
                void reloadTabFromDisk(root, tab.id);
              }
            } else if (rt.ignoredMtime !== diskMtime) {
              rt.latestDiskMtime = diskMtime;
              if (!tab.diskChanged) {
                setTabState(root, tab.id, { diskChanged: true });
              }
            }
          }
        }
      } catch {
        // Ignore transient stat failures during background polling.
      } finally {
        polling = false;
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    const onFocus = () => {
      void poll();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root, tabs.length, reloadDiffTab, reloadTabFromDisk]);

  // Poll `git_diff_texts` every 3s while an active live (non-commit) diff tab is visible and not dirty.
  const activeTabId = activeTab?.id ?? null;
  const activeTabIsDiff = activeTab?.kind === "diff" && !activeTab.commitHash;
  const activeTabDirty = activeTab?.dirty ?? false;
  useEffect(() => {
    if (!activeTabIsDiff || !activeTabId || activeTabDirty) return;
    let polling = false;
    let disposed = false;

    const pollDiff = async () => {
      if (polling || disposed || document.hidden) return;
      const latest = getRootEditorView(root).tabs.find(
        (t) => t.id === activeTabId && t.kind === "diff",
      );
      if (!latest || latest.dirty) return;
      const k = keyOf(root, activeTabId);
      const rt = runtimes.get(k);
      if (!rt || rt.saving || inflightLoads.has(k) || rt.load.status === "loading") return;

      polling = true;
      try {
        await reloadDiffTab(root, activeTabId, { silent: true });
      } finally {
        polling = false;
      }
    };

    void pollDiff();
    const timer = window.setInterval(() => {
      void pollDiff();
    }, DIFF_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) void pollDiff();
    };
    window.addEventListener("focus", onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [root, activeTabId, activeTabIsDiff, activeTabDirty, reloadDiffTab]);

  const handleCloseTab = async (tabId: string) => {
    const tab = getRootEditorView(root).tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask(`'${fileName(tab.path)}'의 저장하지 않은 변경 사항을 버릴까요?`, {
        title: "저장하지 않은 변경 사항",
        kind: "warning",
      });
      if (!ok) return;
    }
    closeTab(root, tabId);
  };

  const handleBulkClose = async (targetId: string, action: BulkCloseAction) => {
    const latestTabs = getRootEditorView(root).tabs;
    const orderedIds = latestTabs.map((t) => t.id);
    const dirtyIds = new Set(latestTabs.filter((t) => t.dirty).map((t) => t.id));
    const idsToClose = tabIdsToClose(orderedIds, targetId, action, dirtyIds);
    if (idsToClose.length === 0) return;

    const dirtyCount = idsToClose.filter((id) => dirtyIds.has(id)).length;
    if (dirtyCount > 0) {
      const ok = await ask(
        `저장하지 않은 파일 ${dirtyCount}개가 있어요. 변경을 버리고 닫을까요?`,
        {
          title: "저장하지 않은 변경 사항",
          kind: "warning",
          okLabel: "닫기",
          cancelLabel: "취소",
        },
      );
      if (!ok) return;
    }
    closeTabs(root, idsToClose);
  };

  const menuTab = menu ? (tabs.find((t) => t.id === menu.tabId) ?? null) : null;

  const menuSections = useMemo(() => {
    if (!menuTab) return [];
    const orderedIds = tabs.map((t) => t.id);
    const dirtyIds = new Set(tabs.filter((t) => t.dirty).map((t) => t.id));
    return buildEditorTabMenuSections({
      orderedIds,
      targetId: menuTab.id,
      dirtyIds,
      isDiff: menuTab.kind === "diff",
      platform: PLATFORM,
    });
  }, [menuTab, tabs]);

  const handleTabMenuSelect = (action: EditorTabMenuActionId) => {
    if (!menu) return;
    const tab = getRootEditorView(root).tabs.find((t) => t.id === menu.tabId);
    if (!tab) return;
    switch (action) {
      case "close":
        void handleCloseTab(tab.id);
        return;
      case "closeOthers":
        void handleBulkClose(tab.id, "others");
        return;
      case "closeLeft":
        void handleBulkClose(tab.id, "left");
        return;
      case "closeRight":
        void handleBulkClose(tab.id, "right");
        return;
      case "closeSaved":
        void handleBulkClose(tab.id, "saved");
        return;
      case "closeAll":
        void handleBulkClose(tab.id, "all");
        return;
      case "copyPath":
        void navigator.clipboard.writeText(joinPath(root, tab.path)).catch(() => undefined);
        return;
      case "copyRelativePath":
        void navigator.clipboard.writeText(tab.path).catch(() => undefined);
        return;
      case "revealInTree":
        revealInTree(root, tab.path);
        return;
      case "openFile":
        openFile(root, tab.path);
        return;
    }
  };

  const handleOpenDefault = (relPath: string) => {
    void api.openAttachment(joinPath(root, relPath));
  };

  const handleIgnoreDiskChange = (tabId: string) => {
    const k = keyOf(root, tabId);
    const rt = runtimes.get(k);
    if (rt && rt.latestDiskMtime !== null) {
      rt.ignoredMtime = rt.latestDiskMtime;
    }
    setTabState(root, tabId, { diskChanged: false });
  };

  const handleReloadActiveFromBar = () => {
    if (!activeTab) return;
    if (activeTab.kind === "diff") {
      void reloadDiffTab(root, activeTab.id, { force: true });
    } else {
      void reloadTabFromDisk(root, activeTab.id);
    }
  };

  const handleRefreshDiff = async () => {
    if (!activeTab || activeTab.kind !== "diff") return;
    if (activeTab.dirty) {
      const ok = await ask(
        `'${fileName(activeTab.path)}'의 저장하지 않은 변경 사항을 버리고 다시 불러올까요?`,
        {
          title: "저장하지 않은 변경 사항",
          kind: "warning",
        },
      );
      if (!ok) return;
    }
    await reloadDiffTab(root, activeTab.id, { force: true });
  };

  const handleSetDiffMode = (mode: DiffViewMode) => {
    if (mode === diffMode) return;
    writeDiffViewMode(mode);
    setDiffMode(mode);
  };

  const handleNavigateChunk = (dir: 1 | -1) => {
    if (!activeKey || !isDiffReady) return;
    diffEngineRef.current?.navigateDiffChunk(activeKey, dir);
  };

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "s") {
      if (activeTab) {
        ev.preventDefault();
        if (activeTab.kind === "diff") {
          if (!activeTab.staged) void saveDiffTab(root, activeTab.id);
        } else {
          void saveTab(root, activeTab.id);
        }
      }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "w") {
      if (activeTab) {
        ev.preventDefault();
        void handleCloseTab(activeTab.id);
      }
      return;
    }
    if (ev.key === "F7" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && isDiffReady && activeKey) {
      ev.preventDefault();
      diffEngineRef.current?.navigateDiffChunk(activeKey, ev.shiftKey ? -1 : 1);
    }
  };

  if (tabs.length === 0) {
    return (
      <div className="code-editor">
        <div className="code-editor-placeholder">
          <p>파일 트리에서 파일을 선택하세요</p>
        </div>
      </div>
    );
  }

  const diffChunkCount = activeRuntime?.chunkCount ?? 0;
  const diffOriginalMissing = activeRuntime?.lastDiff?.original === null;
  const diffModifiedMissing = activeRuntime?.lastDiff?.modified === null;
  const commitShort = activeTab?.commitHash ? shortHash(activeTab.commitHash) : null;
  const originalHeaderDetail = commitShort
    ? diffOriginalMissing
      ? "새 파일"
      : `${commitShort}~1`
    : activeTab?.staged
      ? diffOriginalMissing
        ? "새 파일"
        : "HEAD"
      : diffOriginalMissing
        ? "새 파일"
        : "인덱스 / HEAD";
  const modifiedHeaderDetail = commitShort
    ? diffModifiedMissing
      ? "삭제됨 · 읽기 전용"
      : `${commitShort} · 읽기 전용`
    : activeTab?.staged
      ? diffModifiedMissing
        ? "삭제됨 · 읽기 전용"
        : "스테이징됨 · 읽기 전용"
      : diffModifiedMissing
        ? "삭제됨 · 읽기 전용"
        : "작업 트리";

  return (
    <div className="code-editor" onKeyDown={handleKeyDown}>
      <div
        className="code-tabs"
        ref={stripRef}
        role="tablist"
        aria-label="열린 파일"
        onWheel={(ev) => {
          if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
            ev.currentTarget.scrollLeft += ev.deltaY;
          }
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          const label =
            tab.kind === "diff"
              ? diffTabLabel(tab.path, !!tab.staged, tab.commitHash)
              : fileName(tab.path);
          const showDeletedBadge = tab.deleted && (tab.kind === "file" || tab.dirty);
          return (
            <div
              key={tab.id}
              className={`code-tab${isActive ? " active" : ""}${showDeletedBadge ? " deleted" : ""}${tab.kind === "diff" ? " diff" : ""}`}
              title={
                tab.kind === "diff"
                  ? `${tab.path} (${tab.commitHash ? shortHash(tab.commitHash) : tab.staged ? "스테이징됨" : "변경 사항"})`
                  : tab.path
              }
              onMouseDown={(ev) => ev.button === 1 && ev.preventDefault()}
              onAuxClick={(ev) => ev.button === 1 && void handleCloseTab(tab.id)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                setMenu({ x: ev.clientX, y: ev.clientY, tabId: tab.id });
              }}
            >
              <button
                type="button"
                className="code-tab-label"
                role="tab"
                aria-selected={isActive}
                onClick={() => activateTab(root, tab.id)}
              >
                <span className="code-tab-name">{label}</span>
                {showDeletedBadge && <span className="code-tab-deleted">(삭제됨)</span>}
                {tab.dirty && <span className="code-tab-dirty" aria-label="저장되지 않음" />}
              </button>
              <button
                type="button"
                className="code-tab-close"
                title="닫기"
                aria-label={`${label} 닫기`}
                onClick={() => void handleCloseTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab && isDiffTab && (
        <div className="code-diff-toolbar" role="toolbar" aria-label="비교 도구">
          <div className="code-diff-toolbar-group">
            <span className="code-diff-count">
              {activeRuntime?.load.status === "ready"
                ? diffChunkCount > 0
                  ? `변경 ${diffChunkCount}곳`
                  : "변경 없음"
                : activeRuntime?.load.status === "empty"
                  ? "변경 없음"
                  : commitShort
                    ? commitShort
                    : activeTab.staged
                      ? "스테이징됨"
                      : "변경 사항"}
            </span>
            <button
              type="button"
              className="code-diff-icon-btn"
              title="이전 변경 사항 (Shift+F7)"
              aria-label="이전 변경 사항"
              disabled={!isDiffReady || diffChunkCount === 0}
              onClick={() => handleNavigateChunk(-1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="code-diff-icon-btn"
              title="다음 변경 사항 (F7)"
              aria-label="다음 변경 사항"
              disabled={!isDiffReady || diffChunkCount === 0}
              onClick={() => handleNavigateChunk(1)}
            >
              <ChevronDown size={14} />
            </button>
          </div>

          <div className="code-diff-toolbar-group">
            <div className="code-diff-mode-toggle" role="group" aria-label="보기 방식">
              <button
                type="button"
                className={`code-diff-mode-btn${diffMode === "split" ? " active" : ""}`}
                aria-pressed={diffMode === "split"}
                onClick={() => handleSetDiffMode("split")}
              >
                <Columns2 size={13} />
                <span>나란히 보기</span>
              </button>
              <button
                type="button"
                className={`code-diff-mode-btn${diffMode === "unified" ? " active" : ""}`}
                aria-pressed={diffMode === "unified"}
                onClick={() => handleSetDiffMode("unified")}
              >
                <Rows2 size={13} />
                <span>한 줄로 보기</span>
              </button>
            </div>

            <button
              type="button"
              className="code-diff-icon-btn"
              title="새로고침"
              aria-label="새로고침"
              disabled={activeRuntime?.refreshing}
              onClick={() => void handleRefreshDiff()}
            >
              <RefreshCw size={13} className={activeRuntime?.refreshing ? "spin" : undefined} />
            </button>

            <button
              type="button"
              className="code-diff-open-btn"
              onClick={() => openFile(root, activeTab.path)}
            >
              <FileCode2 size={13} />
              <span>파일 열기</span>
            </button>
          </div>
        </div>
      )}

      {activeTab?.diskChanged && (
        <div className="code-disk-bar" role="status">
          <span>디스크에서 바뀌었어요</span>
          <div className="code-disk-bar-actions">
            <button
              type="button"
              className="code-bar-btn primary"
              onClick={handleReloadActiveFromBar}
            >
              다시 불러오기
            </button>
            <button
              type="button"
              className="code-bar-btn"
              onClick={() => handleIgnoreDiskChange(activeTab.id)}
            >
              무시
            </button>
          </div>
        </div>
      )}

      <div className="code-editor-body">
        {activeTab && isDiffTab ? (
          activeRuntime?.load.status === "ready" ? (
            <div className="code-diff-view">
              {diffMode === "split" ? (
                <div className="code-diff-panes-header split">
                  <div className="code-diff-pane-title">
                    <span>원본</span>
                    <span className="code-diff-pane-meta">{originalHeaderDetail}</span>
                  </div>
                  <div className="code-diff-pane-title">
                    <span>수정본</span>
                    <span className="code-diff-pane-meta">{modifiedHeaderDetail}</span>
                  </div>
                </div>
              ) : (
                <div className="code-diff-panes-header unified">
                  <div className="code-diff-pane-title">
                    <span>원본</span>
                    <span className="code-diff-pane-meta">({originalHeaderDetail})</span>
                    <span className="code-diff-pane-sep">→</span>
                    <span>수정본</span>
                    <span className="code-diff-pane-meta">({modifiedHeaderDetail})</span>
                  </div>
                </div>
              )}
              <div className="code-diff-host" ref={diffHostRef} />
            </div>
          ) : activeRuntime?.load.status === "empty" ? (
            <div className="code-editor-placeholder">
              <p>변경 사항이 없어요</p>
            </div>
          ) : activeRuntime?.load.status === "binary" ? (
            <div className="code-editor-placeholder">
              <p>바이너리 파일이라 비교할 수 없어요</p>
              <button
                type="button"
                className="code-open-default-btn"
                onClick={() => handleOpenDefault(activeTab.path)}
              >
                <ExternalLink size={14} /> 기본 앱으로 열기
              </button>
            </div>
          ) : activeRuntime?.load.status === "error" ? (
            <div className="code-editor-placeholder">
              <p className="error">{activeRuntime.load.error.message}</p>
              <button
                type="button"
                className="code-open-default-btn"
                onClick={() => void reloadDiffTab(root, activeTab.id, { force: true })}
              >
                다시 시도
              </button>
            </div>
          ) : (
            <div className="code-editor-placeholder">
              <p>비교 내용을 불러오는 중이에요...</p>
            </div>
          )
        ) : activeTab && activeRuntime?.load.status === "ready" ? (
          <div className="code-cm-host" ref={cmHostRef} />
        ) : activeTab && activeRuntime?.load.status === "unsupported" ? (
          <div className="code-editor-placeholder">
            <p>{activeRuntime.load.error.message}</p>
            <button
              type="button"
              className="code-open-default-btn"
              onClick={() => handleOpenDefault(activeTab.path)}
            >
              <ExternalLink size={14} /> 기본 앱으로 열기
            </button>
          </div>
        ) : activeTab && activeRuntime?.load.status === "error" ? (
          <div className="code-editor-placeholder">
            <p className="error">{activeRuntime.load.error.message}</p>
            <button
              type="button"
              className="code-open-default-btn"
              onClick={() => void reloadTabFromDisk(root, activeTab.id)}
            >
              다시 시도
            </button>
          </div>
        ) : (
          <div className="code-editor-placeholder">
            <p>파일을 불러오는 중이에요...</p>
          </div>
        )}
      </div>

      {menu && menuTab && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={menuSections}
          ariaLabel="편집기 탭 메뉴"
          onSelect={handleTabMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
