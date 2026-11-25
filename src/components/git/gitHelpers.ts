import type { GitFileStatus } from "../../api";

/** Change groups in the 깃 panel, in display order. */
export type GitGroupId = "conflicts" | "staged" | "changed";

export const GIT_GROUPS: readonly { id: GitGroupId; label: string }[] = [
  { id: "conflicts", label: "충돌" },
  { id: "staged", label: "스테이징됨" },
  { id: "changed", label: "변경됨" },
];

export type GitLetter = "M" | "A" | "D" | "R" | "C" | "U" | "?";
export type GitTone = "modified" | "added" | "deleted" | "renamed" | "conflict" | "untracked";

export interface GitRow {
  /** Unique across groups (a file can be both staged and changed). */
  key: string;
  group: GitGroupId;
  file: GitFileStatus;
  letter: GitLetter;
}

export type GitGroups = Record<GitGroupId, GitRow[]>;

export const LETTER_TITLE: Record<GitLetter, string> = {
  M: "수정됨",
  A: "추가됨",
  D: "삭제됨",
  R: "이름 바뀜",
  C: "복사됨",
  U: "충돌",
  "?": "추적하지 않음",
};

const TONES: Record<GitLetter, GitTone> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
  U: "conflict",
  "?": "untracked",
};

/** The colour family for a status letter, like VS Code's git decorations. */
export function letterTone(letter: GitLetter): GitTone {
  return TONES[letter];
}

function toLetter(code: string): GitLetter | null {
  switch (code) {
    case "M":
    case "T": // type change (file ↔ symlink) reads as a modification
      return "M";
    case "A":
    case "D":
    case "R":
    case "C":
    case "U":
    case "?":
      return code;
    default:
      return null;
  }
}

/** The letter shown on a file's row in the given group, or null when it has no change there. */
export function statusLetter(file: GitFileStatus, group: GitGroupId): GitLetter | null {
  if (group === "conflicts") return file.conflicted ? "U" : null;
  if (file.conflicted) return null;
  if (group === "staged") return toLetter(file.index);
  if (file.untracked) return "?";
  return toLetter(file.worktree);
}

/** Sort files into 충돌 / 스테이징됨 / 변경됨 (modified and untracked together), each by path. */
export function groupStatus(files: readonly GitFileStatus[]): GitGroups {
  const groups: GitGroups = { conflicts: [], staged: [], changed: [] };
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    for (const { id } of GIT_GROUPS) {
      const letter = statusLetter(file, id);
      if (letter) groups[id].push({ key: `${id}:${file.path}`, group: id, file, letter });
    }
  }
  return groups;
}

/** "↑2 ↓1", "↑2", "↓1", or "" when in sync. */
export function aheadBehindLabel(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

/** File name and its folder (`""` at the top level) of a `/`-separated path. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function stagePaths(rows: readonly GitRow[]): string[] {
  return unique(rows.map((r) => r.file.path));
}

/** Unstaging a rename restores the old path too. */
export function unstagePaths(rows: readonly GitRow[]): string[] {
  return unique(rows.flatMap((r) => (r.file.origPath ? [r.file.path, r.file.origPath] : [r.file.path])));
}

/** The confirmation shown before discarding `rows`. */
export function discardMessage(rows: readonly GitRow[]): string {
  const untracked = rows.filter((r) => r.file.untracked).length;
  if (rows.length === 1) {
    const { name } = splitPath(rows[0].file.path);
    return untracked
      ? `'${name}'의 변경을 되돌릴까요? 파일은 휴지통으로 옮겨요.`
      : `'${name}'의 변경을 되돌릴까요? 되돌린 내용은 복구할 수 없어요.`;
  }
  const head = `변경 ${rows.length}개를 되돌릴까요?`;
  if (untracked === rows.length) return `${head} 파일은 휴지통으로 옮겨요.`;
  if (untracked > 0) return `${head} 되돌린 내용은 복구할 수 없어요. 추적하지 않는 파일 ${untracked}개는 휴지통으로 옮겨요.`;
  return `${head} 되돌린 내용은 복구할 수 없어요.`;
}

/**
 * What the 커밋 button does: commit what is staged (an amend may just reword),
 * offer to stage every change first, or report that there is nothing to commit.
 */
export function commitPlan(groups: GitGroups, amend: boolean): "commit" | "askStageAll" | "nothing" {
  if (groups.staged.length > 0 || amend) return "commit";
  if (groups.changed.length > 0) return "askStageAll";
  return "nothing";
}

/** `origin/feature/x` → `feature/x`: switching to it creates a tracking branch. */
export function localNameForRemote(remoteBranch: string): string {
  const i = remoteBranch.indexOf("/");
  return i < 0 ? remoteBranch : remoteBranch.slice(i + 1);
}

/** A repository path relative to the opened folder (`prefix` from git), or null when outside it. */
export function pathInFolder(path: string, prefix: string): string | null {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Map a `git show --name-status` code (A/M/D/R/C/T…) to a display letter. */
export function commitFileLetter(status: string): GitLetter {
  return toLetter(status.slice(0, 1)) ?? "M";
}

export type CommitRefKind = "head" | "branch" | "remote" | "tag";

export interface CommitRefBadge {
  label: string;
  kind: CommitRefKind;
  /** True when this ref is the checked-out HEAD / current branch. */
  current: boolean;
}

/**
 * Parse `%D` decoration entries (e.g. `"HEAD -> main"`, `"origin/main"`, `"tag: v1.0"`)
 * into typed badges for the commit history list.
 */
export function parseCommitRefs(
  refs: readonly string[],
  remotePrefixes: readonly string[] = ["origin"],
): CommitRefBadge[] {
  const badges: CommitRefBadge[] = [];
  for (const raw of refs) {
    const r = raw.trim();
    if (!r) continue;
    if (r.startsWith("HEAD -> ")) {
      badges.push({ label: r.slice("HEAD -> ".length), kind: "head", current: true });
    } else if (r === "HEAD") {
      badges.push({ label: "HEAD", kind: "head", current: true });
    } else if (r.startsWith("tag: ")) {
      badges.push({ label: r.slice("tag: ".length), kind: "tag", current: false });
    } else if (r.endsWith("/HEAD")) {
      // Skip symbolic remote HEAD pointers like `origin/HEAD`.
      continue;
    } else if (remotePrefixes.some((p) => p && r.startsWith(`${p}/`))) {
      badges.push({ label: r, kind: "remote", current: false });
    } else {
      badges.push({ label: r, kind: "branch", current: false });
    }
  }
  return badges;
}

/** Format a Unix timestamp (seconds) as a compact Korean relative time string. */
export function relativeTime(unixSecs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSecs);
  if (diff < 60) return "방금 전";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  const years = Math.floor(days / 365);
  return `${Math.max(1, years)}년 전`;
}

export const GIT_SPLIT_DEFAULT = 0.5;
export const GIT_PANE_MIN_PX = 80;
export const GIT_PANE_HEADER_PX = 26;
export const GIT_SPLITTER_PX = 1;

/** Parse a stored split fraction (e.g. from localStorage), falling back to the default. */
export function parseSplitFraction(raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return GIT_SPLIT_DEFAULT;
  return Math.min(1, Math.max(0, value));
}

/**
 * Clamp the top pane's split fraction so both panes keep at least `minPanePx`
 * of `availableHeight`. When the container is smaller than `2 * minPanePx`,
 * split evenly (0.5). When `availableHeight <= 0`, clamp to [0, 1].
 */
export function clampSplitFraction(
  fraction: number,
  availableHeight: number,
  minPanePx = GIT_PANE_MIN_PX,
): number {
  const f = Number.isFinite(fraction) ? fraction : GIT_SPLIT_DEFAULT;
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) {
    return Math.min(1, Math.max(0, f));
  }
  const minPx = Number.isFinite(minPanePx) ? Math.max(0, minPanePx) : GIT_PANE_MIN_PX;
  if (availableHeight <= minPx * 2) return 0.5;
  const minFrac = minPx / availableHeight;
  const maxFrac = 1 - minFrac;
  return Math.min(maxFrac, Math.max(minFrac, f));
}

/** Convert a split fraction in [0, 1] to pixel height of `availableHeight`. */
export function fractionToPx(fraction: number, availableHeight: number): number {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return 0;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : GIT_SPLIT_DEFAULT;
  return f * availableHeight;
}

/** Convert a pixel height to a split fraction in [0, 1] of `availableHeight`. */
export function pxToFraction(px: number, availableHeight: number): number {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return GIT_SPLIT_DEFAULT;
  if (!Number.isFinite(px)) return GIT_SPLIT_DEFAULT;
  return Math.min(1, Math.max(0, px / availableHeight));
}

/** Compute the next clamped split fraction after moving the splitter by `deltaPx`. */
export function dragSplitFraction(
  startFraction: number,
  deltaPx: number,
  availableHeight: number,
  minPanePx = GIT_PANE_MIN_PX,
): number {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) {
    return clampSplitFraction(startFraction, 0, minPanePx);
  }
  const start = clampSplitFraction(startFraction, availableHeight, minPanePx);
  const delta = Number.isFinite(deltaPx) ? deltaPx : 0;
  const nextPx = fractionToPx(start, availableHeight) + delta;
  return clampSplitFraction(pxToFraction(nextPx, availableHeight), availableHeight, minPanePx);
}

export interface PaneLayoutInput {
  totalHeight: number;
  fraction: number;
  topOpen: boolean;
  bottomOpen: boolean;
  minPanePx?: number;
  headerPx?: number;
  splitterPx?: number;
}

export interface PaneLayout {
  topHeight: number;
  bottomHeight: number;
  /** Clamped fraction for the top pane (preserved when collapsed so re-expanding restores it). */
  fraction: number;
  splitterVisible: boolean;
}

/**
 * Resolve pixel heights and splitter visibility for the two vertical Git panes:
 * - Both expanded: splitter is active and each pane keeps at least `minPanePx`.
 * - One collapsed: collapsed pane stays at `headerPx` and the other takes the rest.
 * - Both collapsed: each pane stays at `headerPx`.
 */
export function resolvePaneLayout(input: PaneLayoutInput): PaneLayout {
  const total = Number.isFinite(input.totalHeight) ? Math.max(0, input.totalHeight) : 0;
  const minPanePx = input.minPanePx ?? GIT_PANE_MIN_PX;
  const headerPx = input.headerPx ?? GIT_PANE_HEADER_PX;
  const splitterPx = input.splitterPx ?? GIT_SPLITTER_PX;

  if (input.topOpen && input.bottomOpen) {
    const available = Math.max(0, total - splitterPx);
    const fraction = clampSplitFraction(input.fraction, available, minPanePx);
    const topHeight = fractionToPx(fraction, available);
    const bottomHeight = Math.max(0, available - topHeight);
    return { topHeight, bottomHeight, fraction, splitterVisible: true };
  }

  const preservedFraction = clampSplitFraction(input.fraction, 0, minPanePx);

  if (!input.topOpen && !input.bottomOpen) {
    return {
      topHeight: headerPx,
      bottomHeight: headerPx,
      fraction: preservedFraction,
      splitterVisible: false,
    };
  }

  if (!input.topOpen) {
    return {
      topHeight: headerPx,
      bottomHeight: Math.max(headerPx, total - headerPx),
      fraction: preservedFraction,
      splitterVisible: false,
    };
  }

  return {
    topHeight: Math.max(headerPx, total - headerPx),
    bottomHeight: headerPx,
    fraction: preservedFraction,
    splitterVisible: false,
  };
}
