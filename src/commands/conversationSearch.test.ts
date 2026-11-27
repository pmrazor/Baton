import { describe, expect, it } from "vitest";
import type { ChatItem, Session } from "../types";
import { highlightRanges, searchConversations } from "./conversationSearch";

function makeSession(overrides: Partial<Session> & { key: string }): Session {
  return {
    agentId: "claude",
    sessionId: overrides.key,
    cwd: "/Users/dev/projects/baton",
    title: "테스트 대화",
    items: [],
    busy: false,
    configOptions: [],
    modes: null,
    createdAt: 1000,
    updatedAt: 1000,
    draft: false,
    attached: false,
    launch: {},
    usage: null,
    lastTurn: null,
    ...overrides,
  };
}

function userItem(id: string, text: string): ChatItem {
  return { kind: "user", id, text };
}

function assistantItem(id: string, text: string): ChatItem {
  return { kind: "assistant", id, text };
}

function briefItem(id: string, text: string): ChatItem {
  return { kind: "brief", id, text, label: "지시" };
}

describe("searchConversations", () => {
  it("returns empty results for blank queries", () => {
    const s = makeSession({ key: "s1", items: [userItem("u1", "hello world")] });
    expect(searchConversations([s], "")).toEqual({ hits: [], groups: [] });
    expect(searchConversations([s], "   \t\n ")).toEqual({ hits: [], groups: [] });
  });

  it("requires ALL whitespace-separated words to match within the same item (multi-word AND)", () => {
    const s = makeSession({
      key: "s1",
      title: "일반 대화",
      items: [
        userItem("u1", "alpha only here"),
        assistantItem("a1", "beta only here"),
        assistantItem("a2", "both beta and alpha appear together"),
      ],
    });

    const res = searchConversations([s], "alpha beta");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].itemId).toBe("a2");
    expect(res.hits[0].matchRanges.map((r) => res.hits[0].snippet.slice(r.start, r.end))).toEqual([
      "beta",
      "alpha",
    ]);
  });

  it("matches case-insensitively and preserves original casing in snippets", () => {
    const s = makeSession({
      key: "s1",
      items: [briefItem("b1", "Update CodeMirror Gutter for GitBlame")],
    });

    const res = searchConversations([s], "codemirror GITBLAME");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].itemId).toBe("b1");
    expect(res.hits[0].snippet).toBe("Update CodeMirror Gutter for GitBlame");
    expect(res.hits[0].matchRanges.map((r) => res.hits[0].snippet.slice(r.start, r.end))).toEqual([
      "CodeMirror",
      "GitBlame",
    ]);
  });

  it("searches user, assistant, and brief items while skipping tool, thought, notice, plan, and compaction", () => {
    const s = makeSession({
      key: "s1",
      title: "무관한 제목",
      items: [
        { kind: "thought", id: "th1", text: "needle inside thought" },
        {
          kind: "tool",
          id: "to1",
          toolKind: "read",
          toolCallId: "tc1",
          title: "needle tool",
          status: "completed",
          content: [],
          locations: [],
          rawInput: { q: "needle" },
        },
        { kind: "notice", id: "no1", text: "needle inside notice", tone: "info" },
        { kind: "plan", id: "pl1", entries: [{ content: "needle plan", priority: "high", status: "pending" }] },
        { kind: "compaction", id: "co1", compactionId: "c1", status: "completed", summary: "needle summary" },
        userItem("u1", "needle in user"),
        briefItem("b1", "needle in brief"),
        assistantItem("a1", "needle in assistant"),
      ],
    });

    const res = searchConversations([s], "needle");
    expect(res.hits.map((h) => h.itemId)).toEqual(["u1", "b1", "a1"]);
  });

  it("trims long snippets around the first match at word boundaries with ellipsis and collapses whitespace", () => {
    const prefixWords =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
    const suffixWords =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const text = `${prefixWords}\n\n   TARGET\t\tmatch   \n${suffixWords}`;
    const s = makeSession({ key: "s1", items: [assistantItem("a1", text)] });

    const res = searchConversations([s], "target");
    expect(res.hits).toHaveLength(1);
    const { snippet, matchRanges } = res.hits[0];

    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toMatch(/\s{2,}|\n|\t/);
    // Does not start or end mid-word inside the prefix/suffix words.
    const inner = snippet.slice(1, -1);
    expect(prefixWords.endsWith(inner.split(" TARGET")[0])).toBe(true);
    expect(suffixWords.startsWith(inner.split("match ")[1])).toBe(true);
    expect(matchRanges).toHaveLength(1);
    expect(snippet.slice(matchRanges[0].start, matchRanges[0].end)).toBe("TARGET");
  });

  it("omits leading ellipsis when match is near start and trailing ellipsis when near end", () => {
    const tail = "word ".repeat(30).trim();
    const sStart = makeSession({ key: "s-start", updatedAt: 2000, items: [userItem("u1", `Needle starts here ${tail}`)] });
    const sEnd = makeSession({ key: "s-end", updatedAt: 1000, items: [userItem("u2", `${tail} ends with Needle`)] });

    const res = searchConversations([sStart, sEnd], "needle");
    expect(res.hits).toHaveLength(2);
    expect(res.hits[0].snippet.startsWith("…")).toBe(false);
    expect(res.hits[0].snippet.endsWith("…")).toBe(true);
    expect(res.hits[1].snippet.startsWith("…")).toBe(true);
    expect(res.hits[1].snippet.endsWith("…")).toBe(false);
  });

  it("orders sessions by updatedAt desc, keeps item order, caps at 5 per session with moreCount, and skips drafts", () => {
    const manyItems = Array.from({ length: 8 }, (_, i) => userItem(`m${i + 1}`, `keyword message #${i + 1}`));
    const older = makeSession({ key: "old", updatedAt: 100, items: [userItem("o1", "keyword older")] });
    const newer = makeSession({ key: "new", updatedAt: 500, items: manyItems });
    const draft = makeSession({ key: "draft", updatedAt: 999, draft: true, items: [userItem("d1", "keyword draft")] });

    const res = searchConversations([older, draft, newer], "keyword");
    expect(res.groups.map((g) => g.sessionKey)).toEqual(["new", "old"]);

    expect(res.groups[0].hits.map((h) => h.itemId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(res.groups[0].moreCount).toBe(3);
    expect(res.groups[0].overflow.map((h) => h.itemId)).toEqual(["m6", "m7", "m8"]);

    expect(res.groups[1].hits.map((h) => h.itemId)).toEqual(["o1"]);
    expect(res.groups[1].moreCount).toBe(0);

    expect(res.hits).toHaveLength(6);
  });

  it("respects the global limit option", () => {
    const s1 = makeSession({
      key: "s1",
      updatedAt: 300,
      items: [userItem("a", "hit"), userItem("b", "hit"), userItem("c", "hit")],
    });
    const s2 = makeSession({
      key: "s2",
      updatedAt: 200,
      items: [userItem("d", "hit"), userItem("e", "hit")],
    });

    const res = searchConversations([s1, s2], "hit", { limit: 4 });
    expect(res.hits.map((h) => h.itemId)).toEqual(["a", "b", "c", "d"]);
    expect(res.groups[1].hits.map((h) => h.itemId)).toEqual(["d"]);
    expect(res.groups[1].moreCount).toBe(1);
  });

  it("produces a title hit (itemId = null) when only the title matches", () => {
    const titleOnly = makeSession({
      key: "t1",
      updatedAt: 200,
      title: "OAuth 로그인 리팩토링",
      items: [userItem("u1", "토큰 저장소 위치를 옮겨 주세요")],
    });
    const bothMatch = makeSession({
      key: "t2",
      updatedAt: 100,
      title: "OAuth 로그인 리팩토링",
      items: [userItem("u2", "OAuth 로그인 버그를 고쳐 주세요")],
    });

    const res = searchConversations([titleOnly, bothMatch], "oauth 로그인");
    expect(res.groups).toHaveLength(2);

    expect(res.groups[0].sessionKey).toBe("t1");
    expect(res.groups[0].hits).toHaveLength(1);
    expect(res.groups[0].hits[0].itemId).toBeNull();
    expect(res.groups[0].hits[0].snippet).toBe("OAuth 로그인 리팩토링");
    expect(
      res.groups[0].hits[0].matchRanges.map((r) => res.groups[0].hits[0].snippet.slice(r.start, r.end)),
    ).toEqual(["OAuth", "로그인"]);

    // When an item matches, no redundant title row is duplicated.
    expect(res.groups[1].sessionKey).toBe("t2");
    expect(res.groups[1].hits.map((h) => h.itemId)).toEqual(["u2"]);
  });

  it("flags delegated task chats and extracts workspace basename for POSIX and Windows paths", () => {
    const taskChat = makeSession({
      key: "task1",
      updatedAt: 200,
      cwd: "C:\\Users\\dev\\worktrees\\my-app\\",
      parent: { key: "lead1", taskId: "t-1" },
      items: [briefItem("b1", "implement feature X")],
    });
    const normalChat = makeSession({
      key: "norm1",
      updatedAt: 100,
      cwd: "/Users/dev/repos/baton/",
      items: [userItem("u1", "implement feature X")],
    });

    const res = searchConversations([normalChat, taskChat], "feature");
    expect(res.hits[0]).toMatchObject({
      sessionKey: "task1",
      isTask: true,
      workspace: "my-app",
    });
    expect(res.hits[1]).toMatchObject({
      sessionKey: "norm1",
      isTask: false,
      workspace: "baton",
    });
  });

  it("merges overlapping match ranges and highlights them cleanly", () => {
    const s = makeSession({
      key: "s1",
      items: [assistantItem("a1", "testing test cases")],
    });
    const res = searchConversations([s], "test testing");
    expect(res.hits[0].matchRanges).toEqual([
      { start: 0, end: 7 },
      { start: 8, end: 12 },
    ]);
    expect(highlightRanges(res.hits[0].snippet, res.hits[0].matchRanges)).toEqual([
      { text: "testing", match: true },
      { text: " ", match: false },
      { text: "test", match: true },
      { text: " cases", match: false },
    ]);
  });
});
