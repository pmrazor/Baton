import { describe, expect, it } from "vitest";
import {
  CHAT_PANEL_WIDTH,
  NARROW_BREAKPOINT,
  PRO_VIEWS,
  SUB_SIDEBAR_WIDTH,
  clampChatPanelWidth,
  clampSubSidebarWidth,
  clampWidth,
  isNarrowViewport,
  normalizeTabForMode,
  parseUiMode,
  resolveChatPanelMode,
  toggleProView,
  toggleSubSidebar,
} from "./proLayoutState";

describe("parseUiMode", () => {
  it("accepts pro and defaults everything else to simple", () => {
    expect(parseUiMode("pro")).toBe("pro");
    expect(parseUiMode("simple")).toBe("simple");
    expect(parseUiMode(null)).toBe("simple");
    expect(parseUiMode("other")).toBe("simple");
  });
});

describe("width clamping", () => {
  it("clamps numbers into [min, max] and rounds", () => {
    expect(clampWidth(100, 180, 480)).toBe(180);
    expect(clampWidth(600, 180, 480)).toBe(480);
    expect(clampWidth(259.6, 180, 480)).toBe(260);
  });

  it("falls back safely on non-finite values", () => {
    expect(clampWidth(Number.NaN, 180, 480, 260)).toBe(260);
    expect(clampWidth(Number.POSITIVE_INFINITY, 180, 480, 260)).toBe(260);
  });

  it("clamps sub-sidebar and chat panel widths to their bounds", () => {
    expect(clampSubSidebarWidth(50)).toBe(SUB_SIDEBAR_WIDTH.min);
    expect(clampSubSidebarWidth(999)).toBe(SUB_SIDEBAR_WIDTH.max);
    expect(clampSubSidebarWidth(300)).toBe(300);
    expect(clampSubSidebarWidth(Number.NaN)).toBe(SUB_SIDEBAR_WIDTH.default);

    expect(clampChatPanelWidth(100)).toBe(CHAT_PANEL_WIDTH.min);
    expect(clampChatPanelWidth(900)).toBe(CHAT_PANEL_WIDTH.max);
    expect(clampChatPanelWidth(420)).toBe(420);
    expect(clampChatPanelWidth(Number.NaN)).toBe(CHAT_PANEL_WIDTH.default);
  });
});

describe("sub-sidebar view toggling", () => {
  it("closes when clicking the active view and opens when clicking another", () => {
    expect(toggleProView(null, "files")).toBe("files");
    expect(toggleProView("files", "files")).toBeNull();
  });

  it("toggles sub-sidebar visibility via last view", () => {
    expect(toggleSubSidebar("files", "files")).toBeNull();
    expect(toggleSubSidebar(null, "files")).toBe("files");
  });

  it("exposes 파일 in the view registry", () => {
    expect(PRO_VIEWS.map((v) => v.id)).toContain("files");
  });
});

describe("narrow viewport and right chat panel mode", () => {
  it("treats widths below NARROW_BREAKPOINT as narrow", () => {
    expect(isNarrowViewport(NARROW_BREAKPOINT - 1)).toBe(true);
    expect(isNarrowViewport(NARROW_BREAKPOINT)).toBe(false);
  });

  it("hides the right panel completely on the chat tab", () => {
    expect(resolveChatPanelMode("chat", false, true, true)).toBe("none");
    expect(resolveChatPanelMode("chat", true, true, true)).toBe("none");
  });

  it("docks or collapses on wide viewports for non-chat tabs", () => {
    for (const tab of ["code", "terminal", "activity", "logs"] as const) {
      expect(resolveChatPanelMode(tab, false, true, false)).toBe("docked");
      expect(resolveChatPanelMode(tab, false, false, true)).toBe("collapsed");
    }
  });

  it("starts collapsed and opens as overlay on narrow viewports", () => {
    expect(resolveChatPanelMode("code", true, true, false)).toBe("collapsed");
    expect(resolveChatPanelMode("code", true, true, true)).toBe("overlay");
    expect(resolveChatPanelMode("terminal", true, false, true)).toBe("overlay");
  });
});

describe("normalizeTabForMode", () => {
  it("maps code back to chat in simple mode and keeps all other tabs", () => {
    expect(normalizeTabForMode("code", "simple")).toBe("chat");
    expect(normalizeTabForMode("code", "pro")).toBe("code");
    expect(normalizeTabForMode("terminal", "simple")).toBe("terminal");
    expect(normalizeTabForMode("activity", "simple")).toBe("activity");
    expect(normalizeTabForMode("logs", "simple")).toBe("logs");
  });
});
