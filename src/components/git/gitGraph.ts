/**
 * Lane layout algorithm for the commit history graph.
 *
 * Assigns each commit (in topological order, newest first) a column (`lane`),
 * a palette color index (`color`), and the line segments to draw inside that
 * row's SVG strip.
 */

export interface GraphCommitInput {
  hash: string;
  parents: readonly string[];
}

export type GraphLineKind = "pass" | "in" | "out" | "merge-in" | "branch-out";

export interface GraphLine {
  fromLane: number;
  toLane: number;
  kind: GraphLineKind;
  color: number;
}

export interface GraphLaneColor {
  lane: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  lines: GraphLine[];
  /** Number of columns needed to draw this row (`maxLane + 1`, at least 1). */
  width: number;
  /** Active lanes leaving the bottom of this row (used to continue lines past expanded files). */
  outgoing: GraphLaneColor[];
}

interface LaneSlot {
  hash: string;
  color: number;
}

export const GRAPH_PALETTE_SIZE = 8;

function firstFreeLane(lanes: (LaneSlot | null)[]): number {
  const idx = lanes.indexOf(null);
  return idx >= 0 ? idx : lanes.length;
}

function trimTrailingNulls(lanes: (LaneSlot | null)[]): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
    lanes.pop();
  }
}

/**
 * Compute per-row lane coordinates and edge segments for a topologically
 * ordered list of commits (newest first).
 */
export function layoutCommitGraph(
  commits: readonly GraphCommitInput[],
  paletteSize = GRAPH_PALETTE_SIZE,
): GraphRow[] {
  const active: (LaneSlot | null)[] = [];
  let nextColor = 0;
  const allocColor = () => {
    const c = nextColor % paletteSize;
    nextColor++;
    return c;
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const lines: GraphLine[] = [];

    // Find every active lane waiting for this commit.
    const matching: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (active[i]?.hash === commit.hash) {
        matching.push(i);
      }
    }

    let lane: number;
    let color: number;
    if (matching.length > 0) {
      lane = matching[0];
      color = active[lane]!.color;
      lines.push({ fromLane: lane, toLane: lane, kind: "in", color });
      // Any additional lanes waiting for this commit converge into `lane` and are freed.
      for (let m = 1; m < matching.length; m++) {
        const from = matching[m];
        const fromColor = active[from]!.color;
        lines.push({ fromLane: from, toLane: lane, kind: "merge-in", color: fromColor });
        active[from] = null;
      }
    } else {
      lane = firstFreeLane(active);
      color = allocColor();
      if (lane === active.length) {
        active.push({ hash: commit.hash, color });
      } else {
        active[lane] = { hash: commit.hash, color };
      }
    }

    // Pass-through lines for every other active lane unaffected by this commit.
    for (let i = 0; i < active.length; i++) {
      const slot = active[i];
      if (slot && i !== lane) {
        lines.push({ fromLane: i, toLane: i, kind: "pass", color: slot.color });
      }
    }

    // Route edges from this commit to its parents.
    if (commit.parents.length === 0) {
      active[lane] = null;
    } else {
      const firstParent = commit.parents[0];
      const existingFirst = active.findIndex((s, i) => i !== lane && s?.hash === firstParent);
      if (existingFirst >= 0 && existingFirst < lane) {
        // First parent is already tracked in a lane further left: curve into it and free `lane`.
        lines.push({ fromLane: lane, toLane: existingFirst, kind: "branch-out", color });
        active[lane] = null;
      } else {
        // Continue first parent straight down in the same lane.
        active[lane] = { hash: firstParent, color };
        lines.push({ fromLane: lane, toLane: lane, kind: "out", color });
      }

      // Secondary parents (merges / octopus merges).
      for (let p = 1; p < commit.parents.length; p++) {
        const parentHash = commit.parents[p];
        const existing = active.findIndex((s) => s?.hash === parentHash);
        if (existing >= 0) {
          const targetColor = active[existing]!.color;
          lines.push({
            fromLane: lane,
            toLane: existing,
            kind: existing === lane ? "out" : "branch-out",
            color: targetColor,
          });
        } else {
          const targetLane = firstFreeLane(active);
          const targetColor = allocColor();
          if (targetLane === active.length) {
            active.push({ hash: parentHash, color: targetColor });
          } else {
            active[targetLane] = { hash: parentHash, color: targetColor };
          }
          lines.push({
            fromLane: lane,
            toLane: targetLane,
            kind: targetLane === lane ? "out" : "branch-out",
            color: targetColor,
          });
        }
      }
    }

    trimTrailingNulls(active);

    let maxLane = lane;
    for (const line of lines) {
      if (line.fromLane > maxLane) maxLane = line.fromLane;
      if (line.toLane > maxLane) maxLane = line.toLane;
    }

    const outgoing: GraphLaneColor[] = [];
    for (let i = 0; i < active.length; i++) {
      const slot = active[i];
      if (slot) outgoing.push({ lane: i, color: slot.color });
    }

    rows.push({
      lane,
      color,
      lines,
      width: maxLane + 1,
      outgoing,
    });
  }

  return rows;
}
