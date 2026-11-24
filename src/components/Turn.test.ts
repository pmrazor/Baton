import { describe, expect, it } from "vitest";
import type { ChatItem } from "../types";
import { groupTurns } from "./Turn";

const user = (id: string): ChatItem => ({ kind: "user", id, text: id });
const say = (id: string): ChatItem => ({ kind: "assistant", id, text: id });
const think = (id: string): ChatItem => ({ kind: "thought", id, text: id });
const notice = (id: string): ChatItem => ({ kind: "notice", id, text: id, tone: "info" });
const compaction = (id: string): ChatItem => ({ kind: "compaction", id, compactionId: id, status: "completed", summary: "" });

describe("groupTurns", () => {
  it("splits at each user message and pulls out the final answer", () => {
    const turns = groupTurns([user("u1"), think("t1"), say("a1"), say("a2"), user("u2"), say("a3")]);
    expect(turns.map((t) => t.key)).toEqual(["u1", "u2"]);
    expect(turns[0].process.map((i) => i.id)).toEqual(["t1", "a1"]);
    expect(turns[0].answer?.id).toBe("a2");
    expect(turns[1].process).toEqual([]);
    expect(turns[1].answer?.id).toBe("a3");
  });

  it("keeps notices and compactions out of the process", () => {
    const [turn] = groupTurns([user("u1"), compaction("c1"), think("t1"), notice("n1")]);
    expect(turn.markers.map((i) => i.id)).toEqual(["c1"]);
    expect(turn.notices.map((i) => i.id)).toEqual(["n1"]);
    expect(turn.process.map((i) => i.id)).toEqual(["t1"]);
    expect(turn.answer).toBeNull();
  });

  it("starts turns at a lead's brief too, and keeps items before any message", () => {
    const turns = groupTurns([
      notice("n0"),
      { kind: "brief", id: "b1", text: "do it", label: "총괄이 맡긴 작업" },
      say("a1"),
    ]);
    expect(turns.map((t) => [t.key, t.user?.id ?? null])).toEqual([
      ["pre-n0", null],
      ["b1", "b1"],
    ]);
  });

  it("returns nothing for an empty chat", () => {
    expect(groupTurns([])).toEqual([]);
  });
});
