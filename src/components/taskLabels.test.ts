import { describe, expect, it } from "vitest";
import type { Session, TaskInfo, Team } from "../types";
import {
  canReviewChanges,
  formatReassigned,
  formatTaskUsage,
  formatTokens,
  isLimitFailed,
  memberNameMap,
  mergeLine,
  mergeProgress,
  taskLabel,
  taskStatusBadge,
  taskSubLine,
  taskTone,
} from "./taskLabels";

const makeTask = (patch: Partial<TaskInfo> = {}): TaskInfo => ({
  id: "t1",
  leadAgentId: "claude",
  leadSessionId: "lead",
  title: "로그인 버그 수정",
  memberId: "antigravity-claude-opus-5-5",
  memberName: "Antigravity · Opus",
  agentId: "antigravity",
  sessionId: "sub-1",
  status: "done",
  writes: true,
  startedAt: 100,
  endedAt: 200,
  error: null,
  isolated: true,
  changes: [],
  mergeState: null,
  conflicts: [],
  reassigned: [],
  limitHit: false,
  ...patch,
});

const makeSession = (patch: Partial<Session> = {}): Session => ({
  key: "claude:lead",
  agentId: "claude",
  sessionId: "lead",
  cwd: "/work",
  title: "총괄 대화",
  items: [],
  busy: false,
  configOptions: [],
  modes: null,
  createdAt: 1,
  updatedAt: 1,
  draft: false,
  attached: true,
  launch: {},
  lead: { teamId: "auto" },
  tasks: [],
  usage: null,
  lastTurn: null,
  ...patch,
});

const sampleTeams: Team[] = [
  {
    id: "auto",
    name: "자동",
    maxParallel: 3,
    isolation: "worktree",
    members: [
      {
        id: "claude-opus-5-5",
        name: "Claude · Opus",
        agentId: "claude",
        profileId: "default",
        launch: {},
        config: {},
        role: "",
      },
      {
        id: "antigravity-claude-opus-5-5",
        name: "Antigravity · Opus",
        agentId: "antigravity",
        profileId: "default",
        launch: {},
        config: {},
        role: "",
      },
      {
        id: "codex-deep",
        name: "Codex · 깊게",
        agentId: "codex",
        profileId: "default",
        launch: {},
        config: {},
        role: "",
      },
    ],
  },
];

describe("mergeLine", () => {
  it("shows 변경 없이 정리됨 when discarded with no changes", () => {
    expect(mergeLine(makeTask({ mergeState: "discarded", changes: [] }), false)).toBe("변경 없이 정리됨");
  });

  it("keeps 변경을 버렸어요 when discarded with changes", () => {
    expect(mergeLine(makeTask({ mergeState: "discarded", changes: ["M src/a.ts"] }), false)).toBe("변경을 버렸어요");
  });

  it("keeps existing messages for other merge states", () => {
    expect(mergeLine(makeTask({ isolated: false, mergeState: "discarded" }), false)).toBeNull();
    expect(mergeLine(makeTask({ mergeState: "pending", changes: ["M a.ts", "M b.ts"] }), false)).toBe(
      "2개 파일 변경 · 병합 대기",
    );
    expect(mergeLine(makeTask({ mergeState: "pending", changes: ["M a.ts"] }), true)).toBe("1개 파일 변경 · 병합 검토 중");
    expect(mergeLine(makeTask({ mergeState: "merged" }), false)).toBe("워크스페이스에 병합됨");
    expect(mergeLine(makeTask({ mergeState: "none" }), false)).toBe("바뀐 파일 없음");
    expect(mergeLine(makeTask({ mergeState: "conflict", conflicts: ["src/a.ts"] }), false)).toBe(
      "충돌 1개 · 워크스페이스에서 해결해 주세요",
    );
  });
});

describe("partial merges", () => {
  const partial = (patch: Partial<TaskInfo> = {}) =>
    makeTask({ mergeState: "pending", merged: ["src/a.ts", "src/b.ts"], changes: ["M src/c.ts", "A src/d.ts", "D e.ts"], ...patch });

  it("counts merged and remaining files", () => {
    expect(mergeProgress(makeTask({ mergeState: "pending", changes: ["M a.ts"] }))).toBeNull();
    expect(mergeProgress(makeTask({ mergeState: "pending", changes: ["M a.ts"], merged: [] }))).toBeNull();
    expect(mergeProgress(partial())).toBe("2개 병합됨 · 3개 남음");
    expect(mergeProgress(partial({ mergeState: "merged", changes: [] }))).toBe("2개 병합됨");
  });

  it("shows the progress in mergeLine", () => {
    expect(mergeLine(partial(), false)).toBe("2개 병합됨 · 3개 남음 · 병합 대기");
    expect(mergeLine(partial(), true)).toBe("2개 병합됨 · 3개 남음 · 병합 검토 중");
    expect(mergeLine(partial({ mergeState: "conflict", conflicts: ["src/b.ts"] }), false)).toBe(
      "충돌 1개 · 2개 병합됨 · 3개 남음",
    );
    // The last merge removed the worktree: only the conflicts are left to deal with.
    expect(mergeLine(partial({ mergeState: "conflict", conflicts: ["src/b.ts"], changes: [] }), false)).toBe(
      "충돌 1개 · 워크스페이스에서 해결해 주세요",
    );
    expect(mergeLine(partial({ mergeState: "merged", changes: [] }), false)).toBe("워크스페이스에 병합됨");
    expect(mergeLine(partial({ mergeState: "discarded" }), false)).toBe("2개 병합됨 · 나머지는 버렸어요");
  });

  it("offers review while a worktree has unmerged files", () => {
    expect(canReviewChanges(makeTask({ mergeState: "pending", changes: ["M a.ts"] }))).toBe(true);
    expect(canReviewChanges(partial())).toBe(true);
    expect(canReviewChanges(partial({ mergeState: "conflict", conflicts: ["src/b.ts"] }))).toBe(true);
    // A whole merge with conflicts (older tasks kept their change list): the worktree is gone.
    expect(canReviewChanges(makeTask({ mergeState: "conflict", conflicts: ["a.ts"], changes: ["M a.ts"] }))).toBe(false);
    expect(canReviewChanges(makeTask({ mergeState: "pending", changes: [] }))).toBe(false);
    expect(canReviewChanges(makeTask({ isolated: false, mergeState: "pending", changes: ["M a.ts"] }))).toBe(false);
    expect(canReviewChanges(partial({ mergeState: "discarded" }))).toBe(false);
    expect(canReviewChanges(partial({ mergeState: "merged" }))).toBe(false);
  });
});

describe("formatReassigned and memberNameMap", () => {
  it("maps member ids to display names when available", () => {
    const names = memberNameMap(sampleTeams, [], "auto");
    expect(formatReassigned(["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)"], names)).toBe(
      "한도로 Claude · Opus → Antigravity · Opus로 넘김",
    );
  });

  it("chains consecutive reassignments", () => {
    const names = memberNameMap(sampleTeams, [], "auto");
    expect(
      formatReassigned(
        [
          "claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)",
          "antigravity-claude-opus-5-5 → codex-deep (usage limit)",
        ],
        names,
      ),
    ).toBe("한도로 Claude · Opus → Antigravity · Opus → Codex · 깊게로 넘김");
  });

  it("falls back to task memberName and raw ids when team info is missing", () => {
    const task = makeTask({ memberId: "antigravity-claude-opus-5-5", memberName: "Antigravity · Opus" });
    const names = memberNameMap([], [task]);
    expect(formatReassigned(["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)"], names)).toBe(
      "한도로 claude-opus-5-5 → Antigravity · Opus로 넘김",
    );
    expect(formatReassigned(["unknown-a → unknown-b (usage limit)"])).toBe("한도로 unknown-a → unknown-b로 넘김");
    expect(formatReassigned([])).toBeNull();
  });
});

describe("limit-failed status and sub line", () => {
  it("uses warning tone and limit message when failed due to a usage limit", () => {
    const t = makeTask({
      status: "failed",
      limitHit: true,
      error: "member 'claude-opus-5-5' hit its usage limit (resets 12:00 UTC)",
    });
    expect(isLimitFailed(t)).toBe(true);
    expect(taskStatusBadge(t, false)).toEqual({ label: "한도 때문에 중단됨", tone: "warn" });
    expect(taskSubLine(t, false)).toBe("한도 때문에 중단됨");
  });

  it("shows 변경 없이 정리됨 in sub line when limit-failed and discarded with no changes", () => {
    const t = makeTask({
      status: "failed",
      limitHit: true,
      mergeState: "discarded",
      changes: [],
      error: "member 'claude-opus-5-5' hit its usage limit",
    });
    expect(taskStatusBadge(t, false)).toEqual({ label: "한도 때문에 중단됨", tone: "warn" });
    expect(taskSubLine(t, false)).toBe("변경 없이 정리됨");
  });

  it("keeps error tone and message for non-limit failures", () => {
    const t = makeTask({ status: "failed", limitHit: false, error: "connection refused" });
    expect(isLimitFailed(t)).toBe(false);
    expect(taskStatusBadge(t, false)).toEqual({ label: "실패", tone: "fail" });
    expect(taskSubLine(t, false)).toBe("connection refused");
  });

  it("does not treat a reassigned task that later failed for another reason as limit-failed", () => {
    const t = makeTask({
      status: "failed",
      limitHit: true,
      reassigned: ["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)"],
      error: "connection refused",
    });
    expect(isLimitFailed(t)).toBe(false);
    expect(taskStatusBadge(t, false)).toEqual({ label: "실패", tone: "fail" });
  });
});

describe("sidebar taskTone and taskLabel", () => {
  const child = makeSession({
    key: "antigravity:sub-1",
    agentId: "antigravity",
    sessionId: "sub-1",
    title: "README 갱신",
    lead: undefined,
    parent: { key: "claude:lead", taskId: "t1" },
  });
  const emptyWait = new Set<string>();

  it("gives warning tone and limit label for limit-failed tasks", () => {
    const lead = makeSession({
      tasks: [makeTask({ status: "failed", limitHit: true, error: "member 'x' hit its usage limit" })],
    });
    expect(taskTone(lead, child, emptyWait)).toBe("warn");
    expect(taskLabel(lead, child, emptyWait, sampleTeams)).toBe("README 갱신 · 한도 때문에 중단됨");
  });

  it("gives fail tone and 실패 label for generic failures", () => {
    const lead = makeSession({
      tasks: [makeTask({ status: "failed", limitHit: false, error: "boom" })],
    });
    expect(taskTone(lead, child, emptyWait)).toBe("fail");
    expect(taskLabel(lead, child, emptyWait, sampleTeams)).toBe("README 갱신 · 실패");
  });

  it("includes reassigned member names in taskLabel", () => {
    const lead = makeSession({
      tasks: [
        makeTask({
          status: "done",
          limitHit: true,
          reassigned: ["claude-opus-5-5 → antigravity-claude-opus-5-5 (usage limit)"],
        }),
      ],
    });
    expect(taskTone(lead, child, emptyWait)).toBe("done");
    expect(taskLabel(lead, child, emptyWait, sampleTeams)).toBe(
      "README 갱신 · 완료 · 한도로 Claude · Opus → Antigravity · Opus로 넘김",
    );
  });

  it("distinguishes discarded without changes vs with changes", () => {
    const leadEmpty = makeSession({
      tasks: [makeTask({ status: "done", mergeState: "discarded", changes: [] })],
    });
    expect(taskLabel(leadEmpty, child, emptyWait, sampleTeams)).toBe("README 갱신 · 변경 없이 정리됨");

    const leadChanged = makeSession({
      tasks: [makeTask({ status: "done", mergeState: "discarded", changes: ["M README.md"] })],
    });
    expect(taskLabel(leadChanged, child, emptyWait, sampleTeams)).toBe("README 갱신 · 변경을 버렸어요");

    const leadLimitDiscarded = makeSession({
      tasks: [makeTask({ status: "failed", limitHit: true, mergeState: "discarded", changes: [] })],
    });
    expect(taskTone(leadLimitDiscarded, child, emptyWait)).toBe("warn");
    expect(taskLabel(leadLimitDiscarded, child, emptyWait, sampleTeams)).toBe(
      "README 갱신 · 한도 때문에 중단됨 · 변경 없이 정리됨",
    );
  });
});

describe("formatTokens and formatTaskUsage", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(8_000)).toBe("8k");
    expect(formatTokens(9_949)).toBe("9.9k");
    expect(formatTokens(9_950)).toBe("10k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(1_300_000)).toBe("1.3M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("formats task usage label and exact tooltip", () => {
    expect(formatTaskUsage(undefined)).toBeNull();
    expect(formatTaskUsage(null)).toBeNull();

    expect(formatTaskUsage({ inputTokens: 120_345, outputTokens: 8_120, cachedReadTokens: 0 })).toEqual({
      label: "토큰 읽음 120k · 출력 8.1k",
      title: "새로 읽음 120,345 · 출력 8,120",
    });

    // Claude-style: nearly everything read comes from the cache.
    expect(
      formatTaskUsage({ inputTokens: 18, outputTokens: 18_000, cachedReadTokens: 345_000, cachedWriteTokens: 20_000 }),
    ).toEqual({
      label: "토큰 읽음 365k (캐시 95%) · 출력 18k",
      title: "새로 읽음 18 · 캐시에서 읽음 345,000 · 캐시에 저장 20,000 · 출력 18,000",
    });
  });
});
