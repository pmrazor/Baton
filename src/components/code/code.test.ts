import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachToComposer, onAttach } from "../../composerBus";
import {
  ancestorDirs,
  buildTreeMenuSections,
  clampMenuPosition,
  detectPlatform,
  fileName,
  findContainingRoot,
  joinPath,
  joinRelativePath,
  languageForPath,
  nextActiveAfterClose,
  nextCopyName,
  parentDir,
  pasteTargetFolder,
  pathMatchesPrefix,
  relativeToRoot,
  renameSelectionEnd,
  revealLabelForPlatform,
  rewritePathPrefix,
  targetFolderForSelection,
  validateNewEntryName,
  validateRenameName,
} from "./codeHelpers";
import {
  activateTab,
  clearJump,
  closeTab,
  getRootEditorView,
  handleDeletedPath,
  onTabClosed,
  onTabRenamed,
  openAbsolutePath,
  openFile,
  registerRoot,
  renamePath,
  resetEditorStore,
  setTabState,
  subscribeEditor,
} from "./editorStore";

describe("path helpers", () => {
  it("joins workspace root and relative paths cleanly", () => {
    expect(joinPath("/Users/me/proj", "src/App.tsx")).toBe("/Users/me/proj/src/App.tsx");
    expect(joinPath("/Users/me/proj/", "./src/App.tsx")).toBe("/Users/me/proj/src/App.tsx");
    expect(joinPath("/Users/me/proj", "")).toBe("/Users/me/proj");
    expect(joinPath("C:\\Users\\me\\proj", "src/main.rs")).toBe("C:\\Users\\me\\proj\\src\\main.rs");
    expect(joinPath("C:\\Users\\me\\proj\\", "a/b/c.txt")).toBe("C:\\Users\\me\\proj\\a\\b\\c.txt");
  });

  it("joins relative segments and extracts file names", () => {
    expect(joinRelativePath("", "README.md")).toBe("README.md");
    expect(joinRelativePath("src", "App.tsx")).toBe("src/App.tsx");
    expect(joinRelativePath("src/components/", "./code/FileTree.tsx")).toBe(
      "src/components/code/FileTree.tsx",
    );
    expect(fileName("src/components/FileTree.tsx")).toBe("FileTree.tsx");
    expect(fileName("C:\\repo\\Cargo.toml")).toBe("Cargo.toml");
    expect(fileName("README.md")).toBe("README.md");
  });

  it("computes relative paths inside a root and rejects siblings or outside paths", () => {
    expect(relativeToRoot("/work/app", "/work/app/src/index.ts")).toBe("src/index.ts");
    expect(relativeToRoot("/work/app/", "/work/app/a.txt")).toBe("a.txt");
    expect(relativeToRoot("/work/app", "/work/app")).toBeNull();
    expect(relativeToRoot("/work/app", "/work/app2/a.txt")).toBeNull();
    expect(relativeToRoot("C:\\Work\\App", "c:/Work/App/src/lib.rs")).toBe("src/lib.rs");
  });

  it("picks the most specific matching root for nested workspaces", () => {
    const roots = ["/work/monorepo", "/work/monorepo/packages/web"];
    expect(findContainingRoot(roots, "/work/monorepo/packages/web/src/App.tsx")).toEqual({
      root: "/work/monorepo/packages/web",
      path: "src/App.tsx",
    });
    expect(findContainingRoot(roots, "/work/monorepo/README.md")).toEqual({
      root: "/work/monorepo",
      path: "README.md",
    });
    expect(findContainingRoot(roots, "/other/file.ts")).toBeNull();
  });
});

describe("extension to language mapping", () => {
  it("maps supported extensions and special basenames", () => {
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("src/util.mts")).toBe("typescript");
    expect(languageForPath("src/App.tsx")).toBe("tsx");
    expect(languageForPath("scripts/build.mjs")).toBe("javascript");
    expect(languageForPath("src/Button.JSX")).toBe("jsx");
    expect(languageForPath("src-tauri/src/files.rs")).toBe("rust");
    expect(languageForPath("tool.py")).toBe("python");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("tsconfig.jsonc")).toBe("json");
    expect(languageForPath("src/styles.css")).toBe("css");
    expect(languageForPath("index.html")).toBe("html");
    expect(languageForPath("icon.svg")).toBe("html");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath(".github/workflows/ci.yml")).toBe("yaml");
    expect(languageForPath("config.yaml")).toBe("yaml");
    expect(languageForPath("src-tauri/Cargo.toml")).toBe("toml");
    expect(languageForPath("src-tauri/Cargo.lock")).toBe("toml");
  });

  it("returns null for plain text, dotfiles without extension, and unknown extensions", () => {
    expect(languageForPath("LICENSE")).toBeNull();
    expect(languageForPath(".gitignore")).toBeNull();
    expect(languageForPath(".env")).toBeNull();
    expect(languageForPath("notes.txt")).toBeNull();
    expect(languageForPath("archive.bin")).toBeNull();
  });
});

describe("nextActiveAfterClose", () => {
  it("keeps active tab when closing a different tab", () => {
    expect(nextActiveAfterClose(["a", "b", "c"], "b", "a")).toBe("b");
    expect(nextActiveAfterClose(["a", "b", "c"], "a", "c")).toBe("a");
  });

  it("picks right neighbour, then left at the end, then null when empty", () => {
    expect(nextActiveAfterClose(["a", "b", "c"], "a", "a")).toBe("b");
    expect(nextActiveAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(nextActiveAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
    expect(nextActiveAfterClose(["a"], "a", "a")).toBeNull();
  });
});

describe("target folder and new entry name helpers", () => {
  it("resolves target folder from selected folder, file, or root", () => {
    expect(targetFolderForSelection(null)).toBe("");
    expect(targetFolderForSelection({ path: "src", dir: true })).toBe("src");
    expect(targetFolderForSelection({ path: "src/components", dir: true })).toBe("src/components");
    expect(targetFolderForSelection({ path: "src/components/FileTree.tsx", dir: false })).toBe(
      "src/components",
    );
    expect(targetFolderForSelection({ path: "README.md", dir: false })).toBe("");
    expect(parentDir("a/b/c.ts")).toBe("a/b");
    expect(parentDir("a.ts")).toBe("");
    expect(ancestorDirs("")).toEqual([]);
    expect(ancestorDirs("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("accepts valid file, dotfile, and nested relative names", () => {
    expect(validateNewEntryName("index.ts")).toEqual({ ok: true, name: "index.ts" });
    expect(validateNewEntryName("  src/utils/a.ts  ")).toEqual({ ok: true, name: "src/utils/a.ts" });
    expect(validateNewEntryName(".env")).toEqual({ ok: true, name: ".env" });
    expect(validateNewEntryName(".github/workflows/ci.yml")).toEqual({
      ok: true,
      name: ".github/workflows/ci.yml",
    });
    expect(validateNewEntryName("my folder/my note.md")).toEqual({
      ok: true,
      name: "my folder/my note.md",
    });
  });

  it("rejects empty names, dot segments, backslashes, and malformed slashes", () => {
    for (const bad of [
      "",
      "   ",
      ".",
      "..",
      "./a.ts",
      "../a.ts",
      "src/./a.ts",
      "src/../a.ts",
      "src/..",
      "a\\b.ts",
      "\\a.ts",
      "/a.ts",
      "src/",
      "src//a.ts",
      "src/ /a.ts",
      "bad\0name",
    ]) {
      const res = validateNewEntryName(bad);
      expect(res.ok, `expected "${bad}" to be rejected`).toBe(false);
      if (!res.ok) {
        expect(res.error.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("editorStore", () => {
  beforeEach(() => {
    resetEditorStore();
  });

  it("preserves open order, focuses existing tabs without duplicating, and handles line jumps", () => {
    openFile("/repo", "a.ts");
    openFile("/repo", "b.ts");
    openFile("/repo", "c.ts");

    let view = getRootEditorView("/repo");
    expect(view.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(view.active).toBe("c.ts");
    expect(view.jump).toBeNull();

    // Opening an already-open file focuses it without reordering.
    openFile("/repo", "./a.ts", 42);
    view = getRootEditorView("/repo");
    expect(view.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(view.active).toBe("a.ts");
    expect(view.jump).toMatchObject({ path: "a.ts", line: 42 });

    clearJump("/repo", view.jump!.seq);
    expect(getRootEditorView("/repo").jump).toBeNull();

    activateTab("/repo", "b.ts");
    expect(getRootEditorView("/repo").active).toBe("b.ts");
  });

  it("activates the expected neighbour on close and fires close listeners", () => {
    const closed: [string, string][] = [];
    const off = onTabClosed((r, p) => closed.push([r, p]));

    openFile("/repo", "one.ts");
    openFile("/repo", "two.ts");
    openFile("/repo", "three.ts");

    // Closing inactive tab leaves active unchanged.
    closeTab("/repo", "one.ts");
    expect(getRootEditorView("/repo").tabs.map((t) => t.path)).toEqual(["two.ts", "three.ts"]);
    expect(getRootEditorView("/repo").active).toBe("three.ts");

    // Closing last active tab moves left.
    closeTab("/repo", "three.ts");
    expect(getRootEditorView("/repo").tabs.map((t) => t.path)).toEqual(["two.ts"]);
    expect(getRootEditorView("/repo").active).toBe("two.ts");

    // Closing final tab clears active.
    closeTab("/repo", "two.ts");
    expect(getRootEditorView("/repo").tabs).toEqual([]);
    expect(getRootEditorView("/repo").active).toBeNull();
    expect(closed).toEqual([
      ["/repo", "one.ts"],
      ["/repo", "three.ts"],
      ["/repo", "two.ts"],
    ]);

    off();
  });

  it("opens absolute paths in the matching known root and isolates roots", () => {
    registerRoot("/ws/alpha");
    registerRoot("/ws/beta");

    expect(openAbsolutePath("/ws/gamma/foo.ts")).toBe(false);
    expect(openAbsolutePath("/ws/alpha/src/main.rs", 15)).toBe(true);

    const alpha = getRootEditorView("/ws/alpha");
    expect(alpha.tabs.map((t) => t.path)).toEqual(["src/main.rs"]);
    expect(alpha.active).toBe("src/main.rs");
    expect(alpha.jump).toMatchObject({ path: "src/main.rs", line: 15 });
    expect(getRootEditorView("/ws/beta").tabs).toEqual([]);
  });

  it("updates tab flags via setTabState and notifies subscribers only on changes", () => {
    openFile("/repo", "x.ts");
    const spy = vi.fn();
    const unsub = subscribeEditor(spy);

    setTabState("/repo", "x.ts", { dirty: true, mtime: 1234 });
    expect(spy).toHaveBeenCalledTimes(1);

    // Repeating the same values does not notify again.
    setTabState("/repo", "x.ts", { dirty: true, mtime: 1234 });
    expect(spy).toHaveBeenCalledTimes(1);

    const tab = getRootEditorView("/repo").tabs[0];
    expect(tab).toEqual({
      path: "x.ts",
      dirty: true,
      deleted: false,
      diskChanged: false,
      mtime: 1234,
    });
    unsub();
  });

  it("renames exact files and folder prefixes without touching sibling prefixes", () => {
    const renamed: [string, string, string][] = [];
    const off = onTabRenamed((r, f, t) => renamed.push([r, f, t]));

    openFile("/repo", "src/a.ts", 10);
    openFile("/repo", "src/sub/b.ts");
    openFile("/repo", "src2/c.ts");
    openFile("/repo", "README.md");
    activateTab("/repo", "src/a.ts");

    // Folder rename updates matching prefix tabs, active tab, and pending jump.
    renamePath("/repo", "src", "packages/app");

    let view = getRootEditorView("/repo");
    expect(view.tabs.map((t) => t.path)).toEqual([
      "packages/app/a.ts",
      "packages/app/sub/b.ts",
      "src2/c.ts",
      "README.md",
    ]);
    expect(view.active).toBe("packages/app/a.ts");
    expect(view.jump).toMatchObject({ path: "packages/app/a.ts", line: 10 });
    expect(renamed).toEqual([
      ["/repo", "src/a.ts", "packages/app/a.ts"],
      ["/repo", "src/sub/b.ts", "packages/app/sub/b.ts"],
    ]);

    // Single file rename updates only that tab.
    renamePath("/repo", "README.md", "DOCS.md");
    view = getRootEditorView("/repo");
    expect(view.tabs.map((t) => t.path)).toEqual([
      "packages/app/a.ts",
      "packages/app/sub/b.ts",
      "src2/c.ts",
      "DOCS.md",
    ]);
    expect(renamed.at(-1)).toEqual(["/repo", "README.md", "DOCS.md"]);

    off();
  });

  it("closes clean tabs and marks dirty tabs deleted when files or folders are trashed", () => {
    const closed: [string, string][] = [];
    const off = onTabClosed((r, p) => closed.push([r, p]));

    openFile("/repo", "src/clean.ts");
    openFile("/repo", "src/dirty.ts");
    openFile("/repo", "keep.ts");
    setTabState("/repo", "src/dirty.ts", { dirty: true });
    activateTab("/repo", "src/clean.ts");

    handleDeletedPath("/repo", "src");

    const view = getRootEditorView("/repo");
    expect(view.tabs.map((t) => ({ path: t.path, dirty: t.dirty, deleted: t.deleted }))).toEqual([
      { path: "src/dirty.ts", dirty: true, deleted: true },
      { path: "keep.ts", dirty: false, deleted: false },
    ]);
    expect(view.active).toBe("src/dirty.ts");
    expect(closed).toEqual([["/repo", "src/clean.ts"]]);

    off();
  });
});

describe("copy naming, paste target, rename selection, and menu helpers", () => {
  it("generates copy names on clash and preserves name when unused", () => {
    expect(nextCopyName("app.ts", ["other.ts"])).toBe("app.ts");
    expect(nextCopyName("app.ts", ["app.ts"])).toBe("app copy.ts");
    expect(nextCopyName("app.ts", ["app.ts", "app copy.ts"])).toBe("app copy 2.ts");
    expect(nextCopyName("app.ts", ["app.ts", "app copy.ts", "app copy 2.ts"])).toBe("app copy 3.ts");
    expect(nextCopyName("archive.tar.gz", ["archive.tar.gz"])).toBe("archive.tar copy.gz");
    expect(nextCopyName("README", ["README"])).toBe("README copy");
    expect(nextCopyName(".gitignore", [".gitignore"])).toBe(".gitignore copy");
    expect(nextCopyName(".env.local", [".env.local"])).toBe(".env copy.local");
    // Folders do not split on dots.
    expect(nextCopyName("v1.0", ["v1.0"], true)).toBe("v1.0 copy");
    expect(nextCopyName("v1.0", ["v1.0", "v1.0 copy"], true)).toBe("v1.0 copy 2");
  });

  it("computes paste target folder for folder, file, root, and empty context", () => {
    expect(pasteTargetFolder({ path: "src/components", dir: true }, "row")).toBe("src/components");
    expect(pasteTargetFolder({ path: "src/components/FileTree.tsx", dir: false }, "row")).toBe(
      "src/components",
    );
    expect(pasteTargetFolder({ path: "README.md", dir: false }, "row")).toBe("");
    expect(pasteTargetFolder(null, "row")).toBe("");
    // Empty space always pastes to root even if a selection is passed.
    expect(pasteTargetFolder({ path: "src", dir: true }, "empty")).toBe("");
  });

  it("computes inline rename selection range and validates single-segment names", () => {
    expect(renameSelectionEnd("FileTree.tsx", false)).toBe(8);
    expect(renameSelectionEnd("archive.tar.gz", false)).toBe(11);
    expect(renameSelectionEnd("README", false)).toBe(6);
    expect(renameSelectionEnd(".gitignore", false)).toBe(10);
    expect(renameSelectionEnd(".env.local", false)).toBe(4);
    expect(renameSelectionEnd("v1.0", true)).toBe(4);

    expect(validateRenameName("  new.ts  ")).toEqual({ ok: true, name: "new.ts" });
    expect(validateRenameName("").ok).toBe(false);
    expect(validateRenameName("a/b.ts").ok).toBe(false);
    expect(validateRenameName("a\\b.ts").ok).toBe(false);
    expect(validateRenameName("..").ok).toBe(false);
  });

  it("matches and rewrites path prefixes safely", () => {
    expect(pathMatchesPrefix("src/a.ts", "src")).toBe(true);
    expect(pathMatchesPrefix("src", "src")).toBe(true);
    expect(pathMatchesPrefix("src2/a.ts", "src")).toBe(false);
    expect(rewritePathPrefix("src/a.ts", "src", "lib")).toBe("lib/a.ts");
    expect(rewritePathPrefix("src2/a.ts", "src", "lib")).toBe("src2/a.ts");
  });

  it("clamps floating context menu positions to viewport bounds", () => {
    expect(clampMenuPosition(100, 100, 200, 300, 1200, 800)).toEqual({ left: 100, top: 100 });
    expect(clampMenuPosition(1150, 750, 200, 300, 1200, 800)).toEqual({ left: 992, top: 492 });
    expect(clampMenuPosition(-10, -5, 200, 300, 1200, 800)).toEqual({ left: 8, top: 8 });
  });

  it("builds file, folder, and empty-space menu items with OS labels and shortcuts", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");

    expect(revealLabelForPlatform("mac", "reveal")).toBe("Finder에서 보기");
    expect(revealLabelForPlatform("windows", "reveal")).toBe("탐색기에서 보기");
    expect(revealLabelForPlatform("linux", "reveal")).toBe("파일 관리자에서 보기");
    expect(revealLabelForPlatform("mac", "open")).toBe("Finder에서 열기");
    expect(revealLabelForPlatform("windows", "open")).toBe("탐색기에서 열기");
    expect(revealLabelForPlatform("linux", "open")).toBe("파일 관리자에서 열기");

    const fileItems = buildTreeMenuSections({
      kind: "file",
      hasClipboard: false,
      platform: "mac",
    }).flatMap((s) => s.items);
    expect(fileItems.map((i) => i.id)).toEqual([
      "newFile",
      "newFolder",
      "cut",
      "copy",
      "paste",
      "duplicate",
      "rename",
      "delete",
      "copyPath",
      "copyRelativePath",
      "reveal",
      "attachToChat",
    ]);
    expect(fileItems.find((i) => i.id === "paste")?.disabled).toBe(true);
    expect(fileItems.find((i) => i.id === "cut")?.shortcut).toBe("⌘X");
    expect(fileItems.find((i) => i.id === "delete")?.shortcut).toBe("⌘⌫");
    expect(fileItems.find((i) => i.id === "reveal")?.label).toBe("Finder에서 보기");

    const folderItems = buildTreeMenuSections({
      kind: "folder",
      hasClipboard: true,
      platform: "windows",
    }).flatMap((s) => s.items);
    expect(folderItems.map((i) => i.id)).toEqual([
      "newFile",
      "newFolder",
      "cut",
      "copy",
      "paste",
      "duplicate",
      "rename",
      "delete",
      "copyPath",
      "copyRelativePath",
      "reveal",
    ]);
    expect(folderItems.some((i) => i.id === "attachToChat")).toBe(false);
    expect(folderItems.find((i) => i.id === "paste")?.disabled).toBe(false);
    expect(folderItems.find((i) => i.id === "copy")?.shortcut).toBe("Ctrl+C");
    expect(folderItems.find((i) => i.id === "delete")?.shortcut).toBe("Delete");
    expect(folderItems.find((i) => i.id === "reveal")?.label).toBe("탐색기에서 보기");

    const emptyItems = buildTreeMenuSections({
      kind: "empty",
      hasClipboard: false,
      platform: "linux",
    }).flatMap((s) => s.items);
    expect(emptyItems.map((i) => i.id)).toEqual([
      "newFile",
      "newFolder",
      "paste",
      "refresh",
      "collapseAll",
      "reveal",
      "copyPath",
    ]);
    expect(emptyItems.find((i) => i.id === "paste")?.disabled).toBe(true);
    expect(emptyItems.find((i) => i.id === "reveal")?.label).toBe("파일 관리자에서 열기");
  });

  it("delivers attached absolute paths through composerBus", () => {
    const received: string[][] = [];
    const off = onAttach((paths) => received.push(paths));

    attachToComposer([]);
    expect(received).toEqual([]);

    attachToComposer(["/repo/src/App.tsx"]);
    expect(received).toEqual([["/repo/src/App.tsx"]]);

    off();
    attachToComposer(["/repo/src/main.tsx"]);
    expect(received).toEqual([["/repo/src/App.tsx"]]);

    // With no composer on screen the file waits, then arrives when one mounts.
    const later: string[][] = [];
    const offLater = onAttach((paths) => later.push(paths));
    expect(later).toEqual([["/repo/src/main.tsx"]]);
    offLater();
  });
});
