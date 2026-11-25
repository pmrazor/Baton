import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, toFsError, type FsError } from "../../api";
import { fileName, joinPath } from "./codeHelpers";
import {
  activateTab,
  clearJump,
  closeTab,
  getRootEditorView,
  onTabClosed,
  onTabRenamed,
  registerRoot,
  setTabState,
  useEditorRoot,
} from "./editorStore";
import type * as CmEngineModule from "./cmEngine";
import "./code.css";

export interface CodeEditorProps {
  root: string;
}

type CmEngine = typeof CmEngineModule;

type TabLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "unsupported"; error: FsError }
  | { status: "error"; error: FsError };

interface TabRuntime {
  load: TabLoadState;
  saving: boolean;
  /** Disk mtime that the user chose to ignore while dirty. */
  ignoredMtime: number | null;
  /** Latest disk mtime seen by the poller while dirty. */
  latestDiskMtime: number | null;
}

const POLL_INTERVAL_MS = 2000;

let enginePromise: Promise<CmEngine> | null = null;
function loadEngine(): Promise<CmEngine> {
  enginePromise ??= import("./cmEngine");
  return enginePromise;
}

function keyOf(root: string, path: string): string {
  return `${root}\0${path}`;
}

const runtimes = new Map<string, TabRuntime>();
const inflightLoads = new Set<string>();

onTabClosed((root, path) => {
  const k = keyOf(root, path);
  runtimes.delete(k);
  inflightLoads.delete(k);
});

onTabRenamed((root, from, to) => {
  const oldKey = keyOf(root, from);
  const newKey = keyOf(root, to);
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
    rt = { load: { status: "loading" }, saving: false, ignoredMtime: null, latestDiskMtime: null };
    runtimes.set(key, rt);
  }
  return rt;
}

export default function CodeEditor({ root }: CodeEditorProps) {
  const { tabs, active, jump } = useEditorRoot(root);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const stripRef = useRef<HTMLDivElement>(null);
  const cmHostRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<CmEngineModule.EditorView | null>(null);
  const engineRef = useRef<CmEngine | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const activeTab = active ? (tabs.find((t) => t.path === active) ?? null) : null;
  const activeKey = active ? keyOf(root, active) : null;
  const activeRuntime = activeKey ? runtimes.get(activeKey) : undefined;

  useEffect(() => {
    registerRoot(root);
  }, [root]);

  // Keep the active tab scrolled into view.
  useEffect(() => {
    stripRef.current
      ?.querySelector(".code-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const reloadTabFromDisk = useCallback(
    async (tabRoot: string, tabPath: string) => {
      const k = keyOf(tabRoot, tabPath);
      const rt = getRuntime(k);
      try {
        const [content, engine] = await Promise.all([api.fsRead(tabRoot, tabPath), loadEngine()]);
        engineRef.current = engine;
        // Tab might have been closed while reading.
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.path === tabPath)) return;
        const existing = engine.getSession(k);
        if (existing) {
          engine.reloadSessionText(k, content.text, cmViewRef.current);
        } else {
          engine.ensureTabSession(k, tabPath, content.text, cmViewRef.current);
        }
        rt.load = { status: "ready" };
        rt.ignoredMtime = null;
        rt.latestDiskMtime = content.mtime;
        setTabState(tabRoot, tabPath, {
          mtime: content.mtime,
          dirty: false,
          deleted: false,
          diskChanged: false,
        });
      } catch (err) {
        if (!getRootEditorView(tabRoot).tabs.some((t) => t.path === tabPath)) return;
        const fsErr = toFsError(err);
        if (fsErr.kind === "too_large" || fsErr.kind === "binary") {
          rt.load = { status: "unsupported", error: fsErr };
        } else if (fsErr.kind === "not_found") {
          setTabState(tabRoot, tabPath, { deleted: true, diskChanged: false });
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

  const saveTab = useCallback(
    async (tabRoot: string, tabPath: string) => {
      const k = keyOf(tabRoot, tabPath);
      const rt = runtimes.get(k);
      const engine = engineRef.current;
      if (!rt || rt.load.status !== "ready" || rt.saving || !engine) return;
      const text = engine.getSessionText(k, cmViewRef.current);
      if (text === null) return;
      const currentTab = getRootEditorView(tabRoot).tabs.find((t) => t.path === tabPath);
      if (!currentTab) return;

      rt.saving = true;
      try {
        const newMtime = await api.fsWrite(tabRoot, tabPath, text, currentTab.mtime);
        engine.markSessionSaved(k, cmViewRef.current);
        rt.ignoredMtime = null;
        rt.latestDiskMtime = newMtime;
        setTabState(tabRoot, tabPath, {
          mtime: newMtime,
          dirty: false,
          deleted: false,
          diskChanged: false,
        });
      } catch (err) {
        const fsErr = toFsError(err);
        if (fsErr.kind === "conflict") {
          const overwrite = await ask(
            `'${fileName(tabPath)}' 파일이 디스크에서 바뀌었어요. 지금 내용으로 덮어쓸까요, 아니면 디스크에서 다시 불러올까요?`,
            {
              title: "파일 충돌",
              kind: "warning",
              okLabel: "덮어쓰기",
              cancelLabel: "다시 불러오기",
            },
          );
          if (overwrite) {
            try {
              const forcedMtime = await api.fsWrite(tabRoot, tabPath, text, null);
              engine.markSessionSaved(k, cmViewRef.current);
              rt.ignoredMtime = null;
              rt.latestDiskMtime = forcedMtime;
              setTabState(tabRoot, tabPath, {
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
            await reloadTabFromDisk(tabRoot, tabPath);
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
    [reloadTabFromDisk, rerender],
  );

  const callbacksRef = useRef<CmEngineModule.EngineCallbacks>({
    onDirtyChange: () => undefined,
    onSave: () => undefined,
  });

  callbacksRef.current = {
    onDirtyChange: (k, dirty) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      const tabRoot = k.slice(0, sepIdx);
      const tabPath = k.slice(sepIdx + 1);
      setTabState(tabRoot, tabPath, { dirty });
    },
    onSave: (k) => {
      const sepIdx = k.indexOf("\0");
      if (sepIdx < 0) return;
      const tabRoot = k.slice(0, sepIdx);
      const tabPath = k.slice(sepIdx + 1);
      void saveTab(tabRoot, tabPath);
    },
  };

  // Load active tab on demand.
  useEffect(() => {
    if (!active || !activeKey) return;
    const rt = runtimes.get(activeKey);
    if (rt && rt.load.status !== "loading") return;
    if (inflightLoads.has(activeKey)) return;

    getRuntime(activeKey).load = { status: "loading" };
    inflightLoads.add(activeKey);
    rerender();

    void (async () => {
      try {
        await reloadTabFromDisk(root, active);
      } finally {
        inflightLoads.delete(activeKey);
      }
    })();
  }, [root, active, activeKey, reloadTabFromDisk, rerender]);

  // Mount or switch CodeMirror when the active tab is ready.
  const isReady = activeRuntime?.load.status === "ready";
  useEffect(() => {
    if (!isReady || !active || !activeKey) {
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
  }, [root, active, activeKey, isReady]);

  // Handle jump-to-line requests on an already-mounted tab.
  useEffect(() => {
    if (!jump || !isReady || jump.path !== active) return;
    const view = cmViewRef.current;
    const engine = engineRef.current;
    if (!view || !engine || activeKeyRef.current !== activeKey) return;
    engine.jumpToLine(view, jump.line);
    clearJump(root, jump.seq);
  }, [root, active, activeKey, isReady, jump]);

  // Destroy the EditorView cleanly on unmount while keeping tab sessions cached.
  useEffect(() => {
    return () => {
      if (cmViewRef.current) {
        engineRef.current?.saveViewSnapshot(cmViewRef.current);
        engineRef.current?.releaseView(cmViewRef.current);
        cmViewRef.current.destroy();
        cmViewRef.current = null;
        activeKeyRef.current = null;
      }
    };
  }, []);

  // Poll `fs_stat` every 2s and on window focus to pick up agent or external edits.
  useEffect(() => {
    if (tabs.length === 0) return;
    let polling = false;
    let disposed = false;

    const poll = async () => {
      if (polling || disposed) return;
      const snapshot = getRootEditorView(root);
      if (snapshot.tabs.length === 0) return;
      const paths = snapshot.tabs.map((t) => t.path);
      polling = true;
      try {
        const mtimes = await api.fsStat(root, paths);
        if (disposed) return;
        const latestTabs = getRootEditorView(root).tabs;
        for (let i = 0; i < paths.length; i++) {
          const path = paths[i];
          const diskMtime = mtimes[i] ?? null;
          const tab = latestTabs.find((t) => t.path === path);
          if (!tab) continue;
          const k = keyOf(root, path);
          const rt = runtimes.get(k);
          if (!rt || rt.saving || inflightLoads.has(k)) continue;

          if (diskMtime === null) {
            if (!tab.deleted) {
              setTabState(root, path, { deleted: true, diskChanged: false });
            }
            continue;
          }

          if (tab.deleted) {
            setTabState(root, path, { deleted: false });
          }

          if (tab.mtime !== null && diskMtime !== tab.mtime) {
            if (!tab.dirty) {
              void reloadTabFromDisk(root, path);
            } else if (rt.ignoredMtime !== diskMtime) {
              rt.latestDiskMtime = diskMtime;
              if (!tab.diskChanged) {
                setTabState(root, path, { diskChanged: true });
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
  }, [root, tabs.length, reloadTabFromDisk]);

  const handleCloseTab = async (path: string) => {
    const tab = getRootEditorView(root).tabs.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask(`'${fileName(path)}'의 저장하지 않은 변경 사항을 버릴까요?`, {
        title: "저장하지 않은 변경 사항",
        kind: "warning",
      });
      if (!ok) return;
    }
    closeTab(root, path);
  };

  const handleOpenDefault = (path: string) => {
    void api.openAttachment(joinPath(root, path));
  };

  const handleIgnoreDiskChange = (path: string) => {
    const k = keyOf(root, path);
    const rt = runtimes.get(k);
    if (rt && rt.latestDiskMtime !== null) {
      rt.ignoredMtime = rt.latestDiskMtime;
    }
    setTabState(root, path, { diskChanged: false });
  };

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "s") {
      if (active) {
        ev.preventDefault();
        void saveTab(root, active);
      }
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
          const isActive = tab.path === active;
          const label = fileName(tab.path);
          return (
            <div
              key={tab.path}
              className={`code-tab${isActive ? " active" : ""}${tab.deleted ? " deleted" : ""}`}
              title={tab.path}
              onMouseDown={(ev) => ev.button === 1 && ev.preventDefault()}
              onAuxClick={(ev) => ev.button === 1 && void handleCloseTab(tab.path)}
            >
              <button
                type="button"
                className="code-tab-label"
                role="tab"
                aria-selected={isActive}
                onClick={() => activateTab(root, tab.path)}
              >
                <span className="code-tab-name">{label}</span>
                {tab.deleted && <span className="code-tab-deleted">(삭제됨)</span>}
                {tab.dirty && <span className="code-tab-dirty" aria-label="저장되지 않음" />}
              </button>
              <button
                type="button"
                className="code-tab-close"
                title="닫기"
                aria-label={`${label} 닫기`}
                onClick={() => void handleCloseTab(tab.path)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab?.diskChanged && (
        <div className="code-disk-bar" role="status">
          <span>디스크에서 바뀌었어요</span>
          <div className="code-disk-bar-actions">
            <button
              type="button"
              className="code-bar-btn primary"
              onClick={() => void reloadTabFromDisk(root, activeTab.path)}
            >
              다시 불러오기
            </button>
            <button
              type="button"
              className="code-bar-btn"
              onClick={() => handleIgnoreDiskChange(activeTab.path)}
            >
              무시
            </button>
          </div>
        </div>
      )}

      <div className="code-editor-body">
        {activeTab && activeRuntime?.load.status === "ready" ? (
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
              onClick={() => void reloadTabFromDisk(root, activeTab.path)}
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
    </div>
  );
}
