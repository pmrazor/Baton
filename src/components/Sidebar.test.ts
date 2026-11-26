import { describe, expect, it } from "vitest";
import type { Session } from "../types";
import { recentFinished, RECENT_DONE_LIMIT } from "./Sidebar";

// Finished task chats, oldest first (the order childrenOf/splitTasks produce).
const chats = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, title: `t${i}` }) as Session);
const keys = (list: Session[]) => list.map((c) => c.key);

describe("recentFinished", () => {
  it("uses a limit of 10", () => {
    expect(RECENT_DONE_LIMIT).toBe(10);
  });

  it("shows everything when there are not more than the limit", () => {
    const list = chats(10);
    const r = recentFinished(list, false, null);
    expect(r.shown).toBe(list);
    expect(r.hidden).toBe(0);
    expect(r.expanded).toBe(false);
    expect(r.activeOlder).toBe(false);
  });

  it("keeps only the most recent ones, in their original order", () => {
    const r = recentFinished(chats(13), false, null);
    expect(keys(r.shown)).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"]);
    expect(r.hidden).toBe(3);
    expect(r.expanded).toBe(false);
  });

  it("shows all when asked, and reports it as expanded", () => {
    const r = recentFinished(chats(13), true, null);
    expect(r.shown).toHaveLength(13);
    expect(r.hidden).toBe(0);
    expect(r.expanded).toBe(true);
  });

  it("shows all when the open chat is one of the hidden older ones", () => {
    const r = recentFinished(chats(13), false, "t0");
    expect(r.shown).toHaveLength(13);
    expect(r.hidden).toBe(0);
    expect(r.expanded).toBe(true);
    expect(r.activeOlder).toBe(true);
  });

  it("keeps the limit when the open chat is among the recent ones", () => {
    const r = recentFinished(chats(13), false, "t5");
    expect(keys(r.shown)).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"]);
    expect(r.hidden).toBe(3);
    expect(r.expanded).toBe(false);
    expect(r.activeOlder).toBe(false);
  });

  it("ignores a null or unrelated active key", () => {
    expect(recentFinished(chats(12), false, "nope").hidden).toBe(2);
  });

  it("respects a custom limit", () => {
    const r = recentFinished(chats(5), false, null, 2);
    expect(keys(r.shown)).toEqual(["t3", "t4"]);
    expect(r.hidden).toBe(3);
  });

  it("handles an empty list", () => {
    const r = recentFinished([], false, null);
    expect(r.shown).toEqual([]);
    expect(r.hidden).toBe(0);
  });
});
