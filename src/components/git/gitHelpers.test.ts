import { describe, expect, it } from "vitest";
import type { GitFileStatus } from "../../api";
import {
  GIT_PANE_HEADER_PX,
  GIT_PANE_MIN_PX,
  GIT_SPLIT_DEFAULT,
  aheadBehindLabel,
  clampSplitFraction,
  commitFileLetter,
  commitPlan,
  discardMessage,
  dragSplitFraction,
  fractionToPx,
  groupStatus,
  letterTone,
  localNameForRemote,
  parseCommitRefs,
  parseSplitFraction,
  pathInFolder,
  pxToFraction,
  relativeTime,
  resolvePaneLayout,
  splitPath,
  stagePaths,
  statusLetter,
  unstagePaths,
} from "./gitHelpers";

function f(path: string, over: Partial<GitFileStatus> = {}): GitFileStatus {
  return { path, index: "", worktree: "", untracked: false, conflicted: false, ...over };
}

describe("groupStatus", () => {
  const files = [
    f("z.txt", { worktree: "M" }),
    f("both.ts", { index: "M", worktree: "M" }),
    f("new.ts", { index: "A" }),
    f("conf.ts", { index: "U", worktree: "U", conflicted: true }),
    f("dir/u.txt", { worktree: "?", untracked: true }),
    f("gone.ts", { index: "D" }),
    f("renamed.ts", { index: "R", origPath: "old.ts" }),
    f("removed.ts", { worktree: "D" }),
  ];
  const groups = groupStatus(files);
  const paths = (id: keyof typeof groups) => groups[id].map((r) => `${r.letter} ${r.file.path}`);

  it("sorts conflicts, staged and changed (modified + untracked) by path", () => {
    expect(paths("conflicts")).toEqual(["U conf.ts"]);
    expect(paths("staged")).toEqual(["M both.ts", "D gone.ts", "A new.ts", "R renamed.ts"]);
    expect(paths("changed")).toEqual(["M both.ts", "? dir/u.txt", "D removed.ts", "M z.txt"]);
  });

  it("keeps a file that is staged and changed in both groups with distinct keys", () => {
    const keys = [...groups.staged, ...groups.changed].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(groups.staged[0].key).toBe("staged:both.ts");
    expect(groups.changed[0].key).toBe("changed:both.ts");
  });

  it("keeps conflicted files out of the other groups", () => {
    expect([...groups.staged, ...groups.changed].some((r) => r.file.conflicted)).toBe(false);
  });

  it("returns empty groups for a clean tree", () => {
    expect(groupStatus([])).toEqual({ conflicts: [], staged: [], changed: [] });
  });
});

describe("status letters and colours", () => {
  it("maps git codes to VS Code letters", () => {
    expect(statusLetter(f("a", { index: "T" }), "staged")).toBe("M");
    expect(statusLetter(f("a", { index: "C" }), "staged")).toBe("C");
    expect(statusLetter(f("a", { worktree: "A" }), "changed")).toBe("A");
    expect(statusLetter(f("a", { untracked: true, worktree: "?" }), "changed")).toBe("?");
    expect(statusLetter(f("a", { untracked: true, worktree: "?" }), "staged")).toBeNull();
    expect(statusLetter(f("a", { index: "M" }), "changed")).toBeNull();
    expect(statusLetter(f("a", { index: "A", worktree: "U", conflicted: true }), "conflicts")).toBe("U");
    expect(statusLetter(f("a", { index: "A", worktree: "U", conflicted: true }), "staged")).toBeNull();
  });

  it("colours letters like VS Code", () => {
    expect(letterTone("M")).toBe("modified");
    expect(letterTone("A")).toBe("added");
    expect(letterTone("D")).toBe("deleted");
    expect(letterTone("R")).toBe("renamed");
    expect(letterTone("U")).toBe("conflict");
    expect(letterTone("?")).toBe("untracked");
  });
});

describe("aheadBehindLabel", () => {
  it("shows only the non-zero directions", () => {
    expect(aheadBehindLabel(2, 1)).toBe("↑2 ↓1");
    expect(aheadBehindLabel(3, 0)).toBe("↑3");
    expect(aheadBehindLabel(0, 4)).toBe("↓4");
    expect(aheadBehindLabel(0, 0)).toBe("");
  });
});

describe("paths", () => {
  it("splits a path into name and folder", () => {
    expect(splitPath("src/components/App.tsx")).toEqual({ name: "App.tsx", dir: "src/components" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });

  it("includes a rename's old path when unstaging", () => {
    const { staged } = groupStatus([f("b.ts", { index: "R", origPath: "a.ts" }), f("c.ts", { index: "M" })]);
    expect(unstagePaths(staged)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(stagePaths(staged)).toEqual(["b.ts", "c.ts"]);
  });

  it("maps repository paths into the opened folder", () => {
    expect(pathInFolder("src/a.ts", "")).toBe("src/a.ts");
    expect(pathInFolder("src/a.ts", "src/")).toBe("a.ts");
    expect(pathInFolder("docs/a.md", "src/")).toBeNull();
  });

  it("drops the remote from a remote branch name", () => {
    expect(localNameForRemote("origin/feature/x")).toBe("feature/x");
    expect(localNameForRemote("main")).toBe("main");
  });
});

describe("discardMessage", () => {
  const rows = groupStatus([
    f("src/a.ts", { worktree: "M" }),
    f("b.txt", { worktree: "?", untracked: true }),
  ]).changed;

  it("names a single file and says where untracked files go", () => {
    const tracked = rows.find((r) => !r.file.untracked)!;
    const untracked = rows.find((r) => r.file.untracked)!;
    expect(discardMessage([tracked])).toBe("'a.ts'의 변경을 되돌릴까요? 되돌린 내용은 복구할 수 없어요.");
    expect(discardMessage([untracked])).toBe("'b.txt'의 변경을 되돌릴까요? 파일은 휴지통으로 옮겨요.");
  });

  it("counts several files", () => {
    expect(discardMessage(rows)).toBe(
      "변경 2개를 되돌릴까요? 되돌린 내용은 복구할 수 없어요. 추적하지 않는 파일 1개는 휴지통으로 옮겨요.",
    );
  });
});

describe("commitPlan", () => {
  it("commits staged changes, offers to stage everything, or reports nothing", () => {
    expect(commitPlan(groupStatus([f("a", { index: "M" })]), false)).toBe("commit");
    expect(commitPlan(groupStatus([f("a", { worktree: "M" })]), false)).toBe("askStageAll");
    expect(commitPlan(groupStatus([]), false)).toBe("nothing");
    // Amending with nothing staged just rewords the last commit.
    expect(commitPlan(groupStatus([f("a", { worktree: "M" })]), true)).toBe("commit");
  });
});

describe("commit history helpers", () => {
  it("maps commit file statuses to display letters", () => {
    expect(commitFileLetter("A")).toBe("A");
    expect(commitFileLetter("M")).toBe("M");
    expect(commitFileLetter("D")).toBe("D");
    expect(commitFileLetter("R")).toBe("R");
    expect(commitFileLetter("R100")).toBe("R");
    expect(commitFileLetter("T")).toBe("M");
    expect(commitFileLetter("X")).toBe("M");
  });

  it("parses %D ref decorations into typed badges", () => {
    expect(parseCommitRefs(["HEAD -> main", "origin/main", "origin/HEAD", "tag: v1.0", "feat/x"])).toEqual([
      { label: "main", kind: "head", current: true },
      { label: "origin/main", kind: "remote", current: false },
      { label: "v1.0", kind: "tag", current: false },
      { label: "feat/x", kind: "branch", current: false },
    ]);
    expect(parseCommitRefs(["HEAD", "upstream/dev"], ["origin", "upstream"])).toEqual([
      { label: "HEAD", kind: "head", current: true },
      { label: "upstream/dev", kind: "remote", current: false },
    ]);
  });

  it("formats relative time in Korean", () => {
    const now = 1_700_000_000 * 1000;
    const sec = 1_700_000_000;
    expect(relativeTime(sec + 30, now)).toBe("방금 전");
    expect(relativeTime(sec - 45, now)).toBe("방금 전");
    expect(relativeTime(sec - 60 * 5, now)).toBe("5분 전");
    expect(relativeTime(sec - 3600 * 3, now)).toBe("3시간 전");
    expect(relativeTime(sec - 86400 * 4, now)).toBe("4일 전");
    expect(relativeTime(sec - 86400 * 65, now)).toBe("2개월 전");
    expect(relativeTime(sec - 86400 * 400, now)).toBe("1년 전");
  });
});

describe("git pane split math", () => {
  it("parses stored split fractions and falls back to 0.5 on invalid input", () => {
    expect(parseSplitFraction("0.35")).toBe(0.35);
    expect(parseSplitFraction(0.75)).toBe(0.75);
    expect(parseSplitFraction("-0.2")).toBe(0);
    expect(parseSplitFraction("1.8")).toBe(1);
    expect(parseSplitFraction("")).toBe(GIT_SPLIT_DEFAULT);
    expect(parseSplitFraction("   ")).toBe(GIT_SPLIT_DEFAULT);
    expect(parseSplitFraction("nope")).toBe(GIT_SPLIT_DEFAULT);
    expect(parseSplitFraction(null)).toBe(GIT_SPLIT_DEFAULT);
    expect(parseSplitFraction(undefined)).toBe(GIT_SPLIT_DEFAULT);
    expect(parseSplitFraction(NaN)).toBe(GIT_SPLIT_DEFAULT);
  });

  it("clamps split fraction so each pane keeps at least minPanePx", () => {
    // 400px available with 80px min => [0.2, 0.8]
    expect(clampSplitFraction(0.5, 400, 80)).toBe(0.5);
    expect(clampSplitFraction(0.05, 400, 80)).toBeCloseTo(0.2);
    expect(clampSplitFraction(0.95, 400, 80)).toBeCloseTo(0.8);
    expect(clampSplitFraction(NaN, 400, 80)).toBe(0.5);

    // Too small to fit two minimums => splits evenly
    expect(clampSplitFraction(0.1, 160, 80)).toBe(0.5);
    expect(clampSplitFraction(0.9, 100, 80)).toBe(0.5);

    // Unmeasured container => clamps to [0, 1]
    expect(clampSplitFraction(0.3, 0, 80)).toBe(0.3);
    expect(clampSplitFraction(-1, 0, 80)).toBe(0);
    expect(clampSplitFraction(2, 0, 80)).toBe(1);
  });

  it("converts between fraction and px cleanly", () => {
    expect(fractionToPx(0.25, 400)).toBe(100);
    expect(fractionToPx(0.5, 0)).toBe(0);
    expect(fractionToPx(-0.5, 400)).toBe(0);
    expect(fractionToPx(1.5, 400)).toBe(400);
    expect(fractionToPx(NaN, 400)).toBe(200);

    expect(pxToFraction(100, 400)).toBe(0.25);
    expect(pxToFraction(-20, 400)).toBe(0);
    expect(pxToFraction(500, 400)).toBe(1);
    expect(pxToFraction(100, 0)).toBe(GIT_SPLIT_DEFAULT);
    expect(pxToFraction(NaN, 400)).toBe(GIT_SPLIT_DEFAULT);
  });

  it("computes dragged fractions and respects bounds", () => {
    // 400px available, starting at 0.5 (200px), drag down 40px => 240/400 = 0.6
    expect(dragSplitFraction(0.5, 40, 400, 80)).toBeCloseTo(0.6);
    // Drag way up => clamped to 80/400 = 0.2
    expect(dragSplitFraction(0.5, -500, 400, 80)).toBeCloseTo(0.2);
    // Drag way down => clamped to 320/400 = 0.8
    expect(dragSplitFraction(0.5, 500, 400, 80)).toBeCloseTo(0.8);
    // Unmeasured container => preserves clamped start fraction
    expect(dragSplitFraction(0.35, 50, 0, 80)).toBe(0.35);
  });

  it("applies collapse rules and preserves the saved fraction", () => {
    // Both expanded: splitter visible, heights sum to total - splitterPx
    const bothOpen = resolvePaneLayout({
      totalHeight: 401,
      fraction: 0.3,
      topOpen: true,
      bottomOpen: true,
    });
    expect(bothOpen.splitterVisible).toBe(true);
    expect(bothOpen.fraction).toBeCloseTo(0.3);
    expect(bothOpen.topHeight).toBeCloseTo(120);
    expect(bothOpen.bottomHeight).toBeCloseTo(280);

    // Both expanded with extreme fraction => clamped to GIT_PANE_MIN_PX
    const clampedOpen = resolvePaneLayout({
      totalHeight: 401,
      fraction: 0.01,
      topOpen: true,
      bottomOpen: true,
    });
    expect(clampedOpen.topHeight).toBeCloseTo(GIT_PANE_MIN_PX);
    expect(clampedOpen.bottomHeight).toBeCloseTo(400 - GIT_PANE_MIN_PX);

    // Top collapsed: top stays at header height, bottom takes the rest, fraction preserved
    const topCollapsed = resolvePaneLayout({
      totalHeight: 400,
      fraction: 0.3,
      topOpen: false,
      bottomOpen: true,
    });
    expect(topCollapsed).toEqual({
      topHeight: GIT_PANE_HEADER_PX,
      bottomHeight: 400 - GIT_PANE_HEADER_PX,
      fraction: 0.3,
      splitterVisible: false,
    });

    // Bottom collapsed: bottom stays at header height, top takes the rest, fraction preserved
    const bottomCollapsed = resolvePaneLayout({
      totalHeight: 400,
      fraction: 0.7,
      topOpen: true,
      bottomOpen: false,
    });
    expect(bottomCollapsed).toEqual({
      topHeight: 400 - GIT_PANE_HEADER_PX,
      bottomHeight: GIT_PANE_HEADER_PX,
      fraction: 0.7,
      splitterVisible: false,
    });

    // Both collapsed: each stays at header height, splitter hidden
    const bothCollapsed = resolvePaneLayout({
      totalHeight: 400,
      fraction: 0.4,
      topOpen: false,
      bottomOpen: false,
    });
    expect(bothCollapsed).toEqual({
      topHeight: GIT_PANE_HEADER_PX,
      bottomHeight: GIT_PANE_HEADER_PX,
      fraction: 0.4,
      splitterVisible: false,
    });
  });
});
