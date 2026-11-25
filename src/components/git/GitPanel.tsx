import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react";
import {
  api,
  toFsError,
  type GitBranch as GitBranchInfo,
  type GitCommit,
  type GitCommitFile,
  type GitStatus,
} from "../../api";
import { attachToComposer } from "../../composerBus";
import ContextMenu, { type ContextMenuSection } from "../ContextMenu";
import { joinPath } from "../code/codeHelpers";
import { handleDeletedPath, openFile } from "../code/editorStore";
import { layoutCommitGraph, type GraphRow } from "./gitGraph";
import {
  GIT_GROUPS,
  GIT_SPLIT_DEFAULT,
  GIT_SPLITTER_PX,
  LETTER_TITLE,
  aheadBehindLabel,
  commitFileLetter,
  commitPlan,
  discardMessage,
  dragSplitFraction,
  groupStatus,
  letterTone,
  localNameForRemote,
  parseCommitRefs,
  parseSplitFraction,
  pathInFolder,
  relativeTime,
  resolvePaneLayout,
  splitPath,
  stagePaths,
  unstagePaths,
  type GitGroupId,
  type GitRow,
} from "./gitHelpers";
import "./git.css";

const POLL_MS = 3000;
const LOG_PAGE_SIZE = 200;
const GRAPH_ROW_HEIGHT = 24;
const GRAPH_LANE_WIDTH = 14;
const GRAPH_LANE_PAD = 8;
const SPLIT_STORAGE_KEY = "baton.gitPaneSplit";

function readSplitFraction(): number {
  try {
    return parseSplitFraction(window.localStorage.getItem(SPLIT_STORAGE_KEY));
  } catch {
    return GIT_SPLIT_DEFAULT;
  }
}

function writeSplitFraction(fraction: number): void {
  try {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(fraction));
  } catch {
    // Ignore storage access errors.
  }
}

/** Commit message drafts per folder, kept while the panel is closed. */
const drafts = new Map<string, string>();

type SyncOp = "fetch" | "pull" | "push";
type CommitMode = "commit" | "stageAll" | "push" | "sync" | "amend";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** The ▾ menu next to 커밋. */
function commitMenuSections(hasChanges: boolean, hasUnstaged: boolean, hasCommits: boolean): ContextMenuSection<CommitMode>[] {
  return [
    {
      id: "commit",
      items: [
        { id: "commit", label: "커밋", shortcut: isMac ? "⌘Enter" : "Ctrl+Enter", disabled: !hasChanges },
        { id: "stageAll", label: "모두 스테이징하고 커밋", disabled: !hasUnstaged },
      ],
    },
    {
      id: "remote",
      items: [
        { id: "push", label: "커밋하고 올리기", disabled: !hasChanges },
        { id: "sync", label: "커밋하고 동기화 (끌어오기 후 올리기)", disabled: !hasChanges },
      ],
    },
    { id: "amend", items: [{ id: "amend", label: "마지막 커밋 수정 (amend)", disabled: !hasCommits }] },
  ];
}

const SYNC_DONE: Record<SyncOp, string> = {
  fetch: "원격 저장소에서 가져왔어요.",
  pull: "끌어왔어요.",
  push: "올렸어요.",
};

type RowMenuId = "diff" | "stage" | "unstage" | "discard" | "open" | "copyPath" | "attach";
type CommitRowMenuId = "copyHash" | "copyMessage" | "branchAt";

interface RowMenuState {
  x: number;
  y: number;
  row: GitRow;
}

interface CommitRowMenuState {
  x: number;
  y: number;
  commit: GitCommit;
}

interface CommitFilesState {
  loading: boolean;
  files?: GitCommitFile[];
  error?: string;
}

const COMMIT_ROW_MENU_SECTIONS: ContextMenuSection<CommitRowMenuId>[] = [
  {
    id: "copy",
    items: [
      { id: "copyHash", label: "해시 복사" },
      { id: "copyMessage", label: "메시지 복사" },
    ],
  },
  {
    id: "branch",
    items: [{ id: "branchAt", label: "이 커밋에서 브랜치 만들기…" }],
  },
];

export interface GitPanelProps {
  /** The chat's folder: a repository, a folder inside one, or a plain folder. */
  root: string;
  /** Show the changes of `path` (relative to `root`, `/`-separated): staged (index vs HEAD) or not (worktree vs index). */
  onOpenDiff: (path: string, staged: boolean) => void;
  /** Show the changes of `path` (repository-relative) in commit `hash`. */
  onOpenCommitDiff: (hash: string, path: string, origPath?: string) => void;
}

function errorText(e: unknown): string {
  return toFsError(e).message;
}

export default function GitPanel({ root, onOpenDiff, onOpenCommitDiff }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sync, setSync] = useState<SyncOp | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessageState] = useState(() => drafts.get(root) ?? "");
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<GitGroupId>>(() => new Set());
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [branchMenu, setBranchMenu] = useState(false);

  // Split pane state (변경 사항 / 커밋 기록).
  const [changesOpen, setChangesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [splitFraction, setSplitFraction] = useState<number>(readSplitFraction);
  const [panesHeight, setPanesHeight] = useState(0);
  const panesRef = useRef<HTMLDivElement>(null);

  // Commit history state.
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [expandedCommits, setExpandedCommits] = useState<ReadonlySet<string>>(() => new Set());
  const [commitFiles, setCommitFiles] = useState<Record<string, CommitFilesState>>({});
  const [commitRowMenu, setCommitRowMenu] = useState<CommitRowMenuState | null>(null);
  const [branchAtTarget, setBranchAtTarget] = useState<{ hash: string; short: string } | null>(null);
  const [branchAtName, setBranchAtName] = useState("");

  const seq = useRef(0);
  const inFlight = useRef(false);
  const logSeq = useRef(0);
  const lastStampRef = useRef<string | null>(null);
  const lastStatusSigRef = useRef<string | null>(null);
  const historyLoadedRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const commitsLenRef = useRef(0);
  commitsLenRef.current = commits.length;

  const setMessage = useCallback(
    (text: string) => {
      setMessageState(text);
      if (text) drafts.set(root, text);
      else drafts.delete(root);
    },
    [root],
  );

  const loadHistory = useCallback(
    async (mode: "reset" | "more" = "reset") => {
      if (mode === "more") {
        if (loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        const id = logSeq.current;
        try {
          const next = await api.gitLog(root, commitsLenRef.current, LOG_PAGE_SIZE);
          if (id !== logSeq.current) return;
          setCommits((cur) => {
            const seen = new Set(cur.map((c) => c.hash));
            const fresh = next.filter((c) => !seen.has(c.hash));
            return fresh.length ? [...cur, ...fresh] : cur;
          });
          setHasMore(next.length >= LOG_PAGE_SIZE);
          setHistoryError(null);
        } catch (e) {
          if (id !== logSeq.current) return;
          setHistoryError(errorText(e));
        } finally {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
        return;
      }

      const id = ++logSeq.current;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setHistoryLoading(true);
      try {
        const [next, stamp] = await Promise.all([
          api.gitLog(root, 0, LOG_PAGE_SIZE),
          api.gitRefsStamp(root).catch(() => ""),
        ]);
        if (id !== logSeq.current) return;
        setCommits(next);
        setHasMore(next.length >= LOG_PAGE_SIZE);
        setHistoryError(null);
        lastStampRef.current = stamp;
        historyLoadedRef.current = true;
      } catch (e) {
        if (id !== logSeq.current) return;
        setHistoryError(errorText(e));
      } finally {
        if (id === logSeq.current) {
          setHistoryLoading(false);
        }
      }
    },
    [root],
  );

  const refresh = useCallback(
    async (manual = false) => {
      // A poll never stacks on a slow one; a manual refresh or an action always reads again.
      if (inFlight.current && !manual) return;
      const id = ++seq.current;
      inFlight.current = true;
      if (manual) setLoading(true);
      try {
        const next = await api.gitStatus(root);
        if (id !== seq.current) return;
        setStatus(next);
        setLoadError(null);
        if (next.repo) {
          const sig = `${next.head}|${next.branch}|${next.ahead}|${next.behind}|${next.hasCommits}`;
          const changed = lastStatusSigRef.current !== null && lastStatusSigRef.current !== sig;
          lastStatusSigRef.current = sig;
          if (manual || !historyLoadedRef.current || changed) {
            void loadHistory("reset");
          }
        } else {
          lastStatusSigRef.current = null;
          lastStampRef.current = null;
          historyLoadedRef.current = false;
          setCommits([]);
          setHasMore(false);
        }
      } catch (e) {
        if (id !== seq.current) return;
        setLoadError(errorText(e));
      } finally {
        if (id === seq.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [root, loadHistory],
  );

  // Poll status while the panel is shown, and check refs on window focus (never polling `git log`).
  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onFocus = () => {
      void refresh();
      if (!historyLoadedRef.current) return;
      void api
        .gitRefsStamp(root)
        .then((stamp) => {
          if (lastStampRef.current !== null && stamp !== lastStampRef.current) {
            void loadHistory("reset");
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      seq.current++;
      logSeq.current++;
      inFlight.current = false;
    };
  }, [root, refresh, loadHistory]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const isRepo = Boolean(status?.repo);
  useEffect(() => {
    if (!isRepo) return;
    const el = panesRef.current;
    if (!el) return;
    const update = () => setPanesHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isRepo]);

  const handleSplitChange = useCallback((next: number) => {
    setSplitFraction(next);
    writeSplitFraction(next);
  }, []);

  const groups = useMemo(() => groupStatus(status?.files ?? []), [status]);
  const graphRows = useMemo(() => layoutCommitGraph(commits), [commits]);
  const remotePrefixes = useMemo(() => {
    const set = new Set<string>(["origin"]);
    const up = status?.upstream;
    if (up) {
      const slash = up.indexOf("/");
      if (slash > 0) set.add(up.slice(0, slash));
    }
    return [...set];
  }, [status?.upstream]);
  const prefix = status?.prefix ?? "";
  const repoRoot = status?.repoRoot || root;
  const busy = working || sync !== null;

  /** Run a git action, show its error, and re-read the status afterwards. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setOpError(null);
      setWorking(true);
      try {
        await fn();
        if (done) setNotice(done);
        return true;
      } catch (e) {
        setOpError(errorText(e));
        return false;
      } finally {
        setWorking(false);
        void refresh(true);
      }
    },
    [refresh],
  );

  const runSync = async (op: SyncOp) => {
    if (busy) return;
    setOpError(null);
    setSync(op);
    try {
      if (op === "fetch") await api.gitFetch(root);
      else if (op === "pull") await api.gitPull(root);
      else await api.gitPush(root);
      setNotice(SYNC_DONE[op]);
    } catch (e) {
      setOpError(errorText(e));
    } finally {
      setSync(null);
      void refresh(true);
    }
  };

  const stage = (rows: readonly GitRow[]) => {
    const paths = stagePaths(rows);
    if (paths.length) void act(() => api.gitStage(root, paths));
  };

  const unstage = (rows: readonly GitRow[]) => {
    const paths = unstagePaths(rows);
    if (paths.length) void act(() => api.gitUnstage(root, paths));
  };

  const discard = async (rows: readonly GitRow[]) => {
    if (!rows.length || busy) return;
    const confirmed = await ask(discardMessage(rows), {
      title: "변경 되돌리기",
      kind: "warning",
      okLabel: "되돌리기",
      cancelLabel: "취소",
    });
    if (!confirmed) return;
    const paths = stagePaths(rows);
    const ok = await act(() => api.gitDiscard(root, paths));
    if (!ok) return;
    // Trashed files: close their editor tabs like the file tree does.
    for (const row of rows) {
      const rel = row.file.untracked ? pathInFolder(row.file.path, prefix) : null;
      if (rel) handleDeletedPath(root, rel);
    }
  };

  /**
   * The 커밋 button commits what is staged; its ▾ menu adds the variants:
   * stage everything first, amend the last commit, or push / sync afterwards.
   */
  const commit = async (mode: CommitMode = "commit") => {
    if (busy) return;
    const amend = mode === "amend";
    if (!message.trim()) {
      setOpError("커밋 메시지를 입력해 주세요.");
      return;
    }
    if (groups.conflicts.length > 0) {
      setOpError("충돌이 남아 있어요. 충돌을 해결하고 스테이징한 뒤 커밋해 주세요.");
      return;
    }
    const stageAll = mode === "stageAll" && groups.changed.length > 0;
    const plan = stageAll ? "stageAll" : commitPlan(groups, amend);
    if (plan === "nothing") {
      setOpError("커밋할 변경 사항이 없어요.");
      return;
    }
    if (plan === "askStageAll") {
      const confirmed = await ask("스테이징된 변경이 없어요. 모두 스테이징하고 커밋할까요?", {
        title: "커밋",
        kind: "info",
        okLabel: "모두 스테이징하고 커밋",
        cancelLabel: "취소",
      });
      if (!confirmed) return;
    }
    const text = message;
    let hash = "";
    const ok = await act(async () => {
      if (plan === "askStageAll" || plan === "stageAll") await api.gitStage(root, stagePaths(groups.changed));
      hash = await api.gitCommit(root, text, amend);
    });
    if (!ok) return;
    setMessage("");
    setNotice(amend ? `마지막 커밋을 수정했어요 (${hash})` : `커밋했어요 (${hash})`);
    if (mode === "push") await runSync("push");
    if (mode === "sync") {
      await runSync("pull");
      await runSync("push");
    }
  };


  const onMessageKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void commit();
    }
  };

  const openDiff = (row: GitRow) => {
    const rel = pathInFolder(row.file.path, prefix);
    if (rel !== null) onOpenDiff(rel, row.group === "staged");
  };

  const toggleGroup = (id: GitGroupId) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openRowMenu = (e: MouseEvent, row: GitRow) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, row });
  };

  const menuSections = useMemo((): ContextMenuSection<RowMenuId>[] => {
    if (!menu) return [];
    const { row } = menu;
    const inFolder = pathInFolder(row.file.path, prefix) !== null;
    const deleted = row.letter === "D";
    return [
      {
        id: "change",
        items: [
          { id: "diff", label: "변경 보기", disabled: !inFolder },
          row.group === "staged"
            ? { id: "unstage", label: "스테이징 취소" }
            : { id: "stage", label: row.group === "conflicts" ? "스테이징 (해결됨으로 표시)" : "스테이징" },
          { id: "discard", label: "변경 되돌리기", danger: true, disabled: row.group !== "changed" },
        ],
      },
      {
        id: "file",
        items: [
          { id: "open", label: "파일 열기", disabled: !inFolder || (deleted && row.group === "changed") },
          { id: "copyPath", label: "경로 복사" },
          { id: "attach", label: "채팅에 첨부", disabled: deleted && row.group === "changed" },
        ],
      },
    ];
  }, [menu, prefix]);

  const onMenuSelect = (id: RowMenuId) => {
    if (!menu) return;
    const { row } = menu;
    const abs = joinPath(repoRoot, row.file.path);
    switch (id) {
      case "diff":
        openDiff(row);
        break;
      case "stage":
        stage([row]);
        break;
      case "unstage":
        unstage([row]);
        break;
      case "discard":
        void discard([row]);
        break;
      case "open": {
        const rel = pathInFolder(row.file.path, prefix);
        if (rel !== null) openFile(root, rel);
        break;
      }
      case "copyPath":
        navigator.clipboard
          .writeText(abs)
          .catch((e) => setOpError(`클립보드에 복사하지 못했어요: ${errorText(e)}`));
        break;
      case "attach":
        attachToComposer([abs]);
        break;
    }
  };

  const toggleCommit = (hash: string) => {
    const opening = !expandedCommits.has(hash);
    setExpandedCommits((cur) => {
      const next = new Set(cur);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
    if (!opening) return;
    const existing = commitFiles[hash];
    if (existing && (existing.loading || existing.files)) return;
    setCommitFiles((cur) => ({ ...cur, [hash]: { loading: true } }));
    api
      .gitCommitFiles(root, hash)
      .then((files) => {
        setCommitFiles((cur) => ({ ...cur, [hash]: { loading: false, files } }));
      })
      .catch((e) => {
        setCommitFiles((cur) => ({ ...cur, [hash]: { loading: false, error: errorText(e) } }));
      });
  };

  const onCommitRowMenuSelect = (id: CommitRowMenuId) => {
    if (!commitRowMenu) return;
    const { commit: c } = commitRowMenu;
    switch (id) {
      case "copyHash":
        navigator.clipboard
          .writeText(c.hash)
          .then(() => setNotice(`커밋 해시를 복사했어요 (${c.short})`))
          .catch((e) => setOpError(`클립보드에 복사하지 못했어요: ${errorText(e)}`));
        break;
      case "copyMessage":
        navigator.clipboard
          .writeText(c.subject)
          .then(() => setNotice("커밋 메시지를 복사했어요."))
          .catch((e) => setOpError(`클립보드에 복사하지 못했어요: ${errorText(e)}`));
        break;
      case "branchAt":
        setBranchAtTarget({ hash: c.hash, short: c.short });
        setBranchAtName("");
        break;
    }
  };

  const submitBranchAt = async () => {
    if (!branchAtTarget || busy) return;
    const name = branchAtName.trim();
    if (!name) return;
    const target = branchAtTarget;
    const ok = await act(
      () => api.gitBranchAt(root, name, target.hash),
      `'${name}' 브랜치를 만들었어요 (${target.short}).`,
    );
    if (ok) {
      setBranchAtTarget(null);
      setBranchAtName("");
    }
  };

  const onHistoryScroll = (e: UIEvent<HTMLDivElement>) => {
    if (!historyOpen || !hasMore || loadingMoreRef.current) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) {
      void loadHistory("more");
    }
  };

  if (!status) {
    return (
      <div className="git-panel">
        <div className={`git-status-line${loadError ? " error" : ""}`}>{loadError ?? "불러오는 중..."}</div>
      </div>
    );
  }

  if (!status.repo) {
    return (
      <div className="git-panel">
        {opError && <OpError text={opError} onClose={() => setOpError(null)} />}
        <div className="git-empty">
          <p>이 폴더는 git 저장소가 아니에요</p>
          <button
            type="button"
            className="btn btn-primary git-empty-btn"
            disabled={busy}
            onClick={() => void act(() => api.gitInit(root), "저장소를 만들었어요.")}
          >
            저장소 만들기
          </button>
        </div>
      </div>
    );
  }

  const ab = aheadBehindLabel(status.ahead, status.behind);
  const totalChanges = groups.conflicts.length + groups.staged.length + groups.changed.length;
  const hasChanges = status.files.length > 0;
  const paneLayout = resolvePaneLayout({
    totalHeight: panesHeight,
    fraction: splitFraction,
    topOpen: changesOpen,
    bottomOpen: historyOpen,
  });
  const topPaneStyle = !changesOpen
    ? undefined
    : historyOpen
      ? { flexGrow: paneLayout.fraction, flexShrink: 1, flexBasis: 0 }
      : { flexGrow: 1, flexShrink: 1, flexBasis: 0 };
  const bottomPaneStyle = !historyOpen
    ? undefined
    : changesOpen
      ? { flexGrow: 1 - paneLayout.fraction, flexShrink: 1, flexBasis: 0 }
      : { flexGrow: 1, flexShrink: 1, flexBasis: 0 };

  return (
    <div className="git-panel">
      <div className="git-head">
        <button
          type="button"
          className={`git-branch-btn${branchMenu ? " open" : ""}`}
          title={status.detached ? `분리된 HEAD (${status.branch})` : `브랜치: ${status.branch}`}
          disabled={busy}
          onClick={() => setBranchMenu((o) => !o)}
        >
          <GitBranch size={13} className="git-branch-icon" />
          <span className="git-branch-name">{status.detached ? `${status.branch} (분리됨)` : status.branch}</span>
          <ChevronDown size={12} className="git-branch-chev" />
        </button>
        {ab && (
          <span
            className="git-ab"
            title={`올릴 커밋 ${status.ahead}개, 받을 커밋 ${status.behind}개${
              status.upstream ? ` (${status.upstream})` : ""
            }`}
          >
            {ab}
          </span>
        )}
        <div className="git-head-actions">
          <HeadButton title="새로고침" disabled={loading} spinning={loading} onClick={() => void refresh(true)}>
            <RefreshCw size={13} />
          </HeadButton>
          <HeadButton title="가져오기 (fetch)" disabled={busy} spinning={sync === "fetch"} onClick={() => void runSync("fetch")}>
            <CloudDownload size={13} />
          </HeadButton>
          <HeadButton title="끌어오기 (pull)" disabled={busy} spinning={sync === "pull"} onClick={() => void runSync("pull")}>
            <ArrowDownToLine size={13} />
          </HeadButton>
          <HeadButton
            title={status.upstream ? "올리기 (push)" : "올리기 (push, 원격 브랜치를 만들어요)"}
            disabled={busy}
            spinning={sync === "push"}
            onClick={() => void runSync("push")}
          >
            <ArrowUpFromLine size={13} />
          </HeadButton>
        </div>
      </div>

      {branchMenu && (
        <BranchMenu
          root={root}
          current={status.detached ? null : status.branch}
          onClose={() => setBranchMenu(false)}
          onCheckout={(name, create) => {
            setBranchMenu(false);
            void act(
              () => api.gitCheckout(root, name, create),
              create ? `'${name}' 브랜치를 만들었어요.` : `'${name}' 브랜치로 바꿨어요.`,
            );
          }}
        />
      )}

      {opError && <OpError text={opError} onClose={() => setOpError(null)} />}
      {notice && !opError && <div className="git-notice">{notice}</div>}

      <div className="git-commit">
        <textarea
          className="git-commit-input"
          placeholder="커밋 메시지 (⌘Enter로 커밋)"
          aria-label="커밋 메시지"
          rows={2}
          value={message}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onMessageKeyDown}
        />
        <div className="git-commit-split">
          <button
            type="button"
            className="btn btn-primary git-commit-btn"
            disabled={busy || !hasChanges}
            onClick={() => void commit()}
          >
            {working ? <Loader2 size={13} className="git-spin" /> : <Check size={13} />}
            커밋
          </button>
          <button
            type="button"
            className="btn btn-primary git-commit-more"
            title="커밋 옵션"
            aria-label="커밋 옵션"
            disabled={busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setCommitMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <ChevronDown size={14} />
          </button>
        </div>
        {commitMenu && (
          <ContextMenu
            x={commitMenu.x}
            y={commitMenu.y}
            sections={commitMenuSections(hasChanges, groups.changed.length > 0, status.hasCommits)}
            ariaLabel="커밋 옵션"
            onSelect={(mode) => {
              setCommitMenu(null);
              void commit(mode);
            }}
            onClose={() => setCommitMenu(null)}
          />
        )}
      </div>

      <div ref={panesRef} className="git-panes">
        <section className={`git-pane${changesOpen ? "" : " collapsed"}`} style={topPaneStyle}>
          <div className="git-pane-head">
            <button
              type="button"
              className="git-pane-toggle"
              aria-expanded={changesOpen}
              onClick={() => setChangesOpen((o) => !o)}
            >
              <span className="git-chev">{changesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              <span className="git-pane-label">변경 사항</span>
            </button>
            {totalChanges > 0 && <span className="git-count">{totalChanges}</span>}
          </div>

          {changesOpen && (
            <div className="git-pane-body git-changes-body">
              {!hasChanges ? (
                <div className="git-status-line">변경 사항이 없어요</div>
              ) : (
                GIT_GROUPS.map(({ id, label }) => {
                  const rows = groups[id];
                  if (!rows.length) return null;
                  const open = !collapsed.has(id);
                  return (
                    <section key={id} className="git-group">
                      <div className="git-group-head">
                        <button
                          type="button"
                          className="git-group-toggle"
                          aria-expanded={open}
                          onClick={() => toggleGroup(id)}
                        >
                          <span className="git-chev">
                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </span>
                          <span className="git-group-label">{label}</span>
                        </button>
                        <div className="git-row-actions">
                          {id === "changed" && (
                            <RowAction title="모두 되돌리기" disabled={busy} onClick={() => void discard(rows)}>
                              <Undo2 size={13} />
                            </RowAction>
                          )}
                          {id === "staged" ? (
                            <RowAction title="모두 스테이징 취소" disabled={busy} onClick={() => unstage(rows)}>
                              <Minus size={13} />
                            </RowAction>
                          ) : (
                            <RowAction title="모두 스테이징" disabled={busy} onClick={() => stage(rows)}>
                              <Plus size={13} />
                            </RowAction>
                          )}
                        </div>
                        <span className="git-count">{rows.length}</span>
                      </div>
                      {open &&
                        rows.map((row) => (
                          <FileRow
                            key={row.key}
                            row={row}
                            busy={busy}
                            inFolder={pathInFolder(row.file.path, prefix) !== null}
                            onOpen={() => openDiff(row)}
                            onMenu={(e) => openRowMenu(e, row)}
                            onStage={() => stage([row])}
                            onUnstage={() => unstage([row])}
                            onDiscard={() => void discard([row])}
                          />
                        ))}
                    </section>
                  );
                })
              )}
            </div>
          )}
        </section>

        {paneLayout.splitterVisible && (
          <PaneSplitter
            label="변경 사항과 커밋 기록 높이 조절"
            fraction={paneLayout.fraction}
            getAvailableHeight={() => Math.max(0, (panesRef.current?.clientHeight ?? panesHeight) - GIT_SPLITTER_PX)}
            onFraction={handleSplitChange}
          />
        )}

        <section className={`git-pane${historyOpen ? "" : " collapsed"}`} style={bottomPaneStyle}>
          <div className="git-pane-head">
            <button
              type="button"
              className="git-pane-toggle"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <span className="git-chev">{historyOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              <span className="git-pane-label">커밋 기록</span>
            </button>
            {historyLoading && commits.length === 0 && <Loader2 size={12} className="git-spin git-history-spinner" />}
            {commits.length > 0 && <span className="git-count">{hasMore ? `${commits.length}+` : commits.length}</span>}
          </div>

          {historyOpen && (
            <div className="git-pane-body git-history-body" onScroll={onHistoryScroll}>
              <div className="git-history-list">
                {historyError && <div className="git-status-line error">{historyError}</div>}
                {!historyError && !historyLoading && commits.length === 0 && (
                  <div className="git-status-line">아직 커밋이 없어요</div>
                )}
                {commits.map((c, idx) => {
                  const graph = graphRows[idx];
                  const expanded = expandedCommits.has(c.hash);
                  const filesState = commitFiles[c.hash];
                  const isBranchTarget = branchAtTarget?.hash === c.hash;
                  return (
                    <div key={c.hash} className="git-commit-entry">
                      <CommitRow
                        commit={c}
                        graph={graph}
                        expanded={expanded}
                        remotePrefixes={remotePrefixes}
                        onToggle={() => toggleCommit(c.hash)}
                        onMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCommitRowMenu({ x: e.clientX, y: e.clientY, commit: c });
                        }}
                      />
                      {isBranchTarget && (
                        <div className="git-branch-at-row">
                          <CommitGraphContinuation graph={graph} />
                          <input
                            className="git-branch-input git-branch-at-input"
                            autoFocus
                            placeholder={`${c.short}에서 새 브랜치 이름 (Enter)`}
                            value={branchAtName}
                            spellCheck={false}
                            disabled={busy}
                            onChange={(e) => setBranchAtName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                void submitBranchAt();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setBranchAtTarget(null);
                                setBranchAtName("");
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="git-row-btn"
                            title="취소"
                            aria-label="취소"
                            onClick={() => {
                              setBranchAtTarget(null);
                              setBranchAtName("");
                            }}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      )}
                      {expanded && (
                        <div className="git-commit-files">
                          <CommitGraphContinuation graph={graph} />
                          <div className="git-commit-files-body">
                            {filesState?.loading && <div className="git-commit-files-note">불러오는 중...</div>}
                            {filesState?.error && (
                              <div className="git-commit-files-note error">{filesState.error}</div>
                            )}
                            {filesState?.files && filesState.files.length === 0 && (
                              <div className="git-commit-files-note">변경된 파일이 없어요</div>
                            )}
                            {filesState?.files?.map((f) => (
                              <CommitFileRow
                                key={`${f.status}:${f.path}`}
                                file={f}
                                onOpen={() => onOpenCommitDiff(c.hash, f.path, f.origPath)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {hasMore && (
                  <div className="git-history-more">
                    <button
                      type="button"
                      className="git-history-more-btn"
                      disabled={loadingMore}
                      onClick={() => void loadHistory("more")}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 size={12} className="git-spin" />
                          불러오는 중...
                        </>
                      ) : (
                        "더 보기"
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={menuSections}
          ariaLabel="변경 파일 메뉴"
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}

      {commitRowMenu && (
        <ContextMenu
          x={commitRowMenu.x}
          y={commitRowMenu.y}
          sections={COMMIT_ROW_MENU_SECTIONS}
          ariaLabel="커밋 메뉴"
          onSelect={onCommitRowMenuSelect}
          onClose={() => setCommitRowMenu(null)}
        />
      )}
    </div>
  );
}

function PaneSplitter(p: {
  label: string;
  fraction: number;
  getAvailableHeight: () => number;
  onFraction: (fraction: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startFraction: number; availableHeight: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      startY: e.clientY,
      startFraction: p.fraction,
      availableHeight: p.getAvailableHeight(),
    };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.startY;
    p.onFraction(dragSplitFraction(drag.current.startFraction, dy, drag.current.availableHeight));
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      className={`git-pane-splitter${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label={p.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p.fraction * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 16 : -16;
        p.onFraction(dragSplitFraction(p.fraction, step, p.getAvailableHeight()));
      }}
    />
  );
}

function OpError({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="git-op-error" role="alert">
      <span>{text}</span>
      <button type="button" className="git-op-error-close" aria-label="오류 닫기" onClick={onClose}>
        <X size={12} />
      </button>
    </div>
  );
}

function HeadButton(p: {
  title: string;
  disabled?: boolean;
  spinning?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="git-head-btn"
      title={p.title}
      aria-label={p.title}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.spinning ? <Loader2 size={13} className="git-spin" /> : p.children}
    </button>
  );
}

function RowAction(p: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="git-row-btn"
      title={p.title}
      aria-label={p.title}
      disabled={p.disabled}
      onClick={(e) => {
        e.stopPropagation();
        p.onClick();
      }}
    >
      {p.children}
    </button>
  );
}

function FileRow(p: {
  row: GitRow;
  busy: boolean;
  inFolder: boolean;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  const { row } = p;
  const { name, dir } = splitPath(row.file.path);
  const title = row.file.origPath
    ? `${row.file.origPath} → ${row.file.path} · ${LETTER_TITLE[row.letter]}`
    : `${row.file.path} · ${LETTER_TITLE[row.letter]}`;
  return (
    <div
      className={`git-row${p.inFolder ? "" : " outside"}`}
      role="button"
      tabIndex={0}
      title={title}
      onClick={p.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) p.onOpen();
      }}
      onContextMenu={p.onMenu}
    >
      <span className={`git-name tone-${letterTone(row.letter)}${row.letter === "D" ? " deleted" : ""}`}>{name}</span>
      <span className="git-dir">{dir}</span>
      <span className="git-row-actions">
        {row.group === "changed" && (
          <RowAction title="변경 되돌리기" disabled={p.busy} onClick={p.onDiscard}>
            <Undo2 size={13} />
          </RowAction>
        )}
        {row.group === "staged" ? (
          <RowAction title="스테이징 취소" disabled={p.busy} onClick={p.onUnstage}>
            <Minus size={13} />
          </RowAction>
        ) : (
          <RowAction
            title={row.group === "conflicts" ? "스테이징 (해결됨으로 표시)" : "스테이징"}
            disabled={p.busy}
            onClick={p.onStage}
          >
            <Plus size={13} />
          </RowAction>
        )}
      </span>
      <span className={`git-letter tone-${letterTone(row.letter)}`} aria-label={LETTER_TITLE[row.letter]}>
        {row.letter}
      </span>
    </div>
  );
}

function laneX(lane: number): number {
  return GRAPH_LANE_PAD + lane * GRAPH_LANE_WIDTH;
}

function laneColor(color: number): string {
  return `var(--git-lane-${color % 8})`;
}

function graphSvgWidth(cols: number): number {
  return GRAPH_LANE_PAD * 2 + Math.max(cols - 1, 0) * GRAPH_LANE_WIDTH;
}

function CommitGraphCell(p: { graph: GraphRow; isMerge: boolean; isHead: boolean }) {
  const { graph, isMerge, isHead } = p;
  const width = graphSvgWidth(graph.width);
  const h = GRAPH_ROW_HEIGHT;
  const mid = h / 2;
  const cx = laneX(graph.lane);
  const dotColor = laneColor(graph.color);

  return (
    <svg className="git-graph-svg" width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
      {graph.lines.map((line, i) => {
        const x1 = laneX(line.fromLane);
        const x2 = laneX(line.toLane);
        const stroke = laneColor(line.color);
        if (line.kind === "pass") {
          return <line key={i} x1={x1} y1={0} x2={x2} y2={h} stroke={stroke} strokeWidth={1.75} />;
        }
        if (line.kind === "in") {
          return <line key={i} x1={x1} y1={0} x2={x2} y2={mid} stroke={stroke} strokeWidth={1.75} />;
        }
        if (line.kind === "out") {
          return <line key={i} x1={x1} y1={mid} x2={x2} y2={h} stroke={stroke} strokeWidth={1.75} />;
        }
        if (line.kind === "merge-in") {
          const d = `M ${x1} 0 C ${x1} ${h * 0.35}, ${x2} ${h * 0.15}, ${x2} ${mid}`;
          return <path key={i} d={d} fill="none" stroke={stroke} strokeWidth={1.75} />;
        }
        const d = `M ${x1} ${mid} C ${x1} ${h * 0.85}, ${x2} ${h * 0.65}, ${x2} ${h}`;
        return <path key={i} d={d} fill="none" stroke={stroke} strokeWidth={1.75} />;
      })}
      {isHead && (
        <circle cx={cx} cy={mid} r={5.2} fill="none" stroke={dotColor} strokeOpacity={0.35} strokeWidth={1.25} />
      )}
      {isMerge ? (
        <circle cx={cx} cy={mid} r={3.4} fill="var(--sidebar)" stroke={dotColor} strokeWidth={1.75} />
      ) : (
        <circle cx={cx} cy={mid} r={3.2} fill={dotColor} stroke="var(--sidebar)" strokeWidth={1.1} />
      )}
    </svg>
  );
}

function CommitGraphContinuation(p: { graph: GraphRow }) {
  const { graph } = p;
  const maxLane = graph.outgoing.reduce((m, o) => Math.max(m, o.lane), 0);
  const cols = Math.max(graph.outgoing.length ? maxLane + 1 : 1, 1);
  const width = graphSvgWidth(cols);
  return (
    <svg className="git-graph-cont" width={width} aria-hidden="true">
      {graph.outgoing.map((o) => {
        const x = laneX(o.lane);
        return (
          <line
            key={o.lane}
            x1={x}
            y1="0"
            x2={x}
            y2="100%"
            stroke={laneColor(o.color)}
            strokeWidth={1.75}
            strokeOpacity={0.55}
          />
        );
      })}
    </svg>
  );
}

function CommitRow(p: {
  commit: GitCommit;
  graph: GraphRow;
  expanded: boolean;
  remotePrefixes: readonly string[];
  onToggle: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const { commit, graph, expanded, remotePrefixes } = p;
  const badges = useMemo(() => parseCommitRefs(commit.refs, remotePrefixes), [commit.refs, remotePrefixes]);
  const isHead = badges.some((b) => b.current);
  const rel = relativeTime(commit.time);
  const fullDate = new Date(commit.time * 1000).toLocaleString();
  const title = `${commit.subject}\n${commit.short} · ${commit.author} · ${rel} (${fullDate})`;

  return (
    <div
      className={`git-commit-row${expanded ? " expanded" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      title={title}
      onClick={p.onToggle}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          p.onToggle();
        }
      }}
      onContextMenu={p.onMenu}
    >
      <CommitGraphCell graph={graph} isMerge={commit.parents.length > 1} isHead={isHead} />
      <span className="git-commit-main">
        {badges.map((b) => (
          <span
            key={`${b.kind}:${b.label}`}
            className={`git-ref-badge kind-${b.kind}${b.current ? " current" : ""}`}
          >
            {b.label}
          </span>
        ))}
        <span className="git-commit-subject">{commit.subject}</span>
      </span>
      <span className="git-commit-meta">
        <span className="git-commit-hash">{commit.short}</span>
        <span className="git-commit-author">{commit.author}</span>
        <span className="git-commit-time">{rel}</span>
      </span>
    </div>
  );
}

function CommitFileRow(p: { file: GitCommitFile; onOpen: () => void }) {
  const { file } = p;
  const letter = commitFileLetter(file.status);
  const { name, dir } = splitPath(file.path);
  const title = file.origPath
    ? `${file.origPath} → ${file.path} · ${LETTER_TITLE[letter]}`
    : `${file.path} · ${LETTER_TITLE[letter]}`;
  return (
    <div
      className="git-row git-commit-file-row"
      role="button"
      tabIndex={0}
      title={title}
      onClick={p.onOpen}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          p.onOpen();
        }
      }}
    >
      <span className={`git-name tone-${letterTone(letter)}${letter === "D" ? " deleted" : ""}`}>{name}</span>
      <span className="git-dir">{dir}</span>
      <span className={`git-letter tone-${letterTone(letter)}`} aria-label={LETTER_TITLE[letter]}>
        {letter}
      </span>
    </div>
  );
}

function BranchMenu(p: {
  root: string;
  current: string | null;
  onClose: () => void;
  onCheckout: (name: string, create: boolean) => void;
}) {
  const { root, onClose } = p;
  const ref = useRef<HTMLDivElement>(null);
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    let live = true;
    api
      .gitBranches(root)
      .then((list) => live && setBranches(list))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [root]);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target) || target?.closest(".git-branch-btn")) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const locals = branches?.filter((b) => !b.remote) ?? [];
  const localNames = new Set(locals.map((b) => b.name));
  // A remote branch that already has a local twin is reached through the local one.
  const remotes = branches?.filter((b) => b.remote && !localNames.has(localNameForRemote(b.name))) ?? [];

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) p.onCheckout(trimmed, true);
  };

  return (
    <div ref={ref} className="git-branch-menu" role="menu" aria-label="브랜치">
      {creating ? (
        <input
          className="git-branch-input"
          autoFocus
          placeholder="새 브랜치 이름 (Enter로 만들기)"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setCreating(false);
              setName("");
            }
          }}
        />
      ) : (
        <button type="button" className="git-branch-item new" onClick={() => setCreating(true)}>
          <Plus size={13} />
          <span className="git-branch-item-name">새 브랜치…</span>
        </button>
      )}
      {error ? (
        <div className="git-branch-note error">{error}</div>
      ) : !branches ? (
        <div className="git-branch-note">불러오는 중...</div>
      ) : (
        <>
          {locals.length > 0 && <div className="git-branch-title">브랜치</div>}
          {locals.map((b) => (
            <button
              key={b.name}
              type="button"
              role="menuitem"
              className={`git-branch-item${b.current ? " current" : ""}`}
              title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
              onClick={() => (b.current ? onClose() : p.onCheckout(b.name, false))}
            >
              <span className="git-branch-check">{b.current && <Check size={13} />}</span>
              <span className="git-branch-item-name">{b.name}</span>
            </button>
          ))}
          {remotes.length > 0 && <div className="git-branch-title">원격 브랜치</div>}
          {remotes.map((b) => (
            <button
              key={b.name}
              type="button"
              role="menuitem"
              className="git-branch-item"
              title={`${b.name}을(를) 따라가는 로컬 브랜치로 바꿔요`}
              onClick={() => p.onCheckout(localNameForRemote(b.name), false)}
            >
              <span className="git-branch-check" />
              <span className="git-branch-item-name">{b.name}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
