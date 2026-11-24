import { describe, expect, it } from "vitest";
import { accountLimit, HANDOFF_BRIEF_LABEL, handoffMemo, isLimitError, leadLimit } from "./handoff";
import { initialState, reducer, type Action, type State } from "./store";
import type { AccountUsage, ChatItem, Session, TaskInfo } from "./types";

const run = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);

const makeSession = (patch: Partial<Session> = {}): Session => ({
  key: "claude:old",
  agentId: "claude",
  sessionId: "old",
  cwd: "/work",
  title: "로그인 버그 수정",
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

const makeTask = (id: string, patch: Partial<TaskInfo> = {}): TaskInfo => ({
  id,
  leadAgentId: "claude",
  leadSessionId: "old",
  title: `Task ${id}`,
  memberId: "codex-mid",
  memberName: "Codex",
  agentId: "codex",
  sessionId: `sub-${id}`,
  status: "done",
  writes: true,
  startedAt: 100,
  endedAt: 200,
  error: null,
  isolated: true,
  changes: ["M src/auth.ts"],
  mergeState: "pending",
  conflicts: [],
  ...patch,
});

describe("isLimitError", () => {
  it("matches known usage and rate limit messages case-insensitively", () => {
    const hits = [
      "You've hit your 5-hour limit · resets 1:30am",
      "HIT YOUR weekly LIMIT",
      "Monthly usage limit reached",
      "Rate limit exceeded, try again later",
      "Error: UsageLimitExceeded",
      "RateLimitExceeded: slow down",
      "RESOURCE_EXHAUSTED: no tokens left",
      "Quota exceeded for model",
      "HTTP 429 Too Many Requests",
      "status=429",
      "429",
    ];
    for (const msg of hits) {
      expect(isLimitError(msg), msg).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    const misses = [
      "Network timeout",
      "Authentication required",
      "You've hit your keyboard",
      "Memory limit is fine",
      "Process exited on port 4290",
      "Line 1429 failed",
    ];
    for (const msg of misses) {
      expect(isLimitError(msg), msg).toBe(false);
    }
  });
});

describe("accountLimit and leadLimit", () => {
  const now = 1_000_000;
  const usage = (entries: AccountUsage["entries"]): AccountUsage => ({ entries, updatedAt: now });

  it("detects active limits with future or unknown resetsAt, ignoring past ones", () => {
    expect(accountLimit(undefined, now)).toBeNull();
    expect(accountLimit(usage({ a: { id: "a", label: "5h", status: "ok" } }), now)).toBeNull();
    expect(accountLimit(usage({ a: { id: "a", label: "5h", status: "limited", resetsAt: now - 1 } }), now)).toBeNull();
    expect(accountLimit(usage({ a: { id: "a", label: "5h", status: "limited" } }), now)).toEqual({ resetsAt: undefined });
    expect(
      accountLimit(
        usage({
          a: { id: "a", label: "5h", status: "limited", resetsAt: now + 5000 },
          b: { id: "b", label: "7d", status: "limited", resetsAt: now + 9000 },
        }),
        now,
      ),
    ).toEqual({ resetsAt: now + 9000 });
  });

  it("only flags non-draft lead sessions and respects dismissal and handoff", () => {
    const limitedUsage = {
      "claude/default": usage({ a: { id: "a", label: "5h", status: "limited", resetsAt: now + 60_000 } }),
    };
    expect(leadLimit(makeSession({ lead: undefined }), limitedUsage, now)).toBeNull();
    expect(leadLimit(makeSession({ draft: true }), limitedUsage, now)).toBeNull();
    expect(leadLimit(makeSession(), limitedUsage, now)).toEqual({ resetsAt: now + 60_000 });
    expect(leadLimit(makeSession({ limited: { dismissed: true } }), limitedUsage, now)).toBeNull();
    expect(leadLimit(makeSession({ handedTo: "codex:new" }), limitedUsage, now)).toBeNull();
    expect(leadLimit(makeSession({ limited: { resetsAt: undefined } }), {}, now)).toEqual({ resetsAt: undefined });
  });
});

describe("handoffMemo", () => {
  it("includes header, user messages, final answers, tasks, and footer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "Fix the login bug" },
      { kind: "thought", id: "th1", text: "secret internal thought" },
      { kind: "assistant", id: "a1-interim", text: "Let me check..." },
      { kind: "assistant", id: "a1-final", text: "I delegated the fix to Codex." },
      { kind: "user", id: "u2", text: "Also add unit tests" },
    ];
    const tasks: TaskInfo[] = [
      makeTask("r1-1", {
        title: "Fix auth token",
        memberName: "Codex",
        status: "done",
        mergeState: "pending",
        changes: ["M src/auth.ts", "A src/auth.test.ts"],
      }),
      makeTask("r1-2", {
        title: "Check API",
        memberName: "DeepSeek",
        status: "failed",
        mergeState: null,
        changes: [],
        error: "connection refused",
      }),
    ];
    const memo = handoffMemo(makeSession({ items, tasks }), "Claude Code");

    expect(memo).toContain(
      "[Baton handoff — note from the app] The previous lead (Claude Code) hit its usage limit. You are taking over this conversation with the same team.",
    );
    expect(memo).toContain("User: Fix the login bug");
    expect(memo).toContain("Lead: I delegated the fix to Codex.");
    expect(memo).not.toContain("secret internal thought");
    expect(memo).not.toContain("Let me check...");
    expect(memo).toContain("User: Also add unit tests");

    expect(memo).toContain("r1-1");
    expect(memo).toContain("Fix auth token");
    expect(memo).toContain("Codex");
    expect(memo).toContain("mergeState: pending");
    expect(memo).toContain("M src/auth.ts, A src/auth.test.ts");
    expect(memo).toContain("r1-2");
    expect(memo).toContain("error: connection refused");
    expect(memo).toContain("get_result");
    expect(memo).toContain("wait");
    expect(memo).toContain("merge_task");
    expect(memo).toContain(
      "Start by calling list_agents and checking unfinished tasks, then continue the user's request. First reply to the user in Korean, briefly saying what you picked up.",
    );
  });

  it("truncates long individual messages to about 1500 characters", () => {
    const longUser = "U".repeat(3000);
    const longAnswer = "A".repeat(3000);
    const memo = handoffMemo(
      makeSession({
        items: [
          { kind: "user", id: "u1", text: longUser },
          { kind: "assistant", id: "a1", text: longAnswer },
        ],
      }),
      "Claude Code",
    );
    expect(memo).not.toContain("U".repeat(1600));
    expect(memo).not.toContain("A".repeat(1600));
    expect(memo).toContain("… [truncated]");
  });

  it("keeps the most recent turns under 24,000 characters and reports omitted turns", () => {
    const items: ChatItem[] = [];
    for (let i = 1; i <= 25; i++) {
      items.push({ kind: "user", id: `u${i}`, text: `Turn ${i} user: ${"x".repeat(1200)}` });
      items.push({ kind: "assistant", id: `a${i}`, text: `Turn ${i} answer: ${"y".repeat(1200)}` });
    }
    const memo = handoffMemo(makeSession({ items }), "Claude Code");

    expect(memo.length).toBeLessThanOrEqual(24_000);
    expect(memo).toMatch(/\(\d+ earlier turns omitted\)/);
    expect(memo).toContain("Turn 25 user:");
    expect(memo).toContain("Turn 25 answer:");
    expect(memo).not.toContain("Turn 1 user:");
  });
});

describe("handoff reducer actions", () => {
  const created = (agentId: string, sessionId: string, extra: Partial<Extract<Action, { type: "sessionCreated" }>> = {}): Action => ({
    type: "sessionCreated",
    agentId,
    sessionId,
    cwd: "/work",
    title: "새 대화",
    launch: {},
    configOptions: [],
    modes: null,
    lead: { teamId: "auto" },
    ...extra,
  });

  const get = (state: State, key: string) => {
    const s = state.sessions.find((x) => x.key === key);
    if (!s) throw new Error(`missing session ${key}`);
    return s;
  };

  it("moves tasks to the new lead, updates child parents, links both chats, and attaches brief turnId", () => {
    let state = run(
      initialState,
      created("claude", "old"),
      { type: "userMessage", key: "claude:old", text: "로그인 버그 수정해 줘" },
      {
        type: "taskSession",
        event: {
          task: makeTask("t1", { sessionId: "sub1", status: "running" }),
          session: { agentId: "dsh", sessionId: "sub1", cwd: "/wt", launch: {}, configOptions: null, modes: null },
          brief: "Investigate auth",
        },
      },
      { type: "sessionLimited", key: "claude:old", resetsAt: 999999 },
      created("codex", "new"),
      { type: "handoff", fromKey: "claude:old", toKey: "codex:new", toAgentName: "Codex" },
    );

    const oldS = get(state, "claude:old");
    const newS = get(state, "codex:new");
    const subS = get(state, "dsh:sub1");

    expect(oldS.tasks).toEqual([]);
    expect(oldS.handedTo).toBe("codex:new");
    expect(oldS.limited?.dismissed).toBe(true);
    const notice = oldS.items.at(-1);
    expect(notice).toMatchObject({
      kind: "notice",
      text: "새 총괄(Codex)로 넘겼어요",
      tone: "info",
      link: { key: "codex:new", label: "새 대화 열기" },
    });

    expect(newS.handedFrom).toBe("claude:old");
    expect(newS.title).toBe("로그인 버그 수정해 줘");
    expect(newS.draft).toBe(false);
    expect(newS.tasks).toHaveLength(1);
    expect(newS.tasks?.[0]).toMatchObject({ id: "t1", leadAgentId: "codex", leadSessionId: "new" });
    expect(subS.parent).toEqual({ key: "codex:new", taskId: "t1" });

    // Sending the handoff memo creates a brief item, keeps the inherited title, and binds moved tasks to it.
    state = run(state, {
      type: "userMessage",
      key: "codex:new",
      text: "[Baton handoff — note from the app] ...",
      briefLabel: HANDOFF_BRIEF_LABEL,
    });
    const afterBrief = get(state, "codex:new");
    expect(afterBrief.title).toBe("로그인 버그 수정해 줘");
    expect(afterBrief.items[0]).toMatchObject({
      kind: "brief",
      label: HANDOFF_BRIEF_LABEL,
      text: "[Baton handoff — note from the app] ...",
    });
    expect(afterBrief.tasks?.[0].turnId).toBe(afterBrief.items[0].id);

    // New tasks delegated during the handoff brief turn also attach to the brief turn.
    state = run(state, {
      type: "taskUpdate",
      task: makeTask("t2", { leadAgentId: "codex", leadSessionId: "new", status: "queued" }),
    });
    expect(get(state, "codex:new").tasks?.find((t) => t.id === "t2")?.turnId).toBe(afterBrief.items[0].id);
  });

  it("clears session.limited on turnDone and tracks dismiss until next limit error", () => {
    let state = run(
      initialState,
      created("claude", "old"),
      { type: "userMessage", key: "claude:old", text: "hi" },
      { type: "sessionLimited", key: "claude:old", resetsAt: 5000 },
    );
    expect(get(state, "claude:old").limited).toEqual({ resetsAt: 5000 });

    state = run(state, { type: "dismissLimited", key: "claude:old" });
    expect(get(state, "claude:old").limited).toEqual({ resetsAt: 5000, dismissed: true });

    state = run(state, { type: "sessionLimited", key: "claude:old" });
    expect(get(state, "claude:old").limited?.dismissed).toBeUndefined();

    state = run(state, { type: "turnDone", key: "claude:old", stats: { durationMs: 100 } });
    expect(get(state, "claude:old").limited).toBeUndefined();
  });

  it("deduplicates tasks if taskUpdate arrives on the new lead before handoff", () => {
    const state = run(
      initialState,
      created("claude", "old"),
      { type: "userMessage", key: "claude:old", text: "work" },
      { type: "taskUpdate", task: makeTask("t1", { status: "running" }) },
      created("codex", "new"),
      { type: "taskUpdate", task: makeTask("t1", { leadAgentId: "codex", leadSessionId: "new", status: "done" }) },
      { type: "handoff", fromKey: "claude:old", toKey: "codex:new", toAgentName: "Codex" },
    );
    expect(get(state, "claude:old").tasks).toEqual([]);
    expect(get(state, "codex:new").tasks).toHaveLength(1);
    expect(get(state, "codex:new").tasks?.[0].status).toBe("done");
  });
});
