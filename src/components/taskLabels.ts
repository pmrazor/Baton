import { createContext } from "react";
import { isLimitError } from "../handoff";
import { isTaskActive, type Session, type TaskInfo, type TaskStatus, type TaskUsage, type Team } from "../types";

/** Provides the current teams list to nested task views without threading extra props through ChatView. */
export const TeamsContext = createContext<Team[]>([]);

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: string }> = {
  queued: { label: "대기열", tone: "lock" },
  starting: { label: "시작 중", tone: "run" },
  waiting_lock: { label: "대기", tone: "lock" },
  running: { label: "실행 중", tone: "run" },
  done: { label: "완료", tone: "done" },
  failed: { label: "실패", tone: "fail" },
  cancelled: { label: "중단됨", tone: "lock" },
};

export const LIMIT_FAILED_LABEL = "한도 때문에 중단됨";
export const DISCARDED_EMPTY_LABEL = "변경 없이 정리됨";
export const DISCARDED_CHANGES_LABEL = "변경을 버렸어요";

/** Format a token count compactly: `<1000` as is, then `"1.2k"`, `"120k"`, `"1.3M"`. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 999_500) {
    if (v < 9_950) {
      const tenths = Math.round(v / 100);
      return tenths % 10 === 0 ? `${tenths / 10}k` : `${(tenths / 10).toFixed(1)}k`;
    }
    return `${Math.round(v / 1000)}k`;
  }
  if (v < 9_950_000) {
    const tenths = Math.round(v / 100_000);
    return tenths % 10 === 0 ? `${tenths / 10}M` : `${(tenths / 10).toFixed(1)}M`;
  }
  return `${Math.round(v / 1_000_000)}M`;
}

/** Compact token line and exact-number tooltip for a TaskCard row; null when unreported. */
export function formatTaskUsage(usage: TaskUsage | null | undefined): { label: string; title: string } | null {
  if (!usage) return null;
  const cachedLabel = usage.cachedReadTokens > 0 ? ` · 캐시 ${formatTokens(usage.cachedReadTokens)}` : "";
  const cachedTitle =
    usage.cachedReadTokens > 0 ? ` · 캐시 ${usage.cachedReadTokens.toLocaleString("ko-KR")}` : "";
  return {
    label: `토큰 입력 ${formatTokens(usage.inputTokens)} · 출력 ${formatTokens(usage.outputTokens)}${cachedLabel}`,
    title: `토큰 입력 ${usage.inputTokens.toLocaleString("ko-KR")} · 출력 ${usage.outputTokens.toLocaleString("ko-KR")}${cachedTitle}`,
  };
}

/** Whether a task ended in failure because of a usage / rate limit. */
export function isLimitFailed(task: TaskInfo): boolean {
  if (task.status !== "failed") return false;
  if (task.limitHit) {
    // If a task was reassigned earlier for a limit and later failed for an unrelated reason,
    // treat it as a limit failure only when the error itself is a limit error (or absent).
    if (task.reassigned?.length && task.error) return isLimitError(task.error);
    return true;
  }
  return Boolean(task.error && isLimitError(task.error));
}

/** Map member ids to display names from teams (preferring the lead's team) and task records. */
export function memberNameMap(teams?: Team[], tasks?: TaskInfo[], teamId?: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const team of teams ?? []) {
    for (const m of team.members) names.set(m.id, m.name);
  }
  const preferred = teamId
    ? teams?.find((t) => t.id === teamId)
    : tasks?.length
      ? teams?.find((team) =>
          tasks.some((task) => team.members.some((m) => m.id === task.memberId && m.name === task.memberName)),
        )
      : undefined;
  for (const m of preferred?.members ?? []) names.set(m.id, m.name);
  for (const task of tasks ?? []) {
    if (task.memberId && task.memberName) names.set(task.memberId, task.memberName);
  }
  return names;
}

/**
 * Format automatic limit-fallback notes (e.g. `"a → b (usage limit)"`) into a
 * short Korean line like `"한도로 A → B로 넘김"`, mapping member ids to names
 * when available.
 */
export function formatReassigned(
  reassigned: readonly string[] | undefined,
  names?: ReadonlyMap<string, string>,
): string | null {
  if (!reassigned || reassigned.length === 0) return null;
  const label = (id: string) => names?.get(id) ?? id;
  const pairs: [string, string][] = [];
  for (const raw of reassigned) {
    const cleaned = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const parts = cleaned.split(/\s*→\s*/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return `한도로 넘김 (${reassigned.join(", ")})`;
    }
    pairs.push([parts[0], parts[1]]);
  }
  // Chain consecutive switches ("a → b", "b → c" => "A → B → C").
  const chains: string[][] = [];
  for (const [from, to] of pairs) {
    const last = chains.at(-1);
    if (last && last.at(-1) === from) {
      last.push(to);
    } else {
      chains.push([from, to]);
    }
  }
  const path = chains.map((c) => c.map(label).join(" → ")).join(", ");
  return `한도로 ${path}로 넘김`;
}

/** "2개 병합됨 · 3개 남음" once some of a task's files were merged on their own. */
export function mergeProgress(t: TaskInfo): string | null {
  const merged = t.merged?.length ?? 0;
  if (merged === 0) return null;
  return t.changes.length > 0 ? `${merged}개 병합됨 · ${t.changes.length}개 남음` : `${merged}개 병합됨`;
}

/**
 * Whether the task still has a worktree with unmerged files to review: pending,
 * or conflicted by a partial merge that left the rest (older conflicted tasks
 * were merged whole, so their worktree is gone).
 */
export function canReviewChanges(t: TaskInfo): boolean {
  if (!t.isolated || t.changes.length === 0) return false;
  return t.mergeState === "pending" || (t.mergeState === "conflict" && (t.merged?.length ?? 0) > 0);
}

/** One line on where an isolated (worktree) task's changes stand. */
export function mergeLine(t: TaskInfo, leadBusy: boolean): string | null {
  if (!t.isolated) return null;
  const progress = mergeProgress(t);
  switch (t.mergeState) {
    case "pending":
      return `${progress ?? `${t.changes.length}개 파일 변경`} · ${leadBusy ? "병합 검토 중" : "병합 대기"}`;
    case "merged":
      return "워크스페이스에 병합됨";
    case "conflict":
      return canReviewChanges(t)
        ? `충돌 ${t.conflicts.length}개 · ${progress}`
        : `충돌 ${t.conflicts.length}개 · 워크스페이스에서 해결해 주세요`;
    case "discarded":
      if (t.changes.length === 0) return DISCARDED_EMPTY_LABEL;
      return progress ? `${t.merged!.length}개 병합됨 · 나머지는 버렸어요` : DISCARDED_CHANGES_LABEL;
    case "none":
      return "바뀐 파일 없음";
    default:
      return "별도 작업 폴더에서 진행";
  }
}

/** Badge label and tone for a TaskCard row. */
export function taskStatusBadge(t: TaskInfo, waitingPermission: boolean): { label: string; tone: string } {
  if (waitingPermission) return { label: "권한 요청", tone: "wait" };
  if (isLimitFailed(t)) return { label: LIMIT_FAILED_LABEL, tone: "warn" };
  return TASK_STATUS[t.status];
}

/** Secondary description line for a TaskCard row. */
export function taskSubLine(t: TaskInfo, leadBusy: boolean): string {
  if (t.status === "waiting_lock") return "다른 작업이 파일을 수정 중이라 기다려요";
  if (isLimitFailed(t)) {
    if (t.isolated && (t.mergeState === "discarded" || t.mergeState === "pending" || t.mergeState === "merged" || t.mergeState === "conflict")) {
      return mergeLine(t, leadBusy)!;
    }
    return LIMIT_FAILED_LABEL;
  }
  if (t.status === "failed" && t.error) return t.error;
  return mergeLine(t, leadBusy) ?? (t.writes ? "파일 수정 작업" : "읽기 전용 작업");
}

/** Status colour of a task chat dot in the sidebar and rail. */
export function taskTone(lead: Session, child: Session, waiting: Set<string>): string {
  const task = lead.tasks?.find((t) => t.id === child.parent?.taskId);
  if (waiting.has(child.key)) return "wait";
  if (task?.status === "running" || task?.status === "starting" || child.busy) return "run";
  if (task?.status === "done") return "done";
  if (task && isLimitFailed(task)) return "warn";
  if (task?.status === "failed") return "fail";
  return "idle";
}

/** "README 갱신 · 실행 중": a task chat's title, status, and limit/reassignment note. */
export function taskLabel(lead: Session, child: Session, waiting: Set<string>, teams?: Team[]): string {
  const task = lead.tasks?.find((t) => t.id === child.parent?.taskId);
  const parts: string[] = [child.title];
  if (waiting.has(child.key)) {
    parts.push("권한 요청");
  } else if (task) {
    if (isLimitFailed(task)) {
      parts.push(LIMIT_FAILED_LABEL);
      if (task.isolated && task.mergeState === "discarded") {
        parts.push(task.changes.length === 0 ? DISCARDED_EMPTY_LABEL : DISCARDED_CHANGES_LABEL);
      }
    } else if (task.mergeState === "pending" && !isTaskActive(task.status)) {
      parts.push("병합 대기");
    } else if (task.isolated && task.mergeState === "discarded" && !isTaskActive(task.status)) {
      parts.push(task.changes.length === 0 ? DISCARDED_EMPTY_LABEL : DISCARDED_CHANGES_LABEL);
    } else {
      const state = TASK_STATUS[task.status]?.label;
      if (state) parts.push(state);
    }
  }
  if (task?.reassigned?.length) {
    const names = memberNameMap(teams, lead.tasks, lead.lead?.teamId);
    const note = formatReassigned(task.reassigned, names);
    if (note) parts.push(note);
  }
  return parts.join(" · ");
}
