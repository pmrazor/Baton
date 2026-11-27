import { describe, expect, it } from "vitest";
import { fuzzyScore, highlightIndices, rankItems, splitPathMatch } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches empty query with zero score and no indices", () => {
    expect(fuzzyScore("", "src/App.tsx")).toEqual({ score: 0, indices: [] });
  });

  it("rejects non-subsequence queries", () => {
    expect(fuzzyScore("xyz", "src/App.tsx")).toBeNull();
    expect(fuzzyScore("tsxs", "App.tsx")).toBeNull();
    expect(fuzzyScore("a", "")).toBeNull();
  });

  it("is case-insensitive and returns matched indices", () => {
    const m = fuzzyScore("app", "src/App.tsx");
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([4, 5, 6]);
  });

  it("prefers basename matches over directory matches", () => {
    const inBasename = fuzzyScore("chat", "src/components/ChatView.tsx")!;
    const inDirOnly = fuzzyScore("chat", "src/chat/utils.ts")!;
    expect(inBasename).not.toBeNull();
    expect(inDirOnly).not.toBeNull();
    expect(inBasename.score).toBeGreaterThan(inDirOnly.score);
  });

  it("prefers consecutive matches over scattered matches", () => {
    const consec = fuzzyScore("fuzz", "src/commands/fuzzy.ts")!;
    const scattered = fuzzyScore("fuzz", "src/f_u_z_z.ts")!;
    expect(consec.score).toBeGreaterThan(scattered.score);
  });

  it("prefers word/segment and camelCase starts over mid-word characters", () => {
    const cc = fuzzyScore("cc", "src/components/CommandCenter.tsx")!;
    expect(cc.indices).toEqual([15, 22]);

    const boundary = fuzzyScore("cm", "code_map.ts")!;
    const midWord = fuzzyScore("cm", "acme.ts")!;
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  it("prefers shorter targets on equivalent prefix matches", () => {
    const short = fuzzyScore("app", "src/App.tsx")!;
    const long = fuzzyScore("app", "src/AppContainerWrapper.tsx")!;
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("matches Korean strings cleanly", () => {
    const m = fuzzyScore("에이전트", "에이전트 모드로 전환")!;
    expect(m).not.toBeNull();
    expect(m.indices).toEqual([0, 1, 2, 3]);
  });
});

describe("rankItems", () => {
  it("ranks best matches first and caps at limit", () => {
    const files = [
      "src/components/search/searchHelpers.ts",
      "src/search.ts",
      "src/app/research/notes.md",
      "src/unrelated.ts",
    ];
    const ranked = rankItems(files, "search", (p) => p);
    expect(ranked.map((r) => r.item)).toEqual([
      "src/search.ts",
      "src/components/search/searchHelpers.ts",
      "src/app/research/notes.md",
    ]);
  });

  it("respects default limit of 50 and custom limits", () => {
    const many = Array.from({ length: 80 }, (_, i) => `file-${i}.ts`);
    expect(rankItems(many, "", (x) => x)).toHaveLength(50);
    expect(rankItems(many, "file", (x) => x)).toHaveLength(50);
    expect(rankItems(many, "file", (x) => x, { limit: 10 })).toHaveLength(10);
  });

  it("supports secondary text fallback ranked below primary matches", () => {
    const cmds = [
      { id: "a", title: "MCP 설정", keywords: "설정 mcp" },
      { id: "b", title: "설정 열기", keywords: "설정 preferences mcp" },
    ];
    const ranked = rankItems(cmds, "mcp", (c) => c.title, {
      getSecondaryText: (c) => c.keywords,
    });
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b"]);
    expect(ranked[0].indices).toEqual([0, 1, 2]);
    expect(ranked[1].indices).toEqual([]);
  });

  it("uses tieBreaker when query is empty", () => {
    const items = [
      { id: "b", order: 2 },
      { id: "a", order: 1 },
    ];
    const ranked = rankItems(items, "", (x) => x.id, {
      tieBreaker: (a, b) => a.order - b.order,
    });
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b"]);
  });
});

describe("highlightIndices & splitPathMatch", () => {
  it("groups contiguous matched and unmatched runs", () => {
    expect(highlightIndices("CommandCenter", [0, 1, 7])).toEqual([
      { text: "Co", match: true },
      { text: "mmand", match: false },
      { text: "C", match: true },
      { text: "enter", match: false },
    ]);
  });

  it("splits path match indices between dir and basename", () => {
    const path = "src/commands/fuzzy.ts";
    const split = splitPathMatch(path, [0, 4, 13, 14]);
    expect(split).toEqual({
      name: "fuzzy.ts",
      nameIndices: [0, 1],
      dir: "src/commands",
      dirIndices: [0, 4],
    });

    expect(splitPathMatch("README.md", [0, 1])).toEqual({
      name: "README.md",
      nameIndices: [0, 1],
      dir: "",
      dirIndices: [],
    });
  });
});
