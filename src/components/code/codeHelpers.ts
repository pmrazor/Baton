// Pure helpers for the file tree and code editor. Kept free of CodeMirror and
// Tauri imports so tests stay fast and the main bundle stays small.

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "rust"
  | "python"
  | "json"
  | "css"
  | "html"
  | "markdown"
  | "yaml"
  | "toml"
  | null;

/** Normalize a relative path to `/`-separated form without leading `./` or `/`. */
export function normalizeRelativePath(rel: string): string {
  const parts = rel
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".");
  return parts.join("/");
}

/** Normalize an absolute root or file path for prefix comparison. */
export function normalizeAbsolutePath(p: string): string {
  const slashes = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (slashes === "/") return "/";
  if (/^[A-Za-z]:\/$/.test(slashes)) return `${slashes[0].toLowerCase()}:/`;
  const trimmed = slashes.replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(trimmed)) {
    return `${trimmed[0].toLowerCase()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

/** Join a workspace `root` and a `/`-separated relative `rel` path, keeping
 *  the root's native separator style (`\` on Windows paths, `/` on POSIX). */
export function joinPath(root: string, rel: string): string {
  const isWindows = root.includes("\\") || /^[A-Za-z]:/.test(root);
  const sep = isWindows ? "\\" : "/";
  const cleanRoot = root.replace(/[\\/]+$/, "");
  const cleanRel = normalizeRelativePath(rel);
  if (!cleanRel) return cleanRoot || root;
  const nativeRel = isWindows ? cleanRel.replace(/\//g, "\\") : cleanRel;
  if (!cleanRoot) return `${sep}${nativeRel}`;
  return `${cleanRoot}${sep}${nativeRel}`;
}

/** Join two relative path segments into a `/`-separated relative path. */
export function joinRelativePath(dir: string, name: string): string {
  const a = normalizeRelativePath(dir);
  const b = normalizeRelativePath(name);
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

/** Basename of a relative or absolute path. */
export function fileName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** Return `absPath` relative to `root` (`/`-separated), or null if outside `root`. */
export function relativeToRoot(root: string, absPath: string): string | null {
  const normRoot = normalizeAbsolutePath(root);
  const normAbs = normalizeAbsolutePath(absPath);
  if (!normRoot || !normAbs || normAbs === normRoot) return null;
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  if (!normAbs.startsWith(prefix)) return null;
  const rel = normalizeRelativePath(normAbs.slice(prefix.length));
  return rel || null;
}

/** Pick the most specific (longest) known root that contains `absPath`. */
export function findContainingRoot(
  roots: Iterable<string>,
  absPath: string,
): { root: string; path: string } | null {
  let best: { root: string; path: string; rootLen: number } | null = null;
  for (const root of roots) {
    const rel = relativeToRoot(root, absPath);
    if (rel === null) continue;
    const rootLen = normalizeAbsolutePath(root).length;
    if (!best || rootLen > best.rootLen) {
      best = { root, path: rel, rootLen };
    }
  }
  return best ? { root: best.root, path: best.path } : null;
}

const EXT_TO_LANG: Record<string, Exclude<LanguageId, null>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  pyi: "python",
  pyw: "python",
  json: "json",
  jsonc: "json",
  webmanifest: "json",
  css: "css",
  html: "html",
  htm: "html",
  xhtml: "html",
  svg: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
};

const BASENAME_TO_LANG: Record<string, Exclude<LanguageId, null>> = {
  "cargo.lock": "toml",
};

/** Map a file path to its CodeMirror language id, or null for plain text. */
export function languageForPath(path: string): LanguageId {
  const base = fileName(path).toLowerCase();
  if (base in BASENAME_TO_LANG) return BASENAME_TO_LANG[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? null;
}

/** Pick the next active tab after closing `closing`: keep `active` if it stays,
 *  otherwise take the right neighbour, or the left one at the end. */
export function nextActiveAfterClose(
  paths: string[],
  active: string | null,
  closing: string,
): string | null {
  const rest = paths.filter((p) => p !== closing);
  if (active !== closing && active !== null && rest.includes(active)) return active;
  const idx = paths.indexOf(closing);
  if (rest.length === 0) return null;
  if (idx < 0) return rest[0];
  return rest[Math.min(idx, rest.length - 1)];
}

export interface SelectedTreeEntry {
  path: string;
  dir: boolean;
}

/** Parent folder of a relative path (`""` for top-level entries). */
export function parentDir(path: string): string {
  const norm = normalizeRelativePath(path);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(0, idx) : "";
}

/** Pick the target folder (`""` for root) for creating a new file or folder.
 *  - Selected folder -> inside that folder
 *  - Selected file   -> that file's parent folder
 *  - Nothing selected -> root (`""`) */
export function targetFolderForSelection(selected: SelectedTreeEntry | null): string {
  if (!selected) return "";
  const norm = normalizeRelativePath(selected.path);
  if (!norm) return "";
  return selected.dir ? norm : parentDir(norm);
}

/** Ancestor folders of `dir` from shallowest to deepest, including `dir` itself.
 *  Returns `[]` for root (`""`). */
export function ancestorDirs(dir: string): string[] {
  const norm = normalizeRelativePath(dir);
  if (!norm) return [];
  const parts = norm.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join("/"));
  }
  return out;
}

export type EntryNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Validate a user-entered name for a new file or folder (supports nested `/`-separated paths). */
export function validateNewEntryName(raw: string): EntryNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "이름을 입력해 주세요." };
  }
  if (name.includes("\\")) {
    return { ok: false, error: "역슬래시(\\)는 사용할 수 없어요." };
  }
  if (name.includes("\0")) {
    return { ok: false, error: "올바르지 않은 이름이에요." };
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return { ok: false, error: "경로는 '/'로 시작하거나 끝날 수 없어요." };
  }
  for (const seg of name.split("/")) {
    if (seg.trim().length === 0) {
      return { ok: false, error: "빈 경로 이름은 사용할 수 없어요." };
    }
    if (seg === "." || seg === "..") {
      return { ok: false, error: "'.'이나 '..'은 사용할 수 없어요." };
    }
  }
  return { ok: true, name };
}

/** Validate a single-segment entry name for inline rename. */
export function validateRenameName(raw: string): EntryNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "이름을 입력해 주세요." };
  }
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, error: "이름에는 '/'나 '\\'를 사용할 수 없어요." };
  }
  if (name.includes("\0")) {
    return { ok: false, error: "올바르지 않은 이름이에요." };
  }
  if (name === "." || name === "..") {
    return { ok: false, error: "'.'이나 '..'은 사용할 수 없어요." };
  }
  return { ok: true, name };
}

/** Selection end index when starting inline rename: excludes extension for files. */
export function renameSelectionEnd(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return dot;
  return name.length;
}

/** Split an entry name into `(stem, ext)` for copy naming. Folders keep their full name as stem. */
export function splitNameForCopy(name: string, isDir = false): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }
  return { stem: name, ext: "" };
}

/** Pick a non-clashing copy name in a folder: keeps `name` if unused,
 *  otherwise tries `name copy.ext`, `name copy 2.ext`, `name copy 3.ext`, ... */
export function nextCopyName(
  name: string,
  existingNames: Iterable<string>,
  isDir = false,
): string {
  const existing = new Set(existingNames);
  if (!existing.has(name)) return name;
  const { stem, ext } = splitNameForCopy(name, isDir);
  const first = `${stem} copy${ext}`;
  if (!existing.has(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${stem} copy ${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Pick the destination folder (`""` for root) when pasting in the file tree. */
export function pasteTargetFolder(
  selected: SelectedTreeEntry | null,
  context: "row" | "empty" = "row",
): string {
  if (context === "empty") return "";
  return targetFolderForSelection(selected);
}

/** True when `path` equals `prefix` or is a descendant inside `prefix`. */
export function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normPath = normalizeRelativePath(path);
  const normPrefix = normalizeRelativePath(prefix);
  if (!normPrefix) return false;
  return normPath === normPrefix || normPath.startsWith(`${normPrefix}/`);
}

/** Rewrite `path` when `from` (a file or folder) is renamed/moved to `to`. */
export function rewritePathPrefix(path: string, from: string, to: string): string {
  const normPath = normalizeRelativePath(path);
  const normFrom = normalizeRelativePath(from);
  const normTo = normalizeRelativePath(to);
  if (!normFrom || !normTo) return normPath;
  if (normPath === normFrom) return normTo;
  if (normPath.startsWith(`${normFrom}/`)) {
    return `${normTo}${normPath.slice(normFrom.length)}`;
  }
  return normPath;
}

/** Clamp a floating menu's top-left coordinates so it stays inside the viewport. */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}

export type Platform = "mac" | "windows" | "linux";

export function detectPlatform(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
): Platform {
  if (/Mac/i.test(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  return "linux";
}

export function revealLabelForPlatform(platform: Platform, mode: "reveal" | "open"): string {
  if (platform === "mac") return mode === "reveal" ? "Finder에서 보기" : "Finder에서 열기";
  if (platform === "windows") return mode === "reveal" ? "탐색기에서 보기" : "탐색기에서 열기";
  return mode === "reveal" ? "파일 관리자에서 보기" : "파일 관리자에서 열기";
}

export type TreeMenuKind = "file" | "folder" | "empty";

export type TreeMenuActionId =
  | "newFile"
  | "newFolder"
  | "rename"
  | "delete"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "copyPath"
  | "copyRelativePath"
  | "reveal"
  | "attachToChat"
  | "refresh"
  | "collapseAll";

export interface TreeMenuItem {
  id: TreeMenuActionId;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface TreeMenuSection {
  id: string;
  items: TreeMenuItem[];
}

/** Build the VS Code-style context menu sections for a file, folder, or empty tree space. */
export function buildTreeMenuSections(opts: {
  kind: TreeMenuKind;
  hasClipboard: boolean;
  platform: Platform;
}): TreeMenuSection[] {
  const { kind, hasClipboard, platform } = opts;
  const mod = platform === "mac" ? "⌘" : "Ctrl+";
  const deleteShortcut = platform === "mac" ? "⌘⌫" : "Delete";

  if (kind === "empty") {
    return [
      {
        id: "create",
        items: [
          { id: "newFile", label: "새 파일…" },
          { id: "newFolder", label: "새 폴더…" },
        ],
      },
      {
        id: "clipboard",
        items: [{ id: "paste", label: "붙여넣기", shortcut: `${mod}V`, disabled: !hasClipboard }],
      },
      {
        id: "tree",
        items: [
          { id: "refresh", label: "새로고침" },
          { id: "collapseAll", label: "모두 접기" },
        ],
      },
      {
        id: "system",
        items: [
          { id: "reveal", label: revealLabelForPlatform(platform, "open") },
          { id: "copyPath", label: "경로 복사" },
        ],
      },
    ];
  }

  const systemItems: TreeMenuItem[] = [
    { id: "copyPath", label: "경로 복사" },
    { id: "copyRelativePath", label: "상대 경로 복사" },
    { id: "reveal", label: revealLabelForPlatform(platform, "reveal") },
  ];
  if (kind === "file") {
    systemItems.push({ id: "attachToChat", label: "채팅에 첨부" });
  }

  return [
    {
      id: "create",
      items: [
        { id: "newFile", label: "새 파일…" },
        { id: "newFolder", label: "새 폴더…" },
      ],
    },
    {
      id: "clipboard",
      items: [
        { id: "cut", label: "잘라내기", shortcut: `${mod}X` },
        { id: "copy", label: "복사", shortcut: `${mod}C` },
        { id: "paste", label: "붙여넣기", shortcut: `${mod}V`, disabled: !hasClipboard },
        { id: "duplicate", label: "복제" },
      ],
    },
    {
      id: "edit",
      items: [
        { id: "rename", label: "이름 바꾸기…", shortcut: "F2" },
        { id: "delete", label: "삭제", shortcut: deleteShortcut, danger: true },
      ],
    },
    {
      id: "system",
      items: systemItems,
    },
  ];
}
