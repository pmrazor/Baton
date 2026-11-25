import { describe, expect, it } from "vitest";
import { layoutCommitGraph, type GraphCommitInput, type GraphRow } from "./gitGraph";

function c(hash: string, parents: string[] = []): GraphCommitInput {
  return { hash, parents };
}

/** Verify every outgoing lane at row `i` enters row `i + 1` on the exact same lane. */
function assertContinuous(rows: GraphRow[]) {
  for (let i = 0; i < rows.length - 1; i++) {
    const outLanes = new Set(rows[i].outgoing.map((o) => o.lane));
    const nextInLanes = new Set(
      rows[i + 1].lines
        .filter((l) => l.kind === "pass" || l.kind === "in" || l.kind === "merge-in")
        .map((l) => l.fromLane),
    );
    expect(nextInLanes, `boundary between row ${i} and ${i + 1}`).toEqual(outLanes);
  }
}

describe("layoutCommitGraph", () => {
  it("handles empty input", () => {
    expect(layoutCommitGraph([])).toEqual([]);
  });

  it("lays out a linear history in lane 0 with a single color", () => {
    const rows = layoutCommitGraph([c("c3", ["c2"]), c("c2", ["c1"]), c("c1", [])]);
    assertContinuous(rows);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.color)).toEqual([0, 0, 0]);
    expect(rows[0].lines).toEqual([{ fromLane: 0, toLane: 0, kind: "out", color: 0 }]);
    expect(rows[1].lines).toEqual([
      { fromLane: 0, toLane: 0, kind: "in", color: 0 },
      { fromLane: 0, toLane: 0, kind: "out", color: 0 },
    ]);
    expect(rows[2].lines).toEqual([{ fromLane: 0, toLane: 0, kind: "in", color: 0 }]);
    expect(rows[2].outgoing).toEqual([]);
  });

  it("lays out one branch and a merge commit (side branch first)", () => {
    // M merges A (first parent) and B (second parent); both descend from Base.
    const rows = layoutCommitGraph([
      c("M", ["A", "B"]),
      c("B", ["Base"]),
      c("A", ["Base"]),
      c("Base", []),
    ]);
    assertContinuous(rows);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // M branches out diagonally to lane 1 for second parent B.
    expect(rows[0].lines).toContainEqual({ fromLane: 0, toLane: 1, kind: "branch-out", color: 1 });
    // B passes lane 0 straight through.
    expect(rows[1].lines).toContainEqual({ fromLane: 0, toLane: 0, kind: "pass", color: 0 });
    // Base merges lane 1 back into lane 0 in the top half.
    expect(rows[3].lines).toContainEqual({ fromLane: 1, toLane: 0, kind: "merge-in", color: 1 });
    expect(rows[3].outgoing).toEqual([]);
  });

  it("lays out one branch and a merge commit (first parent first)", () => {
    const rows = layoutCommitGraph([
      c("M", ["A", "B"]),
      c("A", ["Base"]),
      c("B", ["Base"]),
      c("Base", []),
    ]);
    assertContinuous(rows);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    // B curves directly into lane 0 (already waiting for Base), freeing lane 1.
    expect(rows[2].lines).toContainEqual({ fromLane: 1, toLane: 0, kind: "branch-out", color: 1 });
    expect(rows[2].outgoing).toEqual([{ lane: 0, color: 0 }]);
    expect(rows[3].outgoing).toEqual([]);
  });

  it("lays out two parallel unmerged branches sharing a common ancestor", () => {
    const rows = layoutCommitGraph([
      c("a2", ["a1"]),
      c("b2", ["b1"]),
      c("a1", ["base"]),
      c("b1", ["base"]),
      c("base", []),
    ]);
    assertContinuous(rows);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(rows[0].color).not.toBe(rows[1].color);
    // b1 joins back to base on lane 0.
    expect(rows[3].lines).toContainEqual({ fromLane: 1, toLane: 0, kind: "branch-out", color: rows[1].color });
    expect(rows[4].lane).toBe(0);
    expect(rows[4].outgoing).toEqual([]);
  });

  it("handles an octopus merge with 3 parents", () => {
    const rows = layoutCommitGraph([
      c("oct", ["p1", "p2", "p3"]),
      c("p3", ["base"]),
      c("p2", ["base"]),
      c("p1", ["base"]),
      c("base", []),
    ]);
    assertContinuous(rows);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].lines).toEqual([
      { fromLane: 0, toLane: 0, kind: "out", color: 0 },
      { fromLane: 0, toLane: 1, kind: "branch-out", color: 1 },
      { fromLane: 0, toLane: 2, kind: "branch-out", color: 2 },
    ]);
    expect(rows[0].width).toBe(3);
    expect(rows[1].lane).toBe(2);
    expect(rows[2].lane).toBe(1);
    expect(rows[3].lane).toBe(0);
    expect(rows[4].lane).toBe(0);
    expect(rows[4].outgoing).toEqual([]);
  });

  it("frees and reuses lanes for subsequent branches", () => {
    const rows = layoutCommitGraph([
      // First branch + merge using lane 1
      c("m1", ["a1", "b1"]),
      c("a1", ["mid"]),
      c("b1", ["mid"]),
      c("mid", ["m2"]),
      // Second branch + merge should reuse lane 1 (not drift to lane 2)
      c("m2", ["a2", "b2"]),
      c("a2", ["root"]),
      c("b2", ["root"]),
      c("root", []),
    ]);
    assertContinuous(rows);
    expect(rows[2].lane).toBe(1); // b1
    expect(rows[3].lane).toBe(0); // mid
    expect(rows[3].width).toBe(1); // lane 1 was freed!
    expect(rows[4].lines).toContainEqual({ fromLane: 0, toLane: 1, kind: "branch-out", color: 2 });
    expect(rows[6].lane).toBe(1); // b2 reused lane 1
    expect(Math.max(...rows.map((r) => r.width))).toBe(2);
  });

  it("reuses a middle free lane while an outer lane stays active", () => {
    // Lane 0: main, Lane 1: short branch (finishes), Lane 2: long branch (stays active)
    // Then a new tip starts and must take freed lane 1 instead of lane 3.
    const rows = layoutCommitGraph([
      c("m", ["a1", "short", "long2"]),
      c("a1", ["a2"]),
      c("short", ["a2"]), // curves 1 -> 0, freeing lane 1 while lane 2 is still active
      c("newTip", ["a2"]), // should reuse lane 1!
      c("long2", ["a2"]),
      c("a2", []),
    ]);
    assertContinuous(rows);
    expect(rows[2].lane).toBe(1); // short
    expect(rows[3].lane).toBe(1); // newTip reused freed lane 1
    expect(rows[4].lane).toBe(2); // long2 stayed in lane 2
    expect(Math.max(...rows.map((r) => r.width))).toBe(3);
  });
});
