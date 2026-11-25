import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  Regex,
  WholeWord,
  X,
} from "lucide-react";
import { api, toFsError, type SearchOptions } from "../../api";
import { attachToComposer } from "../../composerBus";
import ContextMenu, { type ContextMenuSection } from "../ContextMenu";
import { FileIcon } from "../code/FileTree";
import { joinPath } from "../code/codeHelpers";
import {
  SEARCH_DEBOUNCE_MS,
  fileMatchCount,
  highlightSegments,
  normalizeGlobList,
  searchKey,
  shouldAutoSearch,
  splitResultPath,
  summaryText,
} from "./searchHelpers";
import { loadSearchState, onSearchFocus, saveSearchState, type SearchViewState } from "./searchStore";
import "./search.css";

export interface SearchPanelProps {
  root: string;
  /** Open a result file, at a 1-based line when given. */
  onOpen: (path: string, line?: number) => void;
}

type FileMenuAction = "open" | "copyPath" | "attach";

const FILE_MENU: ContextMenuSection<FileMenuAction>[] = [
  { id: "open", items: [{ id: "open", label: "파일 열기" }] },
  { id: "copy", items: [{ id: "copyPath", label: "경로 복사" }] },
  { id: "chat", items: [{ id: "attach", label: "채팅에 첨부" }] },
];

export default function SearchPanel({ root, onOpen }: SearchPanelProps) {
  const [s, setS] = useState<SearchViewState>(() => loadSearchState(root));
  const [loading, setLoading] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const inFlightKey = useRef<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => saveSearchState(root, s), [root, s]);

  useEffect(
    () =>
      onSearchFocus(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }),
    [],
  );

  const { query, caseSensitive, wholeWord, regex, include, exclude } = s;
  const opts: SearchOptions = useMemo(
    () => ({ caseSensitive, wholeWord, regex, include, exclude }),
    [caseSensitive, wholeWord, regex, include, exclude],
  );
  const currentKey = searchKey(query, opts);

  const update = (patch: Partial<SearchViewState>) => setS((prev) => ({ ...prev, ...patch }));

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const runSearch = useCallback(
    (q: string, o: SearchOptions) => {
      const key = searchKey(q, o);
      const id = ++requestSeq.current;
      if (!q) {
        inFlightKey.current = null;
        setLoading(false);
        setS((prev) => ({ ...prev, result: null, error: null, resultKey: null, collapsed: [] }));
        return;
      }
      inFlightKey.current = key;
      setLoading(true);
      api
        .searchText(root, q, { ...o, include: normalizeGlobList(o.include), exclude: normalizeGlobList(o.exclude) })
        .then((result) => {
          if (id !== requestSeq.current) return;
          setS((prev) => ({ ...prev, result, error: null, resultKey: key, collapsed: [] }));
        })
        .catch((e) => {
          if (id !== requestSeq.current) return;
          setS((prev) => ({ ...prev, result: null, error: toFsError(e).message, resultKey: key, collapsed: [] }));
        })
        .finally(() => {
          if (id !== requestSeq.current) return;
          inFlightKey.current = null;
          setLoading(false);
        });
    },
    [root],
  );

  // Search while typing, debounced, once the query is long enough.
  useEffect(() => {
    clearTimer();
    if (currentKey === s.resultKey || currentKey === inFlightKey.current) return;
    if (!query) {
      if (s.result || s.error || loading) runSearch("", opts);
      return;
    }
    if (!shouldAutoSearch(query)) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      runSearch(query, opts);
    }, SEARCH_DEBOUNCE_MS);
    return clearTimer;
    // `s.result` / `s.error` / `loading` only matter for clearing; leaving them out avoids re-running on each result.
  }, [currentKey, s.resultKey, runSearch]);

  const searchNow = () => {
    clearTimer();
    runSearch(query, opts);
  };

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      searchNow();
    } else if (e.key === "Escape" && e.currentTarget === inputRef.current && query) {
      e.preventDefault();
      update({ query: "" });
    }
  };

  const collapsed = useMemo(() => new Set(s.collapsed), [s.collapsed]);
  const toggleFile = (path: string) =>
    setS((prev) => ({
      ...prev,
      collapsed: prev.collapsed.includes(path)
        ? prev.collapsed.filter((p) => p !== path)
        : [...prev.collapsed, path],
    }));

  const files = s.result?.files ?? [];
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path));
  const toggleAll = () => update({ collapsed: allCollapsed ? [] : files.map((f) => f.path) });

  const handleMenuSelect = async (action: FileMenuAction) => {
    const path = menu?.path;
    setMenu(null);
    if (!path) return;
    const abs = joinPath(root, path);
    switch (action) {
      case "open":
        onOpen(path);
        return;
      case "copyPath":
        setOpError(null);
        try {
          await navigator.clipboard.writeText(abs);
        } catch (err) {
          setOpError(`클립보드에 복사하지 못했어요: ${toFsError(err).message}`);
        }
        return;
      case "attach":
        attachToComposer([abs]);
        return;
    }
  };

  const filtersActive = include.trim() !== "" || exclude.trim() !== "";

  return (
    <div className="search-panel">
      <div className="search-form">
        <div className="search-query-row">
          <div className="search-input-wrap">
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              placeholder="검색"
              aria-label="검색"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={onFieldKeyDown}
            />
            <ToggleButton
              title="대소문자 구분"
              active={caseSensitive}
              onClick={() => update({ caseSensitive: !caseSensitive })}
            >
              <CaseSensitive size={15} />
            </ToggleButton>
            <ToggleButton title="단어 단위" active={wholeWord} onClick={() => update({ wholeWord: !wholeWord })}>
              <WholeWord size={15} />
            </ToggleButton>
            <ToggleButton title="정규식" active={regex} onClick={() => update({ regex: !regex })}>
              <Regex size={15} />
            </ToggleButton>
          </div>
          <button
            type="button"
            className={`search-icon-btn${s.showFilters ? " pressed" : ""}${filtersActive ? " active" : ""}`}
            title={s.showFilters ? "파일 조건 숨기기" : "파일 조건 보기"}
            aria-label="파일 조건"
            aria-expanded={s.showFilters}
            onClick={() => update({ showFilters: !s.showFilters })}
          >
            <Ellipsis size={15} />
          </button>
        </div>

        {s.showFilters && (
          <div className="search-filters">
            <label className="search-filter">
              <span className="search-filter-label">포함할 파일</span>
              <input
                className="search-input boxed"
                type="text"
                placeholder="예: src/**, *.ts"
                spellCheck={false}
                autoComplete="off"
                value={include}
                onChange={(e) => update({ include: e.target.value })}
                onKeyDown={onFieldKeyDown}
              />
            </label>
            <label className="search-filter">
              <span className="search-filter-label">제외할 파일</span>
              <input
                className="search-input boxed"
                type="text"
                placeholder="예: dist, *.test.ts"
                spellCheck={false}
                autoComplete="off"
                value={exclude}
                onChange={(e) => update({ exclude: e.target.value })}
                onKeyDown={onFieldKeyDown}
              />
            </label>
          </div>
        )}
      </div>

      {opError && (
        <div className="code-tree-op-error" role="alert">
          <span>{opError}</span>
          <button
            type="button"
            className="code-tree-op-error-close"
            title="닫기"
            aria-label="닫기"
            onClick={() => setOpError(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {(loading || s.error || s.result) && (
        <div className="search-summary">
          <span className={`search-summary-text${s.error ? " error" : ""}`} role="status">
            {loading ? "찾는 중..." : s.error ? s.error : s.result ? summaryText(s.result) : ""}
          </span>
          {!loading && files.length > 0 && (
            <button
              type="button"
              className="search-icon-btn sm"
              title={allCollapsed ? "모두 펼치기" : "모두 접기"}
              aria-label={allCollapsed ? "모두 펼치기" : "모두 접기"}
              onClick={toggleAll}
            >
              {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            </button>
          )}
        </div>
      )}

      <div className={`search-results${loading ? " stale" : ""}`}>
        {files.map((file) => {
          const isCollapsed = collapsed.has(file.path);
          const { name, dir } = splitResultPath(file.path);
          return (
            <div key={file.path} className="search-file">
              <button
                type="button"
                className="code-tree-row search-file-row"
                title={file.path}
                aria-expanded={!isCollapsed}
                onClick={() => toggleFile(file.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path: file.path });
                }}
              >
                <span className="code-tree-chev">
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
                <FileIcon path={file.path} />
                <span className="code-tree-name search-file-name">{name}</span>
                {dir && <span className="search-file-dir">{dir}</span>}
                <span className="search-count">{fileMatchCount(file)}</span>
              </button>
              {!isCollapsed &&
                file.matches.map((m) => (
                  <button
                    key={m.line}
                    type="button"
                    className="code-tree-row search-match-row"
                    title={`${m.line}번째 줄`}
                    onClick={() => onOpen(file.path, m.line)}
                  >
                    <span className="search-preview">
                      {highlightSegments(m.preview, m.ranges).map((seg, i) =>
                        seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                      )}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={FILE_MENU}
          ariaLabel="찾기 결과 메뉴"
          onSelect={(id) => void handleMenuSelect(id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function ToggleButton(p: { title: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`search-toggle${p.active ? " on" : ""}`}
      title={p.title}
      aria-label={p.title}
      aria-pressed={p.active}
      onClick={p.onClick}
    >
      {p.children}
    </button>
  );
}
