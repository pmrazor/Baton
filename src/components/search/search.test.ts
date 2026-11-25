import { describe, expect, it } from "vitest";
import type { SearchOptions, SearchResult } from "../../api";
import {
  fileMatchCount,
  highlightSegments,
  isSearchShortcut,
  normalizeGlobList,
  parseGlobList,
  searchKey,
  shouldAutoSearch,
  splitResultPath,
  summaryText,
  totalMatchCount,
} from "./searchHelpers";
import { emptySearchState, loadSearchState, onSearchFocus, requestSearchFocus, saveSearchState } from "./searchStore";

const opts = (patch: Partial<SearchOptions> = {}): SearchOptions => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  ...patch,
});

const result = (counts: number[][], truncated = false): SearchResult => ({
  files: counts.map((lines, i) => ({
    path: `f${i}.ts`,
    matches: lines.map((n, line) => ({
      line: line + 1,
      column: 1,
      preview: "x".repeat(n),
      ranges: Array.from({ length: n }, (_, k) => [k, k + 1] as [number, number]),
    })),
  })),
  truncated,
  searchedFiles: counts.length,
});

describe("parseGlobList", () => {
  it("splits on commas and trims", () => {
    expect(parseGlobList(" src/**, *.ts ,,docs ")).toEqual(["src/**", "*.ts", "docs"]);
  });

  it("keeps commas inside brace groups", () => {
    expect(parseGlobList("*.{ts,tsx}, lib/{a,b}/**")).toEqual(["*.{ts,tsx}", "lib/{a,b}/**"]);
  });

  it("returns nothing for blank input", () => {
    expect(parseGlobList("")).toEqual([]);
    expect(parseGlobList(" , ")).toEqual([]);
  });

  it("normalizes spacing", () => {
    expect(normalizeGlobList("a,b ,  c")).toBe("a, b, c");
  });
});

describe("searchKey", () => {
  it("ignores glob spacing but not options", () => {
    expect(searchKey("foo", opts({ include: "a,b" }))).toBe(searchKey("foo", opts({ include: " a , b " })));
    expect(searchKey("foo", opts())).not.toBe(searchKey("foo", opts({ regex: true })));
    expect(searchKey("foo", opts())).not.toBe(searchKey("Foo", opts()));
  });
});

describe("shouldAutoSearch", () => {
  it("waits for two characters", () => {
    expect(shouldAutoSearch("")).toBe(false);
    expect(shouldAutoSearch("a")).toBe(false);
    expect(shouldAutoSearch("ab")).toBe(true);
  });
});

describe("highlightSegments", () => {
  it("splits plain and matched runs", () => {
    expect(highlightSegments("let foo = foo;", [[4, 7], [10, 13]])).toEqual([
      { text: "let ", match: false },
      { text: "foo", match: true },
      { text: " = ", match: false },
      { text: "foo", match: true },
      { text: ";", match: false },
    ]);
  });

  it("handles matches at the edges", () => {
    expect(highlightSegments("abc", [[0, 3]])).toEqual([{ text: "abc", match: true }]);
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", match: false }]);
  });

  it("sorts, merges overlaps and clamps out-of-range ranges", () => {
    expect(highlightSegments("abcdef", [[4, 9], [0, 2], [1, 3], [5, 5]])).toEqual([
      { text: "abc", match: true },
      { text: "d", match: false },
      { text: "ef", match: true },
    ]);
  });
});

describe("summaryText", () => {
  it("counts files and matches", () => {
    const r = result([[2, 1], [3]]);
    expect(fileMatchCount(r.files[0])).toBe(3);
    expect(totalMatchCount(r)).toBe(6);
    expect(summaryText(r)).toBe("파일 2개에서 6개 찾음");
  });

  it("says when nothing matched", () => {
    expect(summaryText(result([]))).toBe("결과가 없어요");
  });

  it("says when results were cut off", () => {
    expect(summaryText(result([[5]], true))).toBe("결과가 많아 일부만 보여요");
  });
});

describe("splitResultPath", () => {
  it("splits name and folder", () => {
    expect(splitResultPath("src/components/App.tsx")).toEqual({ name: "App.tsx", dir: "src/components" });
    expect(splitResultPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});

describe("isSearchShortcut", () => {
  const key = (patch: Partial<Parameters<typeof isSearchShortcut>[0]>) => ({
    key: "F",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...patch,
  });

  it("uses ⌘⇧F on macOS", () => {
    expect(isSearchShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true }), true)).toBe(false);
  });

  it("uses Ctrl+Shift+F elsewhere", () => {
    expect(isSearchShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSearchShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it("needs Shift and no Alt", () => {
    expect(isSearchShortcut(key({ metaKey: true, shiftKey: false, key: "f" }), true)).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true, key: "g" }), true)).toBe(false);
  });
});

describe("searchStore", () => {
  it("remembers state per root", () => {
    expect(loadSearchState("/a")).toEqual(emptySearchState());
    saveSearchState("/a", { ...emptySearchState(), query: "needle", regex: true });
    expect(loadSearchState("/a").query).toBe("needle");
    expect(loadSearchState("/b").query).toBe("");
  });

  it("delivers a focus request made before the panel mounts", () => {
    requestSearchFocus();
    let focused = 0;
    const off = onSearchFocus(() => focused++);
    expect(focused).toBe(1);
    requestSearchFocus();
    expect(focused).toBe(2);
    off();
  });
});
