import { useEffect, useRef, useSyncExternalStore } from "react";
import { Plus, X } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, subscribeTerminals } from "../api";
import { nextTabNumber, tabAfterClose, terminalId, terminalNumber } from "./terminalTabs";

/** One shell per sub-tab, kept here rather than in React state so the shell and
 *  its scrollback outlive the tab and the chat: a view only borrows `el`. The id
 *  is `<folder>#<n>`, so a reloaded webview finds its shells again. */
interface Entry {
  id: string;
  cwd: string;
  /** The "터미널 n" label. */
  n: number;
  term: Terminal;
  fit: FitAddon;
  /** The terminal's element, moved into whichever view shows this tab. */
  el: HTMLDivElement;
  opened: boolean;
  running: boolean;
  starting: boolean;
  /** The tab was closed; a shell still starting is closed once it's up. */
  closed: boolean;
  /** Input typed while the previous write is in flight, sent next so keys stay in order. */
  queue: string;
  writing: boolean;
}

interface TabView {
  id: string;
  n: number;
  running: boolean;
}

/** What a view shows for a folder, replaced on every change. */
interface FolderView {
  tabs: TabView[];
  active: string | null;
}

/** A folder's sub-tabs. */
interface Folder {
  tabs: Entry[];
  active: string | null;
  /** The highest number handed out since the folder last had no tabs. */
  last: number;
  view: FolderView;
}

const entries = new Map<string, Entry>();
const folders = new Map<string, Folder>();
const loading = new Map<string, Promise<void>>();
/** Closed while running: their exit is still on its way and is dropped, so it
 *  can't end a new tab that gets the same id. */
const ending = new Set<string>();
const subscribers = new Set<() => void>();
const isMac = navigator.userAgent.includes("Mac");
let listening: Promise<unknown> | null = null;

// Load the mono fonts before xterm measures its cells.
const fontsReady = Promise.all([
  document.fonts.load('13px "JetBrains Mono Variable"'),
  document.fonts.load("13px D2Coding", "가"),
]).catch(() => undefined);

function changed(f: Folder | undefined) {
  if (!f) return;
  f.view = { tabs: f.tabs.map((e) => ({ id: e.id, n: e.n, running: e.running })), active: f.active };
  subscribers.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
}

function listen() {
  listening ??= subscribeTerminals(
    (id, data) => {
      if (!ending.has(id)) entries.get(id)?.term.write(data);
    },
    (id, code, gone) => {
      if (ending.delete(id)) return;
      const e = entries.get(id);
      if (!e) return;
      // Its folder was removed (a finished task's worktree): nothing to restart.
      e.running = false;
      if (gone) return closeTab(e.cwd, id);
      e.term.write(`\r\n\x1b[2m[셸이 종료됐어요 (코드 ${code}). Enter를 누르면 다시 시작해요.]\x1b[0m\r\n`);
      changed(folders.get(e.cwd));
    },
  ).catch((err) => {
    listening = null;
    throw err;
  });
  return listening;
}

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const accent = v("--accent");
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--text"),
    cursorAccent: v("--bg"),
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}${dark ? "59" : "40"}` : undefined,
    // Black and white must stay readable on either background.
    black: dark ? v("--surface-3") : v("--text"),
    brightBlack: v("--muted"),
    white: dark ? v("--text-2") : v("--muted"),
    brightWhite: dark ? v("--text") : v("--text-2"),
    red: v("--danger"),
    brightRed: v("--danger"),
    green: v("--ok"),
    brightGreen: v("--ok"),
    yellow: v("--warn"),
    brightYellow: v("--warn"),
    blue: accent,
    brightBlue: accent,
    magenta: v("--brand"),
    brightMagenta: v("--brand"),
    cyan: dark ? "#4cc2c9" : "#1b8a9b",
    brightCyan: dark ? "#4cc2c9" : "#1b8a9b",
  };
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const t = theme();
  entries.forEach((e) => (e.term.options.theme = t));
});

function send(e: Entry, data: string) {
  e.queue += data;
  if (e.writing) return;
  e.writing = true;
  void (async () => {
    while (e.queue && !e.closed) {
      const chunk = e.queue;
      e.queue = "";
      await api.terminalWrite(e.id, chunk).catch(() => undefined);
    }
    e.writing = false;
  })();
}

async function start(e: Entry) {
  if (e.starting || e.closed) return;
  e.starting = true;
  // Set first: a shell that exits at once reports it before `terminalOpen` returns.
  e.running = true;
  changed(folders.get(e.cwd));
  try {
    await listen();
    const fresh = await api.terminalOpen(e.id, e.cwd, e.term.cols, e.term.rows);
    // Closed meanwhile: the close may have reached the backend before the shell did.
    if (e.closed) return void api.terminalClose(e.id).catch(() => undefined);
    if (!fresh) e.term.write("\x1b[2m[실행 중인 셸에 다시 연결했어요]\x1b[0m\r\n");
    // The view may have been resized while the shell started.
    await api.terminalResize(e.id, e.term.cols, e.term.rows);
  } catch (err) {
    e.running = false;
    if (e.closed) ending.delete(e.id);
    else e.term.write(`\r\n\x1b[31m터미널을 열지 못했어요: ${String(err)}\x1b[0m\r\n\x1b[2m[Enter를 누르면 다시 시도해요.]\x1b[0m\r\n`);
  } finally {
    e.starting = false;
    changed(folders.get(e.cwd));
  }
}

/** A new tab's terminal; its xterm opens and its shell starts when first shown. */
function addEntry(f: Folder, cwd: string, n: number): Entry {
  const id = terminalId(cwd, n);
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontFamily: css.getPropertyValue("--mono").trim(),
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "terminal-screen";
  const e: Entry = {
    id,
    cwd,
    n,
    term,
    fit,
    el,
    opened: false,
    running: false,
    starting: false,
    closed: false,
    queue: "",
    writing: false,
  };

  term.onData((data) => {
    if (e.running) send(e, data);
    else if (!e.starting && data.includes("\r")) void start(e);
  });
  term.onResize(({ cols, rows }) => {
    if (e.running) void api.terminalResize(id, cols, rows).catch(() => undefined);
  });
  // macOS copies with Cmd+C. Elsewhere Ctrl+C copies a selection and is
  // SIGINT without one; Ctrl+V pastes (the browser's paste reaches xterm).
  term.attachCustomKeyEventHandler((ev) => {
    if (isMac || ev.type !== "keydown" || !ev.ctrlKey || ev.shiftKey || ev.altKey) return true;
    const key = ev.key.toLowerCase();
    if (key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    return key !== "v";
  });
  entries.set(id, e);
  f.tabs.push(e);
  f.last = Math.max(f.last, n);
  return e;
}

/** The folder's tabs, set up the first time it's shown: the shells still
 *  running from before a webview reload, or else a fresh 터미널 1. */
function ensureFolder(cwd: string): Promise<void> {
  if (folders.has(cwd)) return Promise.resolve();
  let pending = loading.get(cwd);
  if (!pending) {
    pending = (async () => {
      await fontsReady;
      // Listen first, so a listed shell's exit isn't missed.
      const live = await listen()
        .then(() => api.terminalList())
        .catch(() => []);
      const numbers = live
        .filter((t) => t.cwd === cwd)
        .map((t) => terminalNumber(t.id, cwd))
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      const f: Folder = { tabs: [], active: null, last: 0, view: { tabs: [], active: null } };
      for (const n of numbers.length > 0 ? numbers : [1]) addEntry(f, cwd, n);
      f.active = f.tabs[0].id;
      folders.set(cwd, f);
      changed(f);
    })().finally(() => loading.delete(cwd));
    loading.set(cwd, pending);
  }
  return pending;
}

function newTab(cwd: string) {
  const f = folders.get(cwd);
  if (!f) return;
  const n = nextTabNumber(f.last, f.tabs.map((e) => e.n));
  f.active = addEntry(f, cwd, n).id;
  changed(f);
}

function selectTab(cwd: string, id: string) {
  const f = folders.get(cwd);
  if (!f || f.active === id) return;
  f.active = id;
  changed(f);
}

/** End the tab's shell and drop its xterm. */
function closeTab(cwd: string, id: string) {
  const f = folders.get(cwd);
  const e = entries.get(id);
  if (!f || !e) return;
  f.active = tabAfterClose(f.tabs.map((t) => t.id), f.active, id);
  f.tabs = f.tabs.filter((t) => t !== e);
  if (f.tabs.length === 0) f.last = 0;
  entries.delete(id);
  e.closed = true;
  if (e.running) {
    ending.add(id);
    void api.terminalClose(id).catch(() => undefined);
  }
  e.el.remove();
  e.term.dispose();
  changed(f);
}

const focus = (id: string | null | undefined) => id && entries.get(id)?.term.focus();

/** The terminal of one tab, attached while it's the active one. */
function Screen({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const e = entries.get(id);
    if (!e) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Nothing to measure while hidden.
        if (!e.closed && host.clientWidth > 0 && host.clientHeight > 0) e.fit.fit();
      });
    };
    host.appendChild(e.el);
    if (!e.opened) {
      e.term.open(e.el);
      e.opened = true;
      e.fit.fit();
      void start(e);
    }
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    fit();
    e.term.focus();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      e.el.remove();
    };
  }, [id]);

  return <div className="terminal-view" ref={hostRef} />;
}

function TabStrip({ cwd, view }: { cwd: string; view: FolderView | null }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const active = view?.active;
  const count = view?.tabs.length;

  // Keep the active tab in sight.
  useEffect(() => {
    stripRef.current
      ?.querySelector(".terminal-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, count]);

  const close = (id: string) => {
    closeTab(cwd, id);
    // Closing another tab leaves the active one as it was; keys go back to it.
    focus(folders.get(cwd)?.active);
  };

  return (
    <div
      className="terminal-tabs"
      ref={stripRef}
      role="tablist"
      aria-label="터미널"
      // A plain mouse wheel scrolls the strip sideways.
      onWheel={(ev) => {
        if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) ev.currentTarget.scrollLeft += ev.deltaY;
      }}
    >
      {view?.tabs.map((t) => (
        <div
          key={t.id}
          className={`terminal-tab${t.id === active ? " active" : ""}${t.running ? "" : " ended"}`}
          title={t.running ? undefined : "셸이 종료됐어요"}
          // Middle-click closes, without starting autoscroll.
          onMouseDown={(ev) => ev.button === 1 && ev.preventDefault()}
          onAuxClick={(ev) => ev.button === 1 && close(t.id)}
        >
          <button
            className="terminal-tab-label"
            role="tab"
            aria-selected={t.id === active}
            onClick={() => (t.id === active ? focus(t.id) : selectTab(cwd, t.id))}
          >
            터미널 {t.n}
          </button>
          <button className="terminal-tab-close" aria-label={`터미널 ${t.n} 닫기`} title="닫기" onClick={() => close(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
      {view && (
        <button className="terminal-tab-add" aria-label="새 터미널" title="새 터미널" onClick={() => newTab(cwd)}>
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}

/** The folder's interactive shells, one per sub-tab. */
export default function TerminalView({ cwd }: { cwd: string }) {
  const view = useSyncExternalStore(subscribe, () => folders.get(cwd)?.view ?? null);

  useEffect(() => {
    void ensureFolder(cwd);
  }, [cwd]);

  return (
    <div className="terminal-pane">
      <TabStrip cwd={cwd} view={view} />
      {!view ? (
        <div className="terminal-view" />
      ) : view.active ? (
        <Screen id={view.active} />
      ) : (
        <div className="terminal-empty">
          <p className="muted">열린 터미널이 없어요.</p>
          <button className="btn btn-primary" onClick={() => newTab(cwd)}>
            <Plus size={16} /> 새 터미널
          </button>
        </div>
      )}
    </div>
  );
}
