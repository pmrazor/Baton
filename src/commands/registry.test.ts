import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeCommand,
  isCommandCenterShortcut,
  listCommands,
  parsePaletteInput,
  readRecentCommandIds,
  registerCommand,
  resetCommandRegistry,
} from "./registry";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("command registry", () => {
  beforeEach(() => {
    resetCommandRegistry();
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  it("registers commands, filters by when, and disposes cleanly", () => {
    let busy = false;
    const off1 = registerCommand({ id: "a", title: "첫 번째", run: () => {} });
    const off2 = registerCommand({ id: "b", title: "중단", when: () => busy, run: () => {} });

    expect(listCommands().map((c) => c.id)).toEqual(["a"]);
    busy = true;
    expect(listCommands().map((c) => c.id)).toEqual(["a", "b"]);

    off1();
    expect(listCommands().map((c) => c.id)).toEqual(["b"]);
    off2();
    expect(listCommands()).toEqual([]);
  });

  it("does not dispose a newer registration with the same id", () => {
    const offOld = registerCommand({ id: "dup", title: "이전", run: () => {} });
    const offNew = registerCommand({ id: "dup", title: "최신", run: () => {} });

    offOld();
    expect(listCommands().map((c) => c.title)).toEqual(["최신"]);

    offNew();
    expect(listCommands()).toEqual([]);
  });

  it("orders recently used commands first and persists to localStorage", () => {
    const ran: string[] = [];
    registerCommand({ id: "one", title: "하나", run: () => ran.push("one") });
    registerCommand({ id: "two", title: "둘", run: () => ran.push("two") });
    registerCommand({ id: "three", title: "셋", run: () => ran.push("three") });

    executeCommand(listCommands().find((c) => c.id === "three")!);
    executeCommand(listCommands().find((c) => c.id === "two")!);

    expect(ran).toEqual(["three", "two"]);
    expect(readRecentCommandIds()).toEqual(["two", "three"]);
    expect(listCommands().map((c) => c.id)).toEqual(["two", "three", "one"]);
  });

  it("tolerates localStorage failures without throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const run = vi.fn();
    registerCommand({ id: "safe", title: "안전", run });
    expect(() => executeCommand(listCommands()[0])).not.toThrow();
    expect(run).toHaveBeenCalledOnce();
    expect(readRecentCommandIds()).toEqual([]);
  });
});

describe("isCommandCenterShortcut", () => {
  const base = { key: "p", code: "KeyP", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("matches ⌘P and ⌘⇧P on macOS", () => {
    expect(isCommandCenterShortcut({ ...base, metaKey: true }, true)).toBe("quick");
    expect(isCommandCenterShortcut({ ...base, metaKey: true, shiftKey: true }, true)).toBe("commands");
    expect(isCommandCenterShortcut({ ...base, ctrlKey: true }, true)).toBeNull();
    expect(isCommandCenterShortcut({ ...base, metaKey: true, altKey: true }, true)).toBeNull();
  });

  it("matches Ctrl+P and Ctrl+Shift+P on Windows/Linux", () => {
    expect(isCommandCenterShortcut({ ...base, ctrlKey: true }, false)).toBe("quick");
    expect(isCommandCenterShortcut({ ...base, ctrlKey: true, shiftKey: true }, false)).toBe("commands");
    expect(isCommandCenterShortcut({ ...base, metaKey: true }, false)).toBeNull();
  });

  it("falls back to KeyP code when IME changes key", () => {
    expect(isCommandCenterShortcut({ ...base, key: "ㅔ", code: "KeyP", metaKey: true }, true)).toBe("quick");
  });

  it("matches ⌘⇧H and Ctrl+Shift+H for conversation search without hijacking plain ⌘H", () => {
    const hBase = { key: "h", code: "KeyH", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isCommandCenterShortcut({ ...hBase, metaKey: true, shiftKey: true }, true)).toBe("conversations");
    expect(isCommandCenterShortcut({ ...hBase, metaKey: true }, true)).toBeNull();
    expect(isCommandCenterShortcut({ ...hBase, ctrlKey: true, shiftKey: true }, false)).toBe("conversations");
    expect(isCommandCenterShortcut({ ...hBase, ctrlKey: true }, false)).toBeNull();
    expect(isCommandCenterShortcut({ ...hBase, key: "ㅗ", code: "KeyH", metaKey: true, shiftKey: true }, true)).toBe(
      "conversations",
    );
  });
});

describe("parsePaletteInput", () => {
  it("detects quick, command (>), go-to-line (:), and conversation search (#) modes", () => {
    expect(parsePaletteInput("")).toEqual({ mode: "quick", query: "", line: null });
    expect(parsePaletteInput(" App.tsx ")).toEqual({ mode: "quick", query: "App.tsx", line: null });
    expect(parsePaletteInput(">")).toEqual({ mode: "command", query: "", line: null });
    expect(parsePaletteInput("> 설정")).toEqual({ mode: "command", query: "설정", line: null });
    expect(parsePaletteInput(":")).toEqual({ mode: "line", query: "", line: null });
    expect(parsePaletteInput(":42")).toEqual({ mode: "line", query: "42", line: 42 });
    expect(parsePaletteInput(":0")).toEqual({ mode: "line", query: "0", line: null });
    expect(parsePaletteInput(":abc")).toEqual({ mode: "line", query: "abc", line: null });
    expect(parsePaletteInput("#")).toEqual({ mode: "conversation", query: "", line: null });
    expect(parsePaletteInput("# oauth 로그인 ")).toEqual({ mode: "conversation", query: "oauth 로그인", line: null });
  });
});
