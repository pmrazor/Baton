import type { SearchResult } from "../../api";

/** What the 찾기 view remembers per workspace root while the app runs. */
export interface SearchViewState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  showFilters: boolean;
  result: SearchResult | null;
  error: string | null;
  /** `searchKey` of the search that produced `result` / `error`. */
  resultKey: string | null;
  /** Relative paths of collapsed file rows. */
  collapsed: string[];
}

export function emptySearchState(): SearchViewState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    include: "",
    exclude: "",
    showFilters: false,
    result: null,
    error: null,
    resultKey: null,
    collapsed: [],
  };
}

const states = new Map<string, SearchViewState>();

export function loadSearchState(root: string): SearchViewState {
  return states.get(root) ?? emptySearchState();
}

export function saveSearchState(root: string, state: SearchViewState): void {
  if (root) states.set(root, state);
}

// ⌘⇧F asks the panel to focus its input; it may not be mounted yet, so the request waits.
type FocusListener = () => void;
const focusListeners = new Set<FocusListener>();
let focusPending = false;

export function requestSearchFocus(): void {
  if (focusListeners.size === 0) {
    focusPending = true;
    return;
  }
  focusListeners.forEach((fn) => fn());
}

export function onSearchFocus(fn: FocusListener): () => void {
  focusListeners.add(fn);
  if (focusPending) {
    focusPending = false;
    fn();
  }
  return () => {
    focusListeners.delete(fn);
  };
}
