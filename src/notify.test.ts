import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCoalescer,
  createNotifier,
  DEFAULT_NOTIFY_SETTINGS,
  noticeTitle,
  parseNotifySettings,
  permissionNotice,
  reassignNotice,
  summarize,
  taskStalledNotice,
  taskTransitionNotice,
  truncate,
  turnNotice,
  type Notice,
  type NotifySettings,
} from "./notify";
import type { TaskInfo } from "./types";

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "t1",
    leadAgentId: "claude",
    leadSessionId: "s1",
    title: "로그인 화면 고치기",
    memberId: "m1",
    memberName: "코덱스",
    agentId: "codex",
    sessionId: "s2",
    status: "running",
    writes: true,
    startedAt: 1,
    endedAt: null,
    error: null,
    isolated: false,
    changes: [],
    mergeState: null,
    conflicts: [],
    reassigned: [],
    limitHit: false,
    ...over,
  };
}

describe("turnNotice", () => {
  it("says the reply finished", () => {
    expect(turnNotice({ stopReason: "end_turn" })).toBe("응답이 끝났어요");
  });

  it("skips turns the user stopped but reports other cancels", () => {
    expect(turnNotice({ stopReason: "cancelled" }, { userCancelled: true })).toBeNull();
    expect(turnNotice({ stopReason: "cancelled" })).toBe("응답이 중단됐어요");
  });

  it("names other stop reasons", () => {
    expect(turnNotice({ stopReason: "refusal" })).toBe("에이전트가 요청을 거절했어요");
    expect(turnNotice({ stopReason: "max_tokens" })).toBe("응답이 멈췄어요 · max_tokens");
  });

  it("shows the error, truncated", () => {
    expect(turnNotice({ error: "연결이 끊겼어요" })).toBe("연결이 끊겼어요");
    const long = turnNotice({ error: "가".repeat(300) })!;
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("truncate", () => {
  it("flattens whitespace and keeps short text", () => {
    expect(truncate("a\n  b\tc")).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("noticeTitle", () => {
  it("prefers a real title and falls back to the agent", () => {
    expect(noticeTitle("버그 수정", "Claude")).toBe("버그 수정");
    expect(noticeTitle("새 대화", "Claude")).toBe("Claude");
    expect(noticeTitle(undefined, undefined)).toBe("Baton");
  });
});

describe("permissionNotice", () => {
  it("includes the tool when known", () => {
    expect(permissionNotice({ toolCall: { title: "rm -rf build" } })).toBe("권한 확인이 필요해요: rm -rf build");
    expect(permissionNotice({ toolCall: null })).toBe("권한 확인이 필요해요");
  });
});

describe("taskTransitionNotice", () => {
  it("fires when a task finishes or fails", () => {
    expect(taskTransitionNotice(task(), task({ status: "done" }))).toBe("코덱스 · 로그인 화면 고치기 끝났어요");
    expect(taskTransitionNotice(task(), task({ status: "failed" }))).toBe("코덱스 · 로그인 화면 고치기 실패했어요");
  });

  it("fires once per transition", () => {
    const done = task({ status: "done" });
    expect(taskTransitionNotice(done, { ...done, mergeState: "pending" })).toBeNull();
  });

  it("ignores running and cancelled tasks", () => {
    expect(taskTransitionNotice(undefined, task())).toBeNull();
    expect(taskTransitionNotice(task(), task({ status: "cancelled" }))).toBeNull();
  });

  it("reports a task first seen already finished", () => {
    expect(taskTransitionNotice(undefined, task({ status: "done" }))).not.toBeNull();
  });
});

describe("reassignNotice", () => {
  it("fires when the reassignment list grows", () => {
    const moved = task({ memberName: "제미나이", reassigned: ["코덱스 → 제미나이 (usage limit)"] });
    expect(reassignNotice(task(), moved)).toBe("로그인 화면 고치기: 사용 한도로 제미나이에게 넘겼어요");
    expect(reassignNotice(moved, { ...moved, status: "done" })).toBeNull();
  });
});

describe("parseNotifySettings", () => {
  it("defaults to everything on and keeps saved choices", () => {
    expect(parseNotifySettings(null)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(parseNotifySettings({ enabled: false, task: false, turn: "nope" })).toEqual({
      ...DEFAULT_NOTIFY_SETTINGS,
      enabled: false,
      task: false,
    });
  });
});

describe("summarize", () => {
  const n = (title: string, body: string): Notice => ({ kind: "turn", title, body });

  it("passes a single notice through", () => {
    const one = n("A", "a");
    expect(summarize([one])).toBe(one);
  });

  it("merges several into one with a count", () => {
    const s = summarize([n("A", "a"), n("B", "b"), n("C", "c"), n("D", "d")]);
    expect(s.title).toBe("A 외 3건");
    expect(s.body).toBe("a\nb\nc\n…");
  });
});

describe("coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends one summary for a burst", () => {
    const deliver = vi.fn();
    const q = createCoalescer(deliver, 1500);
    q.push({ kind: "turn", title: "A", body: "a" });
    vi.advanceTimersByTime(1000);
    q.push({ kind: "task", title: "B", body: "b" });
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ title: "A 외 1건" });
    q.push({ kind: "turn", title: "C", body: "c" });
    vi.advanceTimersByTime(1500);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0]).toEqual({ kind: "turn", title: "C", body: "c" });
  });

  function setup(over: Partial<NotifySettings> = {}) {
    const send = vi.fn();
    let focused = false;
    const notifier = createNotifier({
      send,
      isFocused: () => focused,
      settings: () => ({ ...DEFAULT_NOTIFY_SETTINGS, ...over }),
      windowMs: 1500,
    });
    return { send, notifier, focus: (v: boolean) => (focused = v) };
  }

  it("never notifies while focused", () => {
    const { send, notifier, focus } = setup();
    focus(true);
    notifier.notify("turn", "A", "a");
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops the batch when the user comes back during the wait", () => {
    const { send, notifier, focus } = setup();
    notifier.notify("turn", "A", "a");
    focus(true);
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();
  });

  it("respects the master switch and per-kind toggles", () => {
    const off = setup({ enabled: false });
    off.notifier.notify("turn", "A", "a");
    const noTasks = setup({ task: false });
    noTasks.notifier.notify("task", "B", "b");
    noTasks.notifier.notify("permission", "C", "c");
    vi.advanceTimersByTime(2000);
    expect(off.send).not.toHaveBeenCalled();
    expect(noTasks.send).toHaveBeenCalledTimes(1);
    expect(noTasks.send.mock.calls[0][0]).toMatchObject({ kind: "permission", title: "C" });
  });

  it("ignores empty bodies", () => {
    const { send, notifier } = setup();
    notifier.notify("turn", "A", null);
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("taskStalledNotice", () => {
  it("fires once when a running task becomes stalled", () => {
    const stalled = task({ status: "running", stalledSince: 5 });
    expect(taskStalledNotice(task({ status: "running" }), stalled)).toBe("코덱스 · 로그인 화면 고치기: 응답이 없어요");
    expect(taskStalledNotice(stalled, { ...stalled })).toBeNull();
  });

  it("ignores tasks that are not stalled or not running", () => {
    expect(taskStalledNotice(undefined, task({ status: "running" }))).toBeNull();
    expect(taskStalledNotice(undefined, task({ status: "failed", stalledSince: 5 }))).toBeNull();
  });
});
