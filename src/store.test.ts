import { describe, expect, it } from "vitest";
import { initialState, reducer, type Action, type State } from "./store";
import { attachmentOf, usableTeams, type AgentInfo, type ChatItem, type Session, type TaskInfo, type Team } from "./types";

const run = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);

const created = (sessionId: string, extra: Partial<Extract<Action, { type: "sessionCreated" }>> = {}): Action => ({
  type: "sessionCreated",
  agentId: "claude",
  sessionId,
  cwd: "/work",
  title: "새 대화",
  launch: {},
  configOptions: [],
  modes: null,
  ...extra,
});

const update = (sessionId: string, u: object, profileId = "default"): Action => ({
  type: "update",
  agentId: "claude",
  profileId,
  sessionId,
  update: u,
});

const session = (state: State, sessionId: string, agentId = "claude"): Session => {
  const s = state.sessions.find((x) => x.key === `${agentId}:${sessionId}`);
  if (!s) throw new Error(`no session ${agentId}:${sessionId}`);
  return s;
};

const kinds = (items: ChatItem[]) => items.map((i) => i.kind);

const task = (id: string, patch: Partial<TaskInfo> = {}): TaskInfo => ({
  id,
  leadAgentId: "claude",
  leadSessionId: "lead",
  title: `task ${id}`,
  memberId: "deepseek-flash",
  memberName: "DeepSeek",
  agentId: "dsh",
  sessionId: null,
  status: "queued",
  writes: true,
  startedAt: null,
  endedAt: null,
  error: null,
  isolated: true,
  changes: [],
  mergeState: null,
  conflicts: [],
  ...patch,
});

describe("updates that arrive before the session", () => {
  it("are held and applied once the session is created", () => {
    const commands = { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] };
    let state = run(initialState, update("s1", commands));
    expect(state.sessions).toHaveLength(0);
    expect(state.early["claude:s1"]).toHaveLength(1);

    state = run(state, created("s1"));
    expect(session(state, "s1").commands).toEqual([{ name: "compact", description: "Compact", hint: undefined }]);
    expect(state.early["claude:s1"]).toBeUndefined();
  });

  it("are capped per session and across sessions", () => {
    let state = initialState;
    for (let i = 0; i < 60; i++) state = run(state, update("busy", { sessionUpdate: "notice", text: `${i}` }));
    expect(state.early["claude:busy"]).toHaveLength(50);

    for (let i = 0; i < 30; i++) state = run(state, update(`ghost${i}`, { sessionUpdate: "notice", text: "x" }));
    expect(Object.keys(state.early)).toHaveLength(20);
    expect(state.early["claude:ghost29"]).toBeDefined();
    expect(state.early["claude:busy"]).toBeUndefined();
  });
});

describe("streaming a turn", () => {
  it("joins text chunks and keeps tool fields that updates omit", () => {
    let state = run(
      initialState,
      created("s1"),
      { type: "userMessage", key: "claude:s1", text: "hello there, please read the file" },
      update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } }),
      update("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.rs", kind: "read", status: "pending" }),
      update("s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", title: null }),
      update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }),
      update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } }),
    );
    const s = session(state, "s1");
    expect(s.title).toBe("hello there, please read the file");
    expect(s.draft).toBe(false);
    expect(kinds(s.items)).toEqual(["user", "thought", "tool", "assistant"]);
    expect(s.items[2]).toMatchObject({ title: "Read a.rs", toolKind: "read", status: "completed" });
    expect(s.items[3]).toMatchObject({ text: "Hello" });

    state = run(state, { type: "busy", key: "claude:s1", busy: true }, { type: "busy", key: "claude:s1", busy: false });
    const user = session(state, "s1").items[0];
    expect(user.kind === "user" && typeof user.durationMs).toBe("number");
  });

  it("keeps one plan per turn", () => {
    const plan = (content: string) => update("s1", { sessionUpdate: "plan", entries: [{ content, status: "pending" }] });
    let state = run(initialState, created("s1"), { type: "userMessage", key: "claude:s1", text: "a" }, plan("one"), plan("two"));
    expect(kinds(session(state, "s1").items)).toEqual(["user", "plan"]);
    state = run(state, { type: "userMessage", key: "claude:s1", text: "b" }, plan("three"));
    expect(kinds(session(state, "s1").items)).toEqual(["user", "plan", "user", "plan"]);
  });

  it("builds a single compaction marker from its updates", () => {
    const state = run(
      initialState,
      created("s1"),
      update("s1", { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }),
      update("s1", { sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text: "Sum" } }),
      update("s1", { sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text: "mary" } }),
      update("s1", { sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }),
    );
    const items = session(state, "s1").items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "compaction", status: "completed", summary: "Summary" });
  });

  it("records account limits from Claude's rate-limit report", () => {
    const state = run(
      initialState,
      created("s1"),
      update(
        "s1",
        {
          sessionUpdate: "usage_update",
          used: 1000,
          size: 200000,
          _meta: { "_claude/rateLimit": { unifiedWindows: { five_hour: { status: "allowed", utilization: 0.25, resetsAt: 1 } } } },
        },
        "p1",
      ),
    );
    expect(session(state, "s1").usage).toEqual({ used: 1000, size: 200000, cost: null });
    expect(state.accountUsage["claude/p1"].entries["claude:five_hour"]).toMatchObject({
      status: "ok",
      utilization: 25,
      resetsAt: 1000,
    });
  });
});

describe("usableTeams", () => {
  it("hides built-in teams whose services aren't installed", () => {
    const agent = (id: string, installed: boolean) => ({ id, installed }) as AgentInfo;
    const team = (id: string, agentId: string, builtin: boolean): Team => ({
      id,
      name: id,
      members: [{ id: "m", name: "m", agentId, profileId: "default", launch: {}, config: {}, role: "" }],
      maxParallel: 3,
      isolation: "worktree",
      builtin,
    });
    const teams = [team("preset-claude", "claude", true), team("preset-codex", "codex", true), team("mine", "codex", false)];
    const ids = usableTeams(teams, [agent("claude", true), agent("codex", false)]).map((t) => t.id);
    expect(ids).toEqual(["preset-claude", "mine"]);
  });
});

describe("attachmentOf", () => {
  it("tells images and videos from other files", () => {
    expect(attachmentOf("/a/Shot 1.PNG")).toEqual({ path: "/a/Shot 1.PNG", name: "Shot 1.PNG", image: true });
    expect(attachmentOf("C:\\clips\\demo.mov")).toEqual({ path: "C:\\clips\\demo.mov", name: "demo.mov", image: false, video: true });
    expect(attachmentOf("/a/notes.md")).toEqual({ path: "/a/notes.md", name: "notes.md", image: false });
  });
});

describe("sending attachments", () => {
  it("keeps them on the message and names an empty chat after the first file", () => {
    const shot = { path: "/w/.baton/attachments/1-pasted.png", name: "1-pasted.png", image: true };
    const state = run(initialState, created("s1"), { type: "userMessage", key: "claude:s1", text: "", attachments: [shot] });
    const s = session(state, "s1");
    expect(s.items[0]).toMatchObject({ kind: "user", text: "", attachments: [shot] });
    expect(s.title).toBe("1-pasted.png");
  });
});

describe("account usage", () => {
  it("a usage report replaces the account's entries", () => {
    const entry = (id: string) => ({ id, label: id, status: "ok" as const });
    let state = run(initialState, {
      type: "accountUsage",
      agentId: "antigravity",
      profileId: "default",
      quotas: [entry("a"), entry("b")],
    });
    state = run(state, { type: "accountUsage", agentId: "antigravity", profileId: "default", quotas: [entry("c")] });
    expect(Object.keys(state.accountUsage["antigravity/default"].entries)).toEqual(["c"]);
  });
});

describe("agent mode tasks", () => {
  const lead = () =>
    run(initialState, created("lead", { lead: { teamId: "auto" } }), { type: "userMessage", key: "claude:lead", text: "first" });

  it("stay on the lead turn they started in", () => {
    let state = run(lead(), { type: "taskUpdate", task: task("a1-1") });
    const firstTurn = session(state, "lead").items[0].id;

    state = run(
      state,
      { type: "userMessage", key: "claude:lead", text: "second" },
      { type: "taskUpdate", task: task("a1-1", { status: "done" }) },
      { type: "taskUpdate", task: task("a1-2") },
    );
    const s = session(state, "lead");
    const secondTurn = s.items[1].id;
    expect(s.tasks?.map((t) => [t.id, t.status, t.turnId])).toEqual([
      ["a1-1", "done", firstTurn],
      ["a1-2", "queued", secondTurn],
    ]);
  });

  it("open their own chat and mirror running state on it", () => {
    const event = {
      task: task("a1-1", { sessionId: "sub", status: "running" }),
      session: { agentId: "dsh", sessionId: "sub", cwd: "/wt", launch: {}, configOptions: null, modes: null },
      brief: "Write the tests",
    };
    let state = run(lead(), { type: "taskSession", event });
    const sub = session(state, "sub", "dsh");
    expect(sub.parent).toEqual({ key: "claude:lead", taskId: "a1-1" });
    expect(sub.items[0]).toMatchObject({ kind: "brief", text: "Write the tests" });
    expect(sub.busy).toBe(true);

    state = run(state, { type: "taskUpdate", task: task("a1-1", { sessionId: "sub", status: "done" }) });
    expect(session(state, "sub", "dsh").busy).toBe(false);
    expect(session(state, "lead").tasks?.[0].status).toBe("done");
  });

  it("show the files the lead passed on under its brief", () => {
    const event = {
      task: task("a1-1", { sessionId: "sub", status: "running" }),
      session: { agentId: "dsh", sessionId: "sub", cwd: "/wt", launch: {}, configOptions: null, modes: null },
      brief: "Match this design",
      attachments: ["/Users/me/Shot 1.png", "/Users/me/spec.md"],
    };
    let state = run(lead(), { type: "taskSession", event });
    expect(session(state, "sub", "dsh").items[0]).toMatchObject({
      kind: "brief",
      text: "Match this design",
      attachments: [attachmentOf("/Users/me/Shot 1.png"), attachmentOf("/Users/me/spec.md")],
    });

    state = run(
      state,
      { type: "taskUpdate", task: task("a1-1", { sessionId: "sub", status: "done" }) },
      { type: "taskBrief", task: task("a1-1", { sessionId: "sub" }), text: "Now the dark theme", attachments: ["/Users/me/dark.png"] },
      { type: "taskBrief", task: task("a1-1", { sessionId: "sub" }), text: "Thanks", attachments: [] },
    );
    const [, followup, plain] = session(state, "sub", "dsh").items;
    expect(followup).toMatchObject({ kind: "brief", text: "Now the dark theme", attachments: [attachmentOf("/Users/me/dark.png")] });
    expect(plain).toMatchObject({ kind: "brief", text: "Thanks" });
    expect(plain).not.toHaveProperty("attachments");
  });
});

describe("importing a conversation", () => {
  const imported = (updates: unknown[], replayed = true): Action => ({
    type: "importSession",
    agentId: "claude",
    sessionId: "old",
    cwd: "/work",
    launch: {},
    title: "Old chat",
    updatedAt: 1,
    updates,
    replayed,
    configOptions: [],
    modes: null,
  });
  const userChunk = (text: string) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });

  it("strips the notes Baton put in front of messages", () => {
    const state = run(
      initialState,
      imported([
        userChunk("[Baton agent mode — note from the app]\nsplit the work\n[User message]\nfix it"),
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        userChunk("[Baton] A lead agent assigned you the task below.\n\nwrite tests"),
      ]),
    );
    const texts = session(state, "old").items.map((i) => ("text" in i ? i.text : ""));
    expect(texts).toEqual(["fix it", "ok", "write tests"]);
  });

  it("strips the attachment list Baton put after a lead message", () => {
    const state = run(
      initialState,
      imported([
        userChunk(
          "[Baton agent mode — note from the app]\nsplit the work\n[User message]\nmatch this\n\n[Attached files — note from the app]\nThe user attached these files.\n- /Users/me/Shot.png",
        ),
        { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "x", uri: "file:///Users/me/Shot.png" } },
      ]),
    );
    const [user] = session(state, "old").items;
    expect(user).toMatchObject({ kind: "user", text: "match this", attachments: [attachmentOf("/Users/me/Shot.png")] });
  });

  it("shows replayed attachments as attachments", () => {
    const state = run(
      initialState,
      imported([
        userChunk("look at this"),
        { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "x", uri: "file:///Users/me/My%20Shot.png" } },
        { sessionUpdate: "user_message_chunk", content: { type: "resource_link", uri: "file:///C:/work/notes.md", name: "notes.md" } },
      ]),
    );
    const [user] = session(state, "old").items;
    expect(user).toMatchObject({
      kind: "user",
      text: "look at this",
      attachments: [
        { path: "/Users/me/My Shot.png", name: "My Shot.png", image: true },
        { path: "C:/work/notes.md", name: "notes.md", image: false },
      ],
    });
  });

  it("explains an empty transcript and ignores a second import", () => {
    let state = run(initialState, imported([], false));
    expect(kinds(session(state, "old").items)).toEqual(["notice"]);
    state = run(state, imported([userChunk("again")]));
    expect(state.sessions).toHaveLength(1);
    expect(kinds(session(state, "old").items)).toEqual(["notice"]);
  });
});

describe("workspaces", () => {
  it("removing a folder hides its history but drops unused drafts", () => {
    let state = run(
      initialState,
      { type: "workspaceAdd", path: "/a" },
      { type: "workspaceAdd", path: "/b" },
      created("used", { cwd: "/a" }),
      { type: "userMessage", key: "claude:used", text: "hi" },
      created("draft", { cwd: "/a" }),
    );
    state = run(state, { type: "workspaceRemove", path: "/a" });
    expect(state.workspaces).toEqual(["/b"]);
    expect(state.workspace).toBe("/b");
    expect(state.sessions.map((s) => s.sessionId)).toEqual(["used"]);
    expect(state.activeKey).toBeNull();
  });

  it("a missing folder is not left selected", () => {
    const state = run(
      initialState,
      { type: "workspaceAdd", path: "/gone" },
      { type: "workspaceAdd", path: "/here" },
      { type: "workspaceSelect", path: "/gone" },
      { type: "missing", paths: ["/gone"] },
    );
    expect(state.workspace).toBe("/here");
    expect(state.missing).toEqual(["/gone"]);
  });
});
