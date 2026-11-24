import { describe, expect, it } from "vitest";
import { nextTabNumber, tabAfterClose, terminalId, terminalNumber } from "./terminalTabs";

describe("terminalNumber", () => {
  it("reads back the number of an id for the same folder", () => {
    expect(terminalNumber(terminalId("/a/b", 3), "/a/b")).toBe(3);
    // A folder name may contain '#' itself.
    expect(terminalNumber(terminalId("/a/#x", 2), "/a/#x")).toBe(2);
  });

  it("rejects ids of other folders and malformed ones", () => {
    expect(terminalNumber("/a/b#1", "/a")).toBeNull();
    expect(terminalNumber("/a/bc#1", "/a/b")).toBeNull();
    expect(terminalNumber("/a/b", "/a/b")).toBeNull();
    expect(terminalNumber("/a/b#", "/a/b")).toBeNull();
    expect(terminalNumber("/a/b#0", "/a/b")).toBeNull();
    expect(terminalNumber("/a/b#1x", "/a/b")).toBeNull();
  });
});

describe("nextTabNumber", () => {
  it("starts at 1 and counts up", () => {
    expect(nextTabNumber(0, [])).toBe(1);
    expect(nextTabNumber(1, [1])).toBe(2);
  });

  it("doesn't reuse a closed number while others are open", () => {
    // 1, 2, 3 opened, 3 closed: the next is 4, not 3.
    expect(nextTabNumber(3, [1, 2])).toBe(4);
    // 1 closed: still 4.
    expect(nextTabNumber(3, [2, 3])).toBe(4);
  });

  it("starts over once all are closed", () => {
    expect(nextTabNumber(5, [])).toBe(1);
  });

  it("stays above tabs restored after a reload", () => {
    expect(nextTabNumber(0, [2, 5])).toBe(6);
  });
});

describe("tabAfterClose", () => {
  const ids = ["a", "b", "c"];

  it("keeps the active tab when another one closes", () => {
    expect(tabAfterClose(ids, "a", "c")).toBe("a");
  });

  it("selects the right neighbour, or the left one at the end", () => {
    expect(tabAfterClose(ids, "b", "b")).toBe("c");
    expect(tabAfterClose(ids, "a", "a")).toBe("b");
    expect(tabAfterClose(ids, "c", "c")).toBe("b");
  });

  it("selects nothing when the last tab closes", () => {
    expect(tabAfterClose(["a"], "a", "a")).toBeNull();
  });

  it("selects a tab when none was active", () => {
    expect(tabAfterClose(ids, null, "a")).toBe("b");
  });
});
