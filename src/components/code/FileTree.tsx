import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  X,
} from "lucide-react";
import { api, toFsError, type FsEntry } from "../../api";
import { attachToComposer } from "../../composerBus";
import ContextMenu from "../ContextMenu";
import {
  ancestorDirs,
  buildTreeMenuSections,
  detectPlatform,
  fileName,
  joinPath,
  joinRelativePath,
  languageForPath,
  parentDir,
  pasteTargetFolder,
  pathMatchesPrefix,
  renameSelectionEnd,
  rewritePathPrefix,
  targetFolderForSelection,
  validateNewEntryName,
  validateRenameName,
  type SelectedTreeEntry,
  type TreeMenuActionId,
} from "./codeHelpers";
import {
  clearReveal,
  handleDeletedPath,
  openFile,
  registerRoot,
  renamePath,
  useEditorRoot,
} from "./editorStore";
import "./code.css";

export interface FileTreeProps {
  root: string;
  onOpen?: (path: string) => void;
}

interface TreeCache {
  expanded: Set<string>;
  children: Map<string, FsEntry[]>;
  selected: SelectedTreeEntry | null;
}

interface CreatingState {
  kind: "file" | "folder";
  targetDir: string;
  value: string;
  error: string | null;
}

interface RenamingState {
  path: string;
  dir: boolean;
  value: string;
  error: string | null;
}

interface TreeClipboard {
  mode: "copy" | "cut";
  root: string;
  paths: string[];
}

type ContextMenuState =
  | { x: number; y: number; kind: "empty" }
  | { x: number; y: number; kind: "file" | "folder"; entry: FsEntry };

const PLATFORM = detectPlatform();
const IS_MAC = PLATFORM === "mac";

// Keep expanded folders, loaded directory listings, and selection in memory per root.
const treeByRoot = new Map<string, TreeCache>();
// Small in-app clipboard for cut/copy/paste in the file tree.
let treeClipboard: TreeClipboard | null = null;

function getTreeCache(root: string): TreeCache {
  let cache = treeByRoot.get(root);
  if (!cache) {
    cache = { expanded: new Set(), children: new Map(), selected: null };
    treeByRoot.set(root, cache);
  }
  return cache;
}

function findEntryInCache(cache: TreeCache, relPath: string): FsEntry | null {
  const dir = parentDir(relPath);
  const siblings = cache.children.get(dir);
  return siblings?.find((e) => e.path === relPath) ?? null;
}

function flattenVisibleEntries(cache: TreeCache): FsEntry[] {
  const out: FsEntry[] = [];
  const walk = (dir: string) => {
    const entries = cache.children.get(dir);
    if (!entries) return;
    for (const entry of entries) {
      out.push(entry);
      if (entry.dir && cache.expanded.has(entry.path)) {
        walk(entry.path);
      }
    }
  };
  walk("");
  return out;
}

function rewriteCacheAfterRename(cache: TreeCache, root: string, from: string, to: string): void {
  const nextExpanded = new Set<string>();
  for (const dir of cache.expanded) {
    nextExpanded.add(pathMatchesPrefix(dir, from) ? rewritePathPrefix(dir, from, to) : dir);
  }
  cache.expanded = nextExpanded;

  const nextChildren = new Map<string, FsEntry[]>();
  for (const [dir, entries] of cache.children.entries()) {
    const mappedDir = dir && pathMatchesPrefix(dir, from) ? rewritePathPrefix(dir, from, to) : dir;
    const mappedEntries = entries.map((e) =>
      pathMatchesPrefix(e.path, from)
        ? { ...e, path: rewritePathPrefix(e.path, from, to), name: fileName(rewritePathPrefix(e.path, from, to)) }
        : e,
    );
    nextChildren.set(mappedDir, mappedEntries);
  }
  cache.children = nextChildren;

  if (cache.selected && pathMatchesPrefix(cache.selected.path, from)) {
    cache.selected = {
      path: rewritePathPrefix(cache.selected.path, from, to),
      dir: cache.selected.dir,
    };
  }

  if (treeClipboard && treeClipboard.root === root) {
    treeClipboard = {
      ...treeClipboard,
      paths: treeClipboard.paths.map((p) => (pathMatchesPrefix(p, from) ? rewritePathPrefix(p, from, to) : p)),
    };
  }
}

function pruneCacheAfterDelete(cache: TreeCache, root: string, path: string): void {
  for (const dir of [...cache.expanded]) {
    if (pathMatchesPrefix(dir, path)) cache.expanded.delete(dir);
  }
  for (const dir of [...cache.children.keys()]) {
    if (dir && pathMatchesPrefix(dir, path)) cache.children.delete(dir);
  }
  if (cache.selected && pathMatchesPrefix(cache.selected.path, path)) {
    cache.selected = null;
  }
  if (treeClipboard && treeClipboard.root === root) {
    const remaining = treeClipboard.paths.filter((p) => !pathMatchesPrefix(p, path));
    treeClipboard = remaining.length > 0 ? { ...treeClipboard, paths: remaining } : null;
  }
}

function FileIcon({ path }: { path: string }) {
  const lang = languageForPath(path);
  if (lang === "json") return <FileJson size={14} className="code-tree-icon" />;
  if (lang === "markdown") return <FileText size={14} className="code-tree-icon" />;
  if (lang !== null) return <FileCode2 size={14} className="code-tree-icon" />;
  return <File size={14} className="code-tree-icon" />;
}

export default function FileTree({ root, onOpen }: FileTreeProps) {
  const { active, reveal } = useEditorRoot(root);
  const [, bump] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const ignoreNextBlurRef = useRef(false);
  const renameSubmittingRef = useRef(false);
  const ignoreRenameBlurRef = useRef(false);

  const rerender = useCallback(() => bump((n) => n + 1), []);

  const loadDir = useCallback(
    async (dir: string) => {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.add(dir);
        return next;
      });
      try {
        const entries = await api.fsList(root, dir);
        getTreeCache(root).children.set(dir, entries);
        if (dir === "") setError(null);
      } catch (err) {
        if (dir === "") setError(toFsError(err).message);
      } finally {
        setLoadingDirs((prev) => {
          if (!prev.has(dir)) return prev;
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
        rerender();
      }
    },
    [root, rerender],
  );

  useEffect(() => {
    registerRoot(root);
    const cache = getTreeCache(root);
    setError(null);
    setOpError(null);
    setCreating(null);
    setRenaming(null);
    setMenu(null);
    if (!cache.children.has("")) {
      void loadDir("");
    } else {
      rerender();
    }
  }, [root, loadDir, rerender]);

  // Expand ancestor folders, select, and scroll to a file revealed from an editor tab.
  useEffect(() => {
    if (!reveal) return;
    const targetPath = reveal.path;
    const seq = reveal.seq;
    let cancelled = false;

    void (async () => {
      const cache = getTreeCache(root);
      const targetParent = parentDir(targetPath);
      const ancestors = ancestorDirs(targetParent);
      const dirsToLoad: string[] = [];
      if (!cache.children.has("")) dirsToLoad.push("");
      for (const dir of ancestors) {
        cache.expanded.add(dir);
        if (!cache.children.has(dir)) {
          dirsToLoad.push(dir);
        }
      }
      if (!findEntryInCache(cache, targetPath) && !dirsToLoad.includes(targetParent)) {
        dirsToLoad.push(targetParent);
      }
      cache.selected = { path: targetPath, dir: false };
      clearReveal(root, seq);
      rerender();

      if (dirsToLoad.length > 0) {
        await Promise.all(dirsToLoad.map((dir) => loadDir(dir)));
      }
      if (cancelled) return;

      requestAnimationFrame(() => {
        const rows = bodyRef.current?.querySelectorAll<HTMLElement>("[data-path]");
        if (!rows) return;
        for (const row of rows) {
          if (row.dataset.path === targetPath) {
            row.scrollIntoView({ block: "nearest" });
            break;
          }
        }
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [root, reveal, loadDir, rerender]);

  const creatingKey = creating ? `${creating.kind}:${creating.targetDir}` : null;
  useEffect(() => {
    if (!creatingKey) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.scrollIntoView({ block: "nearest" });
    }
  }, [creatingKey]);

  const renamingPath = renaming?.path ?? null;
  const renamingDir = renaming?.dir ?? false;
  useEffect(() => {
    if (!renamingPath) return;
    const input = renameInputRef.current;
    if (input) {
      input.focus();
      const name = fileName(renamingPath);
      input.setSelectionRange(0, renameSelectionEnd(name, renamingDir));
      input.scrollIntoView({ block: "nearest" });
    }
  }, [renamingPath, renamingDir]);

  const handleRefresh = useCallback(async () => {
    const cache = getTreeCache(root);
    const dirsToReload = ["", ...cache.expanded];
    // Drop cached children for collapsed folders so they reload on next expand.
    for (const key of [...cache.children.keys()]) {
      if (key !== "" && !cache.expanded.has(key)) {
        cache.children.delete(key);
      }
    }
    setRefreshing(true);
    setOpError(null);
    try {
      await Promise.all(dirsToReload.map((dir) => loadDir(dir)));
    } finally {
      setRefreshing(false);
    }
  }, [root, loadDir]);

  const handleCollapseAll = useCallback(() => {
    const cache = getTreeCache(root);
    cache.expanded.clear();
    if (cache.selected && parentDir(cache.selected.path) !== "") {
      cache.selected = null;
    }
    rerender();
  }, [root, rerender]);

  const handleDirClick = (dirPath: string) => {
    setOpError(null);
    const cache = getTreeCache(root);
    cache.selected = { path: dirPath, dir: true };
    if (cache.expanded.has(dirPath)) {
      cache.expanded.delete(dirPath);
      rerender();
      return;
    }
    cache.expanded.add(dirPath);
    rerender();
    if (!cache.children.has(dirPath)) {
      void loadDir(dirPath);
    }
  };

  const handleFileClick = (relPath: string) => {
    setOpError(null);
    const cache = getTreeCache(root);
    cache.selected = { path: relPath, dir: false };
    rerender();
    openFile(root, relPath);
    onOpen?.(relPath);
  };

  const startCreate = useCallback(
    (kind: "file" | "folder", explicitTargetDir?: string) => {
      setOpError(null);
      setRenaming(null);
      const cache = getTreeCache(root);
      const targetDir =
        explicitTargetDir !== undefined ? explicitTargetDir : targetFolderForSelection(cache.selected);
      if (targetDir) {
        const dirs = ancestorDirs(targetDir);
        for (const dir of dirs) {
          cache.expanded.add(dir);
          if (!cache.children.has(dir)) {
            void loadDir(dir);
          }
        }
        rerender();
      }
      ignoreNextBlurRef.current = false;
      setCreating({ kind, targetDir, value: "", error: null });
    },
    [root, loadDir, rerender],
  );

  const commitCreate = async (draft: CreatingState) => {
    if (submittingRef.current) return;
    const check = validateNewEntryName(draft.value);
    if (!check.ok) {
      setCreating((cur) => (cur ? { ...cur, error: check.error } : null));
      return;
    }

    const fullPath = joinRelativePath(draft.targetDir, check.name);
    submittingRef.current = true;
    try {
      if (draft.kind === "file") {
        await api.fsCreateFile(root, fullPath);
      } else {
        await api.fsCreateDir(root, fullPath);
      }

      const cache = getTreeCache(root);
      const expandDirs =
        draft.kind === "folder" ? ancestorDirs(fullPath) : ancestorDirs(parentDir(fullPath));
      for (const dir of expandDirs) {
        cache.expanded.add(dir);
      }

      const refreshDirs = new Set<string>([draft.targetDir]);
      for (const dir of expandDirs) {
        if (!draft.targetDir || dir === draft.targetDir || dir.startsWith(`${draft.targetDir}/`)) {
          refreshDirs.add(dir);
        }
      }

      cache.selected = { path: fullPath, dir: draft.kind === "folder" };
      ignoreNextBlurRef.current = true;
      setCreating(null);
      rerender();

      await Promise.all([...refreshDirs].map((dir) => loadDir(dir)));

      if (draft.kind === "file") {
        openFile(root, fullPath);
        onOpen?.(fullPath);
      }
    } catch (err) {
      const fsErr = toFsError(err);
      setCreating((cur) => (cur ? { ...cur, error: fsErr.message } : null));
    } finally {
      submittingRef.current = false;
    }
  };

  const handleCreateBlur = () => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    if (!creating || submittingRef.current) return;
    if (creating.value.trim() === "") {
      setCreating(null);
      return;
    }
    if (creating.error) return;
    void commitCreate(creating);
  };

  const startRename = useCallback((entry: SelectedTreeEntry) => {
    setOpError(null);
    setCreating(null);
    ignoreRenameBlurRef.current = false;
    setRenaming({
      path: entry.path,
      dir: entry.dir,
      value: fileName(entry.path),
      error: null,
    });
  }, []);

  const commitRename = async (draft: RenamingState) => {
    if (renameSubmittingRef.current) return;
    const origName = fileName(draft.path);
    const trimmed = draft.value.trim();
    if (trimmed === origName) {
      ignoreRenameBlurRef.current = true;
      setRenaming(null);
      bodyRef.current?.focus();
      return;
    }

    const check = validateRenameName(draft.value);
    if (!check.ok) {
      setRenaming((cur) => (cur ? { ...cur, error: check.error } : null));
      return;
    }

    const dir = parentDir(draft.path);
    const nextPath = joinRelativePath(dir, check.name);
    renameSubmittingRef.current = true;
    try {
      await api.fsRename(root, draft.path, nextPath);
      const cache = getTreeCache(root);
      rewriteCacheAfterRename(cache, root, draft.path, nextPath);
      renamePath(root, draft.path, nextPath);

      ignoreRenameBlurRef.current = true;
      setRenaming(null);
      rerender();

      const dirsToRefresh = new Set<string>([dir]);
      if (draft.dir && cache.expanded.has(nextPath)) {
        dirsToRefresh.add(nextPath);
      }
      await Promise.all([...dirsToRefresh].map((d) => loadDir(d)));
      bodyRef.current?.focus();
    } catch (err) {
      const fsErr = toFsError(err);
      setRenaming((cur) => (cur ? { ...cur, error: fsErr.message } : null));
    } finally {
      renameSubmittingRef.current = false;
    }
  };

  const handleRenameBlur = () => {
    if (ignoreRenameBlurRef.current) {
      ignoreRenameBlurRef.current = false;
      return;
    }
    if (!renaming || renameSubmittingRef.current) return;
    const trimmed = renaming.value.trim();
    if (!trimmed || trimmed === fileName(renaming.path)) {
      setRenaming(null);
      return;
    }
    if (renaming.error) return;
    void commitRename(renaming);
  };

  const handleTrash = useCallback(
    async (entry: SelectedTreeEntry) => {
      setOpError(null);
      const name = fileName(entry.path);
      const message = entry.dir
        ? `'${name}'을(를) 휴지통으로 옮길까요?\n폴더 안의 파일도 함께 옮겨져요.`
        : `'${name}'을(를) 휴지통으로 옮길까요?`;
      const confirmed = await ask(message, {
        title: "휴지통으로 옮기기",
        kind: "warning",
        okLabel: "휴지통으로 옮기기",
        cancelLabel: "취소",
      });
      if (!confirmed) return;

      try {
        await api.fsTrash(root, entry.path);
        const cache = getTreeCache(root);
        pruneCacheAfterDelete(cache, root, entry.path);
        handleDeletedPath(root, entry.path);
        rerender();
        await loadDir(parentDir(entry.path));
      } catch (err) {
        setOpError(toFsError(err).message);
      }
    },
    [root, loadDir, rerender],
  );

  const handleCutOrCopy = useCallback(
    (mode: "copy" | "cut", entry: SelectedTreeEntry) => {
      setOpError(null);
      treeClipboard = { mode, root, paths: [entry.path] };
      rerender();
    },
    [root, rerender],
  );

  const handlePaste = useCallback(
    async (targetDir: string) => {
      const clip = treeClipboard;
      if (!clip || clip.root !== root || clip.paths.length === 0) return;
      setOpError(null);
      const cache = getTreeCache(root);
      const refreshDirs = new Set<string>([targetDir]);
      let lastSelected: SelectedTreeEntry | null = null;

      try {
        for (const srcPath of clip.paths) {
          const cached = findEntryInCache(cache, srcPath);
          const isDir = cached?.dir ?? false;
          if (clip.mode === "copy") {
            const created = await api.fsCopy(root, srcPath, targetDir);
            lastSelected = { path: created, dir: isDir };
          } else {
            const destPath = joinRelativePath(targetDir, fileName(srcPath));
            if (destPath === srcPath) continue;
            await api.fsRename(root, srcPath, destPath);
            rewriteCacheAfterRename(cache, root, srcPath, destPath);
            renamePath(root, srcPath, destPath);
            refreshDirs.add(parentDir(srcPath));
            lastSelected = { path: destPath, dir: isDir };
          }
        }

        if (clip.mode === "cut") {
          treeClipboard = null;
        }
        if (targetDir) {
          for (const dir of ancestorDirs(targetDir)) {
            cache.expanded.add(dir);
          }
        }
        if (lastSelected) {
          cache.selected = lastSelected;
        }
        rerender();
        await Promise.all([...refreshDirs].map((d) => loadDir(d)));
      } catch (err) {
        setOpError(toFsError(err).message);
        await Promise.all([...refreshDirs].map((d) => loadDir(d)));
      }
    },
    [root, loadDir, rerender],
  );

  const handleDuplicate = useCallback(
    async (entry: SelectedTreeEntry) => {
      setOpError(null);
      const dir = parentDir(entry.path);
      try {
        const created = await api.fsCopy(root, entry.path, dir);
        const cache = getTreeCache(root);
        cache.selected = { path: created, dir: entry.dir };
        rerender();
        await loadDir(dir);
      } catch (err) {
        setOpError(toFsError(err).message);
      }
    },
    [root, loadDir, rerender],
  );

  const handleCopyText = useCallback(async (text: string) => {
    setOpError(null);
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      setOpError(`클립보드에 복사하지 못했어요: ${toFsError(err).message}`);
    }
  }, []);

  const handleReveal = useCallback(async (absPath: string) => {
    setOpError(null);
    try {
      await revealItemInDir(absPath);
    } catch (err) {
      setOpError(`폴더를 열지 못했어요: ${toFsError(err).message}`);
    }
  }, []);

  const hasClipboard =
    treeClipboard !== null && treeClipboard.root === root && treeClipboard.paths.length > 0;

  const menuSections = useMemo(() => {
    if (!menu) return [];
    return buildTreeMenuSections({
      kind: menu.kind,
      hasClipboard,
      platform: PLATFORM,
    });
  }, [menu, hasClipboard]);

  const handleMenuSelect = (action: TreeMenuActionId) => {
    const currentMenu = menu;
    if (!currentMenu) return;

    if (currentMenu.kind === "empty") {
      switch (action) {
        case "newFile":
          startCreate("file", "");
          return;
        case "newFolder":
          startCreate("folder", "");
          return;
        case "paste":
          void handlePaste(pasteTargetFolder(null, "empty"));
          return;
        case "refresh":
          void handleRefresh();
          return;
        case "collapseAll":
          handleCollapseAll();
          return;
        case "reveal":
          void handleReveal(root);
          return;
        case "copyPath":
          void handleCopyText(root);
          return;
        default:
          return;
      }
    }

    const entry = currentMenu.entry;
    switch (action) {
      case "newFile":
        startCreate("file", targetFolderForSelection(entry));
        return;
      case "newFolder":
        startCreate("folder", targetFolderForSelection(entry));
        return;
      case "rename":
        startRename(entry);
        return;
      case "delete":
        void handleTrash(entry);
        return;
      case "cut":
        handleCutOrCopy("cut", entry);
        return;
      case "copy":
        handleCutOrCopy("copy", entry);
        return;
      case "paste":
        void handlePaste(pasteTargetFolder(entry, "row"));
        return;
      case "duplicate":
        void handleDuplicate(entry);
        return;
      case "copyPath":
        void handleCopyText(joinPath(root, entry.path));
        return;
      case "copyRelativePath":
        void handleCopyText(entry.path);
        return;
      case "reveal":
        void handleReveal(joinPath(root, entry.path));
        return;
      case "attachToChat":
        if (!entry.dir) attachToComposer([joinPath(root, entry.path)]);
        return;
      default:
        return;
    }
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu || creating || renaming) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

    const cache = getTreeCache(root);
    const selected = cache.selected;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const keyLower = e.key.toLowerCase();

    if (e.key === "F2" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (selected) {
        e.preventDefault();
        startRename(selected);
      }
      return;
    }

    const isDeleteKey =
      (e.key === "Delete" && !e.metaKey && !e.ctrlKey && !e.altKey) ||
      (IS_MAC && e.metaKey && !e.ctrlKey && !e.altKey && e.key === "Backspace");
    if (isDeleteKey) {
      if (selected) {
        e.preventDefault();
        void handleTrash(selected);
      }
      return;
    }

    if (mod && !e.altKey && !e.shiftKey && keyLower === "x") {
      if (selected) {
        e.preventDefault();
        handleCutOrCopy("cut", selected);
      }
      return;
    }

    if (mod && !e.altKey && !e.shiftKey && keyLower === "c") {
      if (selected) {
        e.preventDefault();
        handleCutOrCopy("copy", selected);
      }
      return;
    }

    if (mod && !e.altKey && !e.shiftKey && keyLower === "v") {
      if (hasClipboard) {
        e.preventDefault();
        void handlePaste(pasteTargetFolder(selected, "row"));
      }
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const visible = flattenVisibleEntries(cache);
      if (visible.length === 0) return;
      e.preventDefault();
      const idx = selected ? visible.findIndex((item) => item.path === selected.path) : -1;
      const nextIdx =
        e.key === "ArrowDown"
          ? idx < 0
            ? 0
            : Math.min(idx + 1, visible.length - 1)
          : idx < 0
            ? visible.length - 1
            : Math.max(idx - 1, 0);
      const next = visible[nextIdx];
      cache.selected = { path: next.path, dir: next.dir };
      rerender();
      return;
    }

    if (e.key === "ArrowRight" && selected?.dir) {
      e.preventDefault();
      if (!cache.expanded.has(selected.path)) {
        cache.expanded.add(selected.path);
        rerender();
        if (!cache.children.has(selected.path)) {
          void loadDir(selected.path);
        }
      } else {
        const children = cache.children.get(selected.path);
        if (children && children.length > 0) {
          cache.selected = { path: children[0].path, dir: children[0].dir };
          rerender();
        }
      }
      return;
    }

    if (e.key === "ArrowLeft" && selected) {
      e.preventDefault();
      if (selected.dir && cache.expanded.has(selected.path)) {
        cache.expanded.delete(selected.path);
        rerender();
      } else {
        const parent = parentDir(selected.path);
        if (parent) {
          cache.selected = { path: parent, dir: true };
          rerender();
        }
      }
      return;
    }

    if (e.key === "Enter" && selected && target === bodyRef.current) {
      e.preventDefault();
      if (selected.dir) {
        handleDirClick(selected.path);
      } else {
        handleFileClick(selected.path);
      }
    }
  };

  const renderCreateRow = (depth: number) => {
    if (!creating) return null;
    const paddingLeft = depth * 14 + 8;
    return (
      <div className="code-tree-create">
        <div
          className="code-tree-create-row"
          style={{ paddingLeft: creating.kind === "folder" ? paddingLeft : paddingLeft + 14 }}
        >
          {creating.kind === "folder" ? (
            <>
              <span className="code-tree-chev" />
              <Folder size={14} className="code-tree-icon folder" />
            </>
          ) : (
            <FileIcon path={creating.value} />
          )}
          <input
            ref={inputRef}
            type="text"
            className={`code-tree-create-input${creating.error ? " error" : ""}`}
            value={creating.value}
            placeholder={creating.kind === "file" ? "파일 이름" : "폴더 이름"}
            aria-label={creating.kind === "file" ? "새 파일 이름" : "새 폴더 이름"}
            aria-invalid={creating.error ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const value = e.target.value;
              setCreating((cur) => (cur ? { ...cur, value, error: null } : null));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                ignoreNextBlurRef.current = true;
                setCreating(null);
                bodyRef.current?.focus();
                return;
              }
              if (e.key === "Enter") {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                void commitCreate(creating);
              }
            }}
            onBlur={handleCreateBlur}
          />
        </div>
        {creating.error && (
          <div className="code-tree-create-error" role="alert" style={{ paddingLeft: paddingLeft + 24 }}>
            {creating.error}
          </div>
        )}
      </div>
    );
  };

  const renderRenameRow = (entry: FsEntry, depth: number, isExpanded: boolean) => {
    if (!renaming) return null;
    const paddingLeft = depth * 14 + 8;
    return (
      <div className="code-tree-create">
        <div
          className="code-tree-create-row"
          style={{ paddingLeft: entry.dir ? paddingLeft : paddingLeft + 14 }}
        >
          {entry.dir ? (
            <>
              <span className="code-tree-chev">
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              {isExpanded ? (
                <FolderOpen size={14} className="code-tree-icon folder" />
              ) : (
                <Folder size={14} className="code-tree-icon folder" />
              )}
            </>
          ) : (
            <FileIcon path={renaming.value || entry.path} />
          )}
          <input
            ref={renameInputRef}
            type="text"
            className={`code-tree-create-input${renaming.error ? " error" : ""}`}
            value={renaming.value}
            aria-label={entry.dir ? "폴더 이름 바꾸기" : "파일 이름 바꾸기"}
            aria-invalid={renaming.error ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const value = e.target.value;
              setRenaming((cur) => (cur ? { ...cur, value, error: null } : null));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                ignoreRenameBlurRef.current = true;
                setRenaming(null);
                bodyRef.current?.focus();
                return;
              }
              if (e.key === "Enter") {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                void commitRename(renaming);
              }
            }}
            onBlur={handleRenameBlur}
          />
        </div>
        {renaming.error && (
          <div className="code-tree-create-error" role="alert" style={{ paddingLeft: paddingLeft + 24 }}>
            {renaming.error}
          </div>
        )}
      </div>
    );
  };

  const cache = getTreeCache(root);
  const rootEntries = cache.children.get("");

  const isCutEntry = (path: string) =>
    treeClipboard !== null &&
    treeClipboard.mode === "cut" &&
    treeClipboard.root === root &&
    treeClipboard.paths.includes(path);

  const openRowMenu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setOpError(null);
    cache.selected = { path: entry.path, dir: entry.dir };
    rerender();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      kind: entry.dir ? "folder" : "file",
      entry,
    });
  };

  const renderEntries = (entries: FsEntry[], depth: number): React.ReactNode =>
    entries.map((entry) => {
      const paddingLeft = depth * 14 + 8;
      const isSelected = cache.selected?.path === entry.path;
      const isCut = isCutEntry(entry.path);
      const isRenamingThis = renaming !== null && renaming.path === entry.path;

      if (entry.dir) {
        const isExpanded = cache.expanded.has(entry.path);
        const childEntries = cache.children.get(entry.path);
        const isLoading = loadingDirs.has(entry.path);
        const isCreatingHere = creating !== null && creating.targetDir === entry.path;
        return (
          <div key={entry.path}>
            {isRenamingThis ? (
              renderRenameRow(entry, depth, isExpanded)
            ) : (
              <button
                type="button"
                className={`code-tree-row${isSelected ? " selected" : ""}${isCut ? " cut" : ""}`}
                style={{ paddingLeft }}
                data-path={entry.path}
                title={entry.path}
                aria-expanded={isExpanded}
                onClick={() => handleDirClick(entry.path)}
                onContextMenu={(e) => openRowMenu(e, entry)}
              >
                <span className="code-tree-chev">
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
                {isExpanded ? (
                  <FolderOpen size={14} className="code-tree-icon folder" />
                ) : (
                  <Folder size={14} className="code-tree-icon folder" />
                )}
                <span className="code-tree-name">{entry.name}</span>
              </button>
            )}
            {isExpanded && (
              <div>
                {isCreatingHere && renderCreateRow(depth + 1)}
                {childEntries ? (
                  childEntries.length > 0 ? (
                    renderEntries(childEntries, depth + 1)
                  ) : !isCreatingHere ? (
                    <div className="code-tree-status" style={{ paddingLeft: paddingLeft + 24 }}>
                      비어 있어요
                    </div>
                  ) : null
                ) : isLoading ? (
                  <div className="code-tree-status" style={{ paddingLeft: paddingLeft + 24 }}>
                    불러오는 중...
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      }

      if (isRenamingThis) {
        return <div key={entry.path}>{renderRenameRow(entry, depth, false)}</div>;
      }

      const isActive = active === entry.path;
      return (
        <button
          key={entry.path}
          type="button"
          className={`code-tree-row${isSelected ? " selected" : ""}${isActive ? " active" : ""}${
            isCut ? " cut" : ""
          }`}
          style={{ paddingLeft: paddingLeft + 14 }}
          data-path={entry.path}
          title={entry.path}
          onClick={() => handleFileClick(entry.path)}
          onContextMenu={(e) => openRowMenu(e, entry)}
        >
          <FileIcon path={entry.path} />
          <span className="code-tree-name">{entry.name}</span>
        </button>
      );
    });

  return (
    <div className="code-tree">
      <div className="code-tree-head">
        <span className="code-tree-title" title={root}>
          {fileName(root) || "파일"}
        </span>
        <div className="code-tree-actions">
          <button
            type="button"
            className="code-tree-head-btn"
            title="새 파일"
            aria-label="새 파일"
            disabled={Boolean(error)}
            onClick={() => startCreate("file")}
          >
            <FilePlus size={13} />
          </button>
          <button
            type="button"
            className="code-tree-head-btn"
            title="새 폴더"
            aria-label="새 폴더"
            disabled={Boolean(error)}
            onClick={() => startCreate("folder")}
          >
            <FolderPlus size={13} />
          </button>
          <button
            type="button"
            className="code-tree-head-btn code-tree-refresh"
            title="새로고침"
            aria-label="파일 목록 새로고침"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={13} className={refreshing ? "spin" : undefined} />
          </button>
        </div>
      </div>

      {opError && (
        <div className="code-tree-op-error" role="alert">
          <span>{opError}</span>
          <button
            type="button"
            className="code-tree-op-error-close"
            aria-label="오류 닫기"
            onClick={() => setOpError(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div
        ref={bodyRef}
        className="code-tree-body"
        role="tree"
        aria-label="파일 트리"
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget && cache.selected !== null) {
            cache.selected = null;
            rerender();
          }
        }}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement | null)?.closest("input")) return;
          e.preventDefault();
          setOpError(null);
          if (cache.selected !== null) {
            cache.selected = null;
            rerender();
          }
          setMenu({ x: e.clientX, y: e.clientY, kind: "empty" });
        }}
      >
        {error ? (
          <div className="code-tree-status error">{error}</div>
        ) : !rootEntries ? (
          <div className="code-tree-status">불러오는 중...</div>
        ) : (
          <>
            {creating && creating.targetDir === "" && renderCreateRow(0)}
            {rootEntries.length > 0 ? (
              renderEntries(rootEntries, 0)
            ) : !creating || creating.targetDir !== "" ? (
              <div className="code-tree-status">표시할 파일이 없어요.</div>
            ) : null}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={menuSections}
          ariaLabel="파일 트리 메뉴"
          onSelect={handleMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
