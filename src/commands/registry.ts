export interface Command {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  shortcut?: string;
  when?: () => boolean;
  run: () => void;
}

const RECENT_STORAGE_KEY = "baton.recentCommands";
const MAX_RECENT = 50;

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Read recently executed command ids (most recent first). */
export function readRecentCommandIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** Record a command id as the most recently used. */
export function recordRecentCommand(id: string): void {
  if (!id) return;
  try {
    const next = [id, ...readRecentCommandIds().filter((x) => x !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore when storage is unavailable.
  }
  notify();
}

/** Register a command in the global palette; returns a disposer to unregister it. */
export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd);
  notify();
  return () => {
    if (commands.get(cmd.id) === cmd) {
      commands.delete(cmd.id);
      notify();
    }
  };
}

/** List currently available commands (passing `when`), ordered with recently-used first. */
export function listCommands(): Command[] {
  const available = Array.from(commands.values()).filter((cmd) => !cmd.when || cmd.when());
  const recent = readRecentCommandIds();
  if (recent.length === 0) return available;

  const rank = new Map<string, number>();
  recent.forEach((id, idx) => rank.set(id, idx));

  return available
    .map((cmd, order) => ({ cmd, order, recentIdx: rank.get(cmd.id) }))
    .sort((a, b) => {
      const aHas = a.recentIdx !== undefined;
      const bHas = b.recentIdx !== undefined;
      if (aHas && bHas) return a.recentIdx! - b.recentIdx!;
      if (aHas) return -1;
      if (bHas) return 1;
      return a.order - b.order;
    })
    .map((x) => x.cmd);
}

/** Execute a command and record it in the recently-used list. */
export function executeCommand(cmd: Command): void {
  recordRecentCommand(cmd.id);
  cmd.run();
}

/** Subscribe to command registration or recent-order updates. */
export function subscribeCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Clear all registered commands (intended for unit tests). */
export function resetCommandRegistry(): void {
  commands.clear();
  listeners.clear();
}

export type CommandCenterShortcut = "quick" | "commands" | "conversations";

/**
 * ⌘P / Ctrl+P opens quick open;
 * ⌘⇧P / Ctrl+Shift+P opens command mode (`>`);
 * ⌘⇧H / Ctrl+Shift+H opens conversation content search (`#`).
 */
export function isCommandCenterShortcut(
  e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): CommandCenterShortcut | null {
  if (e.altKey) return null;
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const lower = e.key.toLowerCase();
  if (lower === "p" || e.code === "KeyP") {
    return e.shiftKey ? "commands" : "quick";
  }
  if (e.shiftKey && (lower === "h" || e.code === "KeyH")) {
    return "conversations";
  }
  return null;
}

export type PaletteMode = "quick" | "command" | "line" | "conversation";

export interface ParsedPaletteInput {
  mode: PaletteMode;
  query: string;
  /** 1-based line number when `mode === "line"` and input parses as a positive integer. */
  line: number | null;
}

/** Parse raw command-center input into quick-open, command (`>`), go-to-line (`:`), or conversation search (`#`) mode. */
export function parsePaletteInput(raw: string): ParsedPaletteInput {
  if (raw.startsWith(">")) {
    return { mode: "command", query: raw.slice(1).trim(), line: null };
  }
  if (raw.startsWith(":")) {
    const rest = raw.slice(1).trim();
    const parsed = /^\d+$/.test(rest) ? Number.parseInt(rest, 10) : null;
    return { mode: "line", query: rest, line: parsed !== null && parsed >= 1 ? parsed : null };
  }
  if (raw.startsWith("#")) {
    return { mode: "conversation", query: raw.slice(1).trim(), line: null };
  }
  return { mode: "quick", query: raw.trim(), line: null };
}
