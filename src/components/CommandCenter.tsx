import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, CornerDownLeft, FileText, Hash, MessageSquare, Search, X } from "lucide-react";
import { api } from "../api";
import { requestRevealMessage } from "../chatNav";
import { requestOpenCode } from "../codeNav";
import {
  highlightRanges,
  searchConversations,
  type ConversationHit,
  type ConversationSearchGroup,
  type MatchRange,
} from "../commands/conversationSearch";
import { highlightIndices, rankItems, splitPathMatch } from "../commands/fuzzy";
import {
  executeCommand,
  isCommandCenterShortcut,
  listCommands,
  parsePaletteInput,
  registerCommand,
  subscribeCommands,
  type Command,
} from "../commands/registry";
import { detectPlatform } from "../platform";
import type { State } from "../store";
import type { Session } from "../types";
import { getRootEditorView, openFile } from "./code/editorStore";
import { relativeTime } from "./git/gitHelpers";
import { baseName } from "./Sidebar";

const FILE_CACHE_TTL_MS = 30_000;
const MAX_RESULTS = 50;
const CONV_SEARCH_DEBOUNCE_MS = 120;
const CONV_SEARCH_LIMIT = 200;

interface FileCacheEntry {
  files: string[];
  fetchedAt: number;
}

const fileCache = new Map<string, FileCacheEntry>();

type PaletteRow =
  | {
      kind: "file";
      key: string;
      path: string;
      indices: number[];
    }
  | {
      kind: "session";
      key: string;
      session: Session;
      indices: number[];
    }
  | {
      kind: "searchConversations";
      key: string;
      query: string;
    }
  | {
      kind: "command";
      key: string;
      command: Command;
      indices: number[];
    }
  | {
      kind: "line";
      key: string;
      path: string;
      line: number;
    }
  | {
      kind: "convHit";
      key: string;
      hit: ConversationHit;
    }
  | {
      kind: "convMore";
      key: string;
      sessionKey: string;
      moreCount: number;
    };

function HighlightedText({ text, indices }: { text: string; indices: readonly number[] }): ReactNode {
  const runs = highlightIndices(text, indices);
  return runs.map((run, i) =>
    run.match ? (
      <mark key={i} className="cmd-match">
        {run.text}
      </mark>
    ) : (
      <span key={i}>{run.text}</span>
    ),
  );
}

function HighlightedRanges({ text, ranges }: { text: string; ranges: readonly MatchRange[] }): ReactNode {
  const runs = highlightRanges(text, ranges);
  return runs.map((run, i) =>
    run.match ? (
      <mark key={i} className="cmd-match">
        {run.text}
      </mark>
    ) : (
      <span key={i}>{run.text}</span>
    ),
  );
}

interface CommandCenterProps {
  state: State;
  session: Session | null;
  onOpenSession?: (key: string) => void;
}

export default function CommandCenter({ state, session, onOpenSession }: CommandCenterProps) {
  const isMac = useMemo(
    () => detectPlatform(typeof navigator !== "undefined" ? navigator.userAgent : "") === "mac",
    [],
  );
  const codeRoot = session?.cwd ?? state.workspace;

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [debouncedConvQuery, setDebouncedConvQuery] = useState("");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const [activeIdx, setActiveIdx] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [commandTick, setCommandTick] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; right: number; maxHeight: number }>({
    top: 52,
    right: 16,
    maxHeight: 420,
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navByKeyboardRef = useRef(false);
  const fetchSeqRef = useRef(0);

  const openWith = useCallback((initialInput: string) => {
    setInput(initialInput);
    setActiveIdx(0);
    setExpandedSessions(new Set());
    setOpen(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const len = initialInput.length;
      el.setSelectionRange(len, len);
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Capture-phase global shortcuts (⌘P / Ctrl+P, ⌘⇧P / Ctrl+Shift+P, ⌘⇧H / Ctrl+Shift+H)
  // so CodeMirror/xterm don't swallow them.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const hit = isCommandCenterShortcut(e, isMac);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      openWith(hit === "commands" ? ">" : hit === "conversations" ? "#" : "");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isMac, openWith]);

  // Register "지난 대화 검색" in the command palette (`>`).
  useEffect(() => {
    return registerCommand({
      id: "chat.search",
      title: "지난 대화 검색",
      category: "대화",
      keywords: ["search", "history", "conversation", "chat", "find", "#"],
      shortcut: isMac ? "⌘⇧H" : "Ctrl+Shift+H",
      run: () => openWith("#"),
    });
  }, [isMac, openWith]);

  // Refresh open palette if commands change while open.
  useEffect(() => {
    if (!open) return;
    return subscribeCommands(() => setCommandTick((t) => t + 1));
  }, [open]);

  // Load workspace files with a 30s per-root cache whenever the palette opens or root changes.
  useEffect(() => {
    if (!open) return;
    if (!codeRoot) {
      setFiles([]);
      setLoadingFiles(false);
      return;
    }
    const cached = fileCache.get(codeRoot);
    const now = Date.now();
    if (cached) {
      setFiles(cached.files);
      if (now - cached.fetchedAt < FILE_CACHE_TTL_MS) {
        setLoadingFiles(false);
        return;
      }
    } else {
      setFiles([]);
    }

    const seq = ++fetchSeqRef.current;
    setLoadingFiles(!cached);
    api
      .listFiles(codeRoot)
      .then((list) => {
        fileCache.set(codeRoot, { files: list, fetchedAt: Date.now() });
        if (fetchSeqRef.current === seq) {
          setFiles(list);
          setLoadingFiles(false);
        }
      })
      .catch(() => {
        if (fetchSeqRef.current === seq) setLoadingFiles(false);
      });
  }, [open, codeRoot]);

  // Position popup right-aligned under the trigger button, clamped to viewport.
  const updateAnchor = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const popupWidth = Math.min(560, window.innerWidth - 16);
    const rawRight = Math.max(8, window.innerWidth - rect.right);
    const maxRight = Math.max(8, window.innerWidth - popupWidth - 8);
    const top = rect.bottom + 6;
    const maxHeight = Math.max(180, Math.min(Math.round(window.innerHeight * 0.6), window.innerHeight - top - 12));
    setAnchor({ top, right: Math.min(rawRight, maxRight), maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [open, updateAnchor]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const parsed = useMemo(() => parsePaletteInput(input), [input]);

  // Debounce conversation content search (~120ms) while typing in `#` mode.
  useEffect(() => {
    if (!open || parsed.mode !== "conversation") {
      setDebouncedConvQuery("");
      return;
    }
    if (parsed.query.length === 0) {
      setDebouncedConvQuery("");
      return;
    }
    if (parsed.query === debouncedConvQuery) return;
    const timer = window.setTimeout(() => {
      setDebouncedConvQuery(parsed.query);
    }, CONV_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, parsed.mode, parsed.query, debouncedConvQuery]);

  // Reset per-conversation expansion whenever the query changes or palette closes.
  useEffect(() => {
    setExpandedSessions(new Set());
  }, [open, debouncedConvQuery]);

  const activeFileTab = useMemo(() => {
    if (!open || !codeRoot) return null;
    const view = getRootEditorView(codeRoot);
    return view.tabs.find((t) => t.id === view.active && t.kind === "file") ?? null;
  }, [open, codeRoot]);

  const openFileSet = useMemo(() => {
    if (!open || !codeRoot) return new Set<string>();
    const view = getRootEditorView(codeRoot);
    return new Set(view.tabs.filter((t) => t.kind === "file").map((t) => t.path));
  }, [open, codeRoot]);

  const conversations = useMemo(
    () => state.sessions.filter((s) => !s.draft).sort((a, b) => b.updatedAt - a.updatedAt),
    [state.sessions],
  );

  const fileRows = useMemo<PaletteRow[]>(() => {
    if (!open || parsed.mode !== "quick" || !codeRoot) return [];
    const ranked = rankItems(files, parsed.query, (p) => p, {
      limit: MAX_RESULTS,
      tieBreaker:
        parsed.query.length === 0 && openFileSet.size > 0
          ? (a, b) => Number(openFileSet.has(b)) - Number(openFileSet.has(a))
          : undefined,
    });
    return ranked.map((r) => ({
      kind: "file",
      key: `file:${r.item}`,
      path: r.item,
      indices: r.indices,
    }));
  }, [open, parsed.mode, parsed.query, codeRoot, files, openFileSet]);

  const sessionRows = useMemo<PaletteRow[]>(() => {
    if (!open || parsed.mode !== "quick") return [];
    const ranked = rankItems(conversations, parsed.query, (s) => s.title, {
      limit: MAX_RESULTS,
      getSecondaryText: (s) => baseName(s.cwd),
    });
    return ranked.map((r) => ({
      kind: "session",
      key: `session:${r.item.key}`,
      session: r.item,
      indices: r.indices,
    }));
  }, [open, parsed.mode, parsed.query, conversations]);

  const quickSearchConvRow = useMemo<PaletteRow | null>(() => {
    if (!open || parsed.mode !== "quick" || parsed.query.length < 2) return null;
    return {
      kind: "searchConversations",
      key: `search-conv:${parsed.query}`,
      query: parsed.query,
    };
  }, [open, parsed.mode, parsed.query]);

  const commandRows = useMemo<PaletteRow[]>(() => {
    if (!open || parsed.mode !== "command") return [];
    // `commandTick` triggers re-evaluation when commands or recency update.
    void commandTick;
    const all = listCommands();
    const ranked = rankItems(all, parsed.query, (c) => c.title, {
      limit: MAX_RESULTS,
      getSecondaryText: (c) => [c.category, c.title, ...(c.keywords ?? [])].filter(Boolean).join(" "),
    });
    return ranked.map((r) => ({
      kind: "command",
      key: `cmd:${r.item.id}`,
      command: r.item,
      indices: r.indices,
    }));
  }, [open, parsed.mode, parsed.query, commandTick]);

  const lineRows = useMemo<PaletteRow[]>(() => {
    if (!open || parsed.mode !== "line" || !activeFileTab || parsed.line === null) return [];
    return [
      {
        kind: "line",
        key: `line:${activeFileTab.path}:${parsed.line}`,
        path: activeFileTab.path,
        line: parsed.line,
      },
    ];
  }, [open, parsed.mode, parsed.line, activeFileTab]);

  const convView = useMemo(() => {
    if (!open || parsed.mode !== "conversation" || debouncedConvQuery.length === 0) {
      return {
        groups: [] as { group: ConversationSearchGroup; rows: { row: PaletteRow; index: number }[] }[],
        flat: [] as PaletteRow[],
      };
    }
    const res = searchConversations(state.sessions, debouncedConvQuery, { limit: CONV_SEARCH_LIMIT });
    const flat: PaletteRow[] = [];
    const groups = res.groups.map((group) => {
      const expanded = expandedSessions.has(group.sessionKey);
      const visibleHits = expanded ? [...group.hits, ...group.overflow] : group.hits;
      const rows: { row: PaletteRow; index: number }[] = [];
      for (const hit of visibleHits) {
        const row: PaletteRow = {
          kind: "convHit",
          key: `conv:${hit.sessionKey}:${hit.itemId ?? "title"}`,
          hit,
        };
        rows.push({ row, index: flat.length });
        flat.push(row);
      }
      if (!expanded && group.moreCount > 0) {
        const row: PaletteRow = {
          kind: "convMore",
          key: `conv-more:${group.sessionKey}`,
          sessionKey: group.sessionKey,
          moreCount: group.moreCount,
        };
        rows.push({ row, index: flat.length });
        flat.push(row);
      }
      return { group, rows };
    });
    return { groups, flat };
  }, [open, parsed.mode, debouncedConvQuery, state.sessions, expandedSessions]);

  const flatRows = useMemo<PaletteRow[]>(() => {
    if (parsed.mode === "command") return commandRows;
    if (parsed.mode === "line") return lineRows;
    if (parsed.mode === "conversation") return convView.flat;
    return quickSearchConvRow ? [...fileRows, ...sessionRows, quickSearchConvRow] : [...fileRows, ...sessionRows];
  }, [parsed.mode, fileRows, sessionRows, quickSearchConvRow, commandRows, lineRows, convView.flat]);

  // Keep activeIdx clamped whenever results shrink.
  useEffect(() => {
    setActiveIdx((idx) => (flatRows.length === 0 ? 0 : Math.min(idx, flatRows.length - 1)));
  }, [flatRows.length]);

  // Scroll highlighted row into view when navigating by keyboard.
  useEffect(() => {
    if (!open || !navByKeyboardRef.current) return;
    navByKeyboardRef.current = false;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${activeIdx}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const runRow = useCallback(
    (row: PaletteRow) => {
      if (row.kind === "searchConversations") {
        const nextInput = `#${row.query}`;
        setInput(nextInput);
        setDebouncedConvQuery(row.query);
        setActiveIdx(0);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(nextInput.length, nextInput.length);
        });
        return;
      }
      if (row.kind === "convMore") {
        setExpandedSessions((prev) => {
          const next = new Set(prev);
          next.add(row.sessionKey);
          return next;
        });
        inputRef.current?.focus();
        return;
      }
      close();
      switch (row.kind) {
        case "file":
          if (codeRoot) {
            openFile(codeRoot, row.path);
            requestOpenCode();
          }
          return;
        case "session":
          onOpenSession?.(row.session.key);
          return;
        case "command":
          executeCommand(row.command);
          return;
        case "line":
          if (codeRoot) {
            openFile(codeRoot, row.path, row.line);
            requestOpenCode();
          }
          return;
        case "convHit":
          onOpenSession?.(row.hit.sessionKey);
          if (row.hit.itemId !== null) {
            requestRevealMessage(row.hit.sessionKey, row.hit.itemId);
          }
          return;
      }
    },
    [close, codeRoot, onOpenSession],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatRows.length === 0) return;
      navByKeyboardRef.current = true;
      setActiveIdx((i) => (i + 1) % flatRows.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatRows.length === 0) return;
      navByKeyboardRef.current = true;
      setActiveIdx((i) => (i - 1 + flatRows.length) % flatRows.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = flatRows[activeIdx];
      if (target) {
        runRow(target);
      } else if (parsed.mode === "line") {
        // Skip gracefully when no editor tab is open or line is invalid.
        if (!activeFileTab) close();
      }
    }
  };

  const renderRow = (row: PaletteRow, index: number) => {
    const active = index === activeIdx;
    const cls = `cmd-item${active ? " active" : ""}`;
    const commonProps = {
      type: "button" as const,
      role: "option" as const,
      "aria-selected": active,
      "data-cmd-index": index,
      className: cls,
      onMouseEnter: () => setActiveIdx(index),
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onClick: () => runRow(row),
    };

    if (row.kind === "file") {
      const { name, nameIndices, dir, dirIndices } = splitPathMatch(row.path, row.indices);
      return (
        <button key={row.key} {...commonProps}>
          <FileText size={14} className="cmd-item-icon" />
          <span className="cmd-item-main">
            <span className="cmd-item-title">
              <HighlightedText text={name} indices={nameIndices} />
            </span>
            {dir && (
              <span className="cmd-item-dir">
                <HighlightedText text={dir} indices={dirIndices} />
              </span>
            )}
          </span>
        </button>
      );
    }

    if (row.kind === "session") {
      const isCurrent = row.session.key === state.activeKey;
      return (
        <button key={row.key} {...commonProps}>
          <MessageSquare size={14} className="cmd-item-icon" />
          <span className="cmd-item-main">
            <span className="cmd-item-title">
              <HighlightedText text={row.session.title} indices={row.indices} />
            </span>
            <span className="cmd-item-dir">{baseName(row.session.cwd)}</span>
          </span>
          {isCurrent && <span className="cmd-item-badge">현재</span>}
        </button>
      );
    }

    if (row.kind === "searchConversations") {
      return (
        <button key={row.key} {...commonProps}>
          <Search size={14} className="cmd-item-icon" />
          <span className="cmd-item-main">
            <span className="cmd-item-title">지난 대화에서 ‘{row.query}’ 찾기 · #</span>
          </span>
          <CornerDownLeft size={13} className="cmd-shortcut" />
        </button>
      );
    }

    if (row.kind === "command") {
      const { command } = row;
      return (
        <button key={row.key} {...commonProps}>
          <ChevronRight size={14} className="cmd-item-icon" />
          <span className="cmd-item-main">
            {command.category && <span className="cmd-category">{command.category}</span>}
            <span className="cmd-item-title">
              <HighlightedText text={command.title} indices={row.indices} />
            </span>
          </span>
          {command.shortcut && <span className="cmd-shortcut">{command.shortcut}</span>}
        </button>
      );
    }

    if (row.kind === "convHit") {
      return (
        <button key={row.key} {...commonProps} className={`${cls} cmd-conv-hit`}>
          <span className="cmd-conv-snippet">
            <HighlightedRanges text={row.hit.snippet} ranges={row.hit.matchRanges} />
          </span>
          {row.hit.itemId === null && <span className="cmd-item-badge">제목</span>}
        </button>
      );
    }

    if (row.kind === "convMore") {
      return (
        <button key={row.key} {...commonProps} className={`${cls} cmd-conv-more`}>
          <span className="cmd-conv-more-label">{row.moreCount}개 더</span>
        </button>
      );
    }

    return (
      <button key={row.key} {...commonProps}>
        <Hash size={14} className="cmd-item-icon" />
        <span className="cmd-item-main">
          <span className="cmd-item-title">{row.line}번째 줄로 이동</span>
          <span className="cmd-item-dir">{row.path}</span>
        </span>
        <CornerDownLeft size={13} className="cmd-shortcut" />
      </button>
    );
  };

  const placeholder = isMac ? "검색 · ⌘P" : "검색 · Ctrl+P";
  const fileCount = fileRows.length;
  const sessionCount = sessionRows.length;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`cmd-trigger${open ? " open" : ""}`}
        aria-label="명령 센터 열기"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : openWith(""))}
      >
        <Search size={13} className="cmd-trigger-icon" />
        <span className="cmd-trigger-label">{placeholder}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="cmd-palette"
            role="dialog"
            aria-label="명령 센터"
            style={{ top: anchor.top, right: anchor.right, maxHeight: anchor.maxHeight }}
          >
            <div className="cmd-input-row">
              <Search size={15} className="cmd-input-icon" />
              <input
                ref={inputRef}
                type="text"
                className="cmd-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setActiveIdx(0);
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="파일, 대화 검색 · > 명령 · :줄 번호 · # 대화 내용"
                spellCheck={false}
                autoComplete="off"
              />
              {input && (
                <button
                  type="button"
                  className="icon-btn sm cmd-clear-btn"
                  title="지우기"
                  aria-label="검색어 지우기"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setInput("");
                    setActiveIdx(0);
                    inputRef.current?.focus();
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {input.length === 0 && <div className="cmd-hint">파일 이름 · &gt; 명령 · :줄 번호 · # 대화 내용</div>}

            <div ref={listRef} className="cmd-list" role="listbox">
              {parsed.mode === "quick" && (
                <>
                  {fileRows.length > 0 && (
                    <div className="cmd-group">
                      <div className="cmd-group-title">파일</div>
                      {fileRows.map((row, i) => renderRow(row, i))}
                    </div>
                  )}
                  {sessionRows.length > 0 && (
                    <div className="cmd-group">
                      <div className="cmd-group-title">대화</div>
                      {sessionRows.map((row, i) => renderRow(row, fileCount + i))}
                    </div>
                  )}
                  {fileRows.length === 0 && sessionRows.length === 0 && !quickSearchConvRow && (
                    <div className="cmd-empty">
                      {loadingFiles ? "파일 목록을 불러오는 중이에요..." : "일치하는 결과가 없어요."}
                    </div>
                  )}
                  {quickSearchConvRow && (
                    <div className="cmd-group">{renderRow(quickSearchConvRow, fileCount + sessionCount)}</div>
                  )}
                </>
              )}

              {parsed.mode === "command" &&
                (commandRows.length > 0 ? (
                  <div className="cmd-group">{commandRows.map((row, i) => renderRow(row, i))}</div>
                ) : (
                  <div className="cmd-empty">일치하는 명령이 없어요.</div>
                ))}

              {parsed.mode === "line" &&
                (lineRows.length > 0 ? (
                  <div className="cmd-group">{lineRows.map((row, i) => renderRow(row, i))}</div>
                ) : !activeFileTab ? (
                  <div className="cmd-empty">열린 코드 탭이 없어요. 먼저 파일을 열어 주세요.</div>
                ) : (
                  <div className="cmd-empty">이동할 줄 번호를 입력해 주세요 · {activeFileTab.path}</div>
                ))}

              {parsed.mode === "conversation" &&
                (parsed.query.length === 0 ? (
                  <div className="cmd-empty">찾을 단어를 입력해 주세요</div>
                ) : debouncedConvQuery.length === 0 ? null : convView.groups.length > 0 ? (
                  convView.groups.map(({ group, rows }) => {
                    const meta = [group.workspace, relativeTime(Math.floor(group.updatedAt / 1000))]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div key={group.sessionKey} className="cmd-group cmd-conv-group">
                        <div className="cmd-conv-header">
                          <MessageSquare size={13} className="cmd-item-icon" />
                          <span className="cmd-conv-title">{group.title}</span>
                          {group.isTask && <span className="cmd-conv-pill">하위 작업</span>}
                          <span className="cmd-conv-meta">{meta}</span>
                        </div>
                        {rows.map(({ row, index }) => renderRow(row, index))}
                      </div>
                    );
                  })
                ) : (
                  <div className="cmd-empty">일치하는 대화 내용이 없어요.</div>
                ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
