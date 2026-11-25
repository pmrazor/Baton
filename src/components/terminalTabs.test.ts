import { describe, expect, it } from "vitest";
import {
  buildTerminalTabMenuSections,
  nextTabNumber,
  tabAfterBulkClose,
  tabAfterClose,
  terminalId,
  terminalLabel,
  terminalNumber,
  terminalTabsToClose,
} from "./terminalTabs";

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

describe("terminalLabel", () => {
  it("falls back to 터미널 N when unset or blank and trims custom names", () => {
    expect(terminalLabel(1)).toBe("터미널 1");
    expect(terminalLabel(2, null)).toBe("터미널 2");
    expect(terminalLabel(3, "   ")).toBe("터미널 3");
    expect(terminalLabel(1, "  빌드 서버  ")).toBe("빌드 서버");
  });
});

describe("terminalTabsToClose", () => {
  const ids = ["t1", "t2", "t3", "t4"];

  it("picks the expected ids for others, left, right, and all", () => {
    expect(terminalTabsToClose(ids, "t2", "others")).toEqual(["t1", "t3", "t4"]);
    expect(terminalTabsToClose(["t1"], "t1", "others")).toEqual([]);
    expect(terminalTabsToClose(ids, "missing", "others")).toEqual([]);

    expect(terminalTabsToClose(ids, "t1", "left")).toEqual([]);
    expect(terminalTabsToClose(ids, "t3", "left")).toEqual(["t1", "t2"]);

    expect(terminalTabsToClose(ids, "t4", "right")).toEqual([]);
    expect(terminalTabsToClose(ids, "t2", "right")).toEqual(["t3", "t4"]);

    expect(terminalTabsToClose(ids, "t2", "all")).toEqual(ids);
  });
});

describe("tabAfterBulkClose", () => {
  const ids = ["t1", "t2", "t3", "t4"];

  it("keeps the active tab when it is not closed", () => {
    expect(tabAfterBulkClose(ids, "t3", ["t1", "t2"])).toBe("t3");
    expect(tabAfterBulkClose(ids, "t2", ["t1", "t3", "t4"])).toBe("t2");
  });

  it("selects the next surviving right neighbour, or left at the end, or null when empty", () => {
    expect(tabAfterBulkClose(ids, "t1", ["t1", "t2"])).toBe("t3");
    expect(tabAfterBulkClose(ids, "t2", ["t2", "t3"])).toBe("t4");
    expect(tabAfterBulkClose(ids, "t3", ["t3", "t4"])).toBe("t2");
    expect(tabAfterBulkClose(ids, "t2", ids)).toBeNull();
    expect(tabAfterBulkClose(ids, "t2", [])).toBe("t2");
    expect(tabAfterBulkClose(ids, null, ["t1", "t2"])).toBe("t3");
  });
});

describe("buildTerminalTabMenuSections", () => {
  it("builds menu sections and disables unavailable directional actions", () => {
    const first = buildTerminalTabMenuSections(["t1", "t2", "t3"], "t1");
    expect(first).toHaveLength(2);
    const firstItems = first.flatMap((s) => s.items);
    expect(firstItems.map((i) => i.id)).toEqual([
      "close",
      "closeOthers",
      "closeLeft",
      "closeRight",
      "closeAll",
      "rename",
      "clear",
    ]);
    expect(firstItems.find((i) => i.id === "closeLeft")?.disabled).toBe(true);
    expect(firstItems.find((i) => i.id === "closeRight")?.disabled).toBe(false);
    expect(firstItems.find((i) => i.id === "closeOthers")?.disabled).toBe(false);

    const lastItems = buildTerminalTabMenuSections(["t1", "t2", "t3"], "t3").flatMap((s) => s.items);
    expect(lastItems.find((i) => i.id === "closeLeft")?.disabled).toBe(false);
    expect(lastItems.find((i) => i.id === "closeRight")?.disabled).toBe(true);

    const singleItems = buildTerminalTabMenuSections(["t1"], "t1").flatMap((s) => s.items);
    expect(singleItems.find((i) => i.id === "closeOthers")?.disabled).toBe(true);
    expect(singleItems.find((i) => i.id === "closeLeft")?.disabled).toBe(true);
    expect(singleItems.find((i) => i.id === "closeRight")?.disabled).toBe(true);
    expect(singleItems.find((i) => i.id === "closeAll")?.disabled).toBe(false);
  });
});
