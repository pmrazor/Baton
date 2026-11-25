import type { Tab } from "./ChatView";

export type UiMode = "simple" | "pro";

/** Views available in the Pro mode sub-sidebar. */
export type ProViewId = "files" | "search" | "git";

export interface ProViewDef {
  id: ProViewId;
  label: string;
}

export const PRO_VIEWS: readonly ProViewDef[] = [
  { id: "files", label: "파일" },
  { id: "search", label: "찾기" },
  { id: "git", label: "깃" },
];

export const SUB_SIDEBAR_WIDTH = {
  default: 260,
  min: 180,
  max: 480,
} as const;

export const CHAT_PANEL_WIDTH = {
  default: 380,
  min: 280,
  max: 640,
} as const;

/** Below this window width, the right chat panel starts collapsed and opens as an overlay. */
export const NARROW_BREAKPOINT = 1100;

export function parseUiMode(raw: unknown): UiMode {
  return raw === "pro" ? "pro" : "simple";
}

export function clampWidth(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampSubSidebarWidth(width: number): number {
  return clampWidth(width, SUB_SIDEBAR_WIDTH.min, SUB_SIDEBAR_WIDTH.max, SUB_SIDEBAR_WIDTH.default);
}

export function clampChatPanelWidth(width: number): number {
  return clampWidth(width, CHAT_PANEL_WIDTH.min, CHAT_PANEL_WIDTH.max, CHAT_PANEL_WIDTH.default);
}

/** Clicking the active view closes the sub-sidebar; clicking another opens it. */
export function toggleProView(current: ProViewId | null, clicked: ProViewId): ProViewId | null {
  return current === clicked ? null : clicked;
}

/** Clicking the rail expand/collapse toggle closes an open sub-sidebar or reopens the last view. */
export function toggleSubSidebar(current: ProViewId | null, lastView: ProViewId = "files"): ProViewId | null {
  return current !== null ? null : lastView;
}

export function isNarrowViewport(width: number): boolean {
  return width < NARROW_BREAKPOINT;
}

export type ChatPanelMode = "none" | "docked" | "overlay" | "collapsed";

/**
 * Determine how the right chat panel renders in Pro mode:
 * - On the 대화 tab, conversation fills the center and there is no right panel.
 * - On other tabs, wide viewports dock it (unless collapsed) and narrow viewports
 *   keep it collapsed until opened as an overlay.
 */
export function resolveChatPanelMode(
  tab: Tab,
  isNarrow: boolean,
  wideOpen: boolean,
  narrowOpen: boolean,
): ChatPanelMode {
  if (tab === "chat") return "none";
  if (isNarrow) return narrowOpen ? "overlay" : "collapsed";
  return wideOpen ? "docked" : "collapsed";
}

/** Simple mode has no 코드 tab; fall back to 대화 when leaving Pro mode. */
export function normalizeTabForMode(tab: Tab, uiMode: UiMode): Tab {
  if (uiMode === "simple" && tab === "code") return "chat";
  return tab;
}
