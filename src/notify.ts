/**
 * Desktop notifications for things that need the user while Baton's window
 * isn't focused. The text helpers and the coalescing queue are plain code so
 * they can be tested without Tauri; only `sendDesktop` touches the plugin.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { PermissionRequest, TaskInfo } from "./types";

export type NoticeKind = "turn" | "permission" | "task" | "limit";

export interface Notice {
  kind: NoticeKind;
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Settings

export const NOTIFY_STORE_KEY = "baton.notifications";

export interface NotifySettings {
  enabled: boolean;
  turn: boolean;
  permission: boolean;
  task: boolean;
  limit: boolean;
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  enabled: true,
  turn: true,
  permission: true,
  task: true,
  limit: true,
};

/** Anything missing or malformed falls back to the default (on). */
export function parseNotifySettings(raw: unknown): NotifySettings {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = (k: keyof NotifySettings) => (typeof v[k] === "boolean" ? (v[k] as boolean) : DEFAULT_NOTIFY_SETTINGS[k]);
  return { enabled: pick("enabled"), turn: pick("turn"), permission: pick("permission"), task: pick("task"), limit: pick("limit") };
}

export function loadNotifySettings(): NotifySettings {
  try {
    const raw = localStorage.getItem(NOTIFY_STORE_KEY);
    return parseNotifySettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
}

export function saveNotifySettings(settings: NotifySettings) {
  try {
    localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore: storage may be unavailable.
  }
}

export const allowsNotice = (s: NotifySettings, kind: NoticeKind) => s.enabled && s[kind];

// ---------------------------------------------------------------------------
// Text

export function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PLACEHOLDER_TITLES = new Set(["", "새 대화", "대화"]);

/** The conversation's title, or the agent's name while it has no real title yet. */
export function noticeTitle(sessionTitle: string | undefined, agentName: string | undefined): string {
  const t = sessionTitle?.trim() ?? "";
  if (!PLACEHOLDER_TITLES.has(t)) return t;
  return agentName?.trim() || "Baton";
}

export type TurnOutcome = { stopReason: string } | { error: string };

/**
 * What to say when a turn ends, or null for nothing. A turn the user stopped
 * themselves isn't news to them.
 */
export function turnNotice(outcome: TurnOutcome, opts: { userCancelled?: boolean } = {}): string | null {
  if ("error" in outcome) return truncate(outcome.error || "오류가 났어요");
  switch (outcome.stopReason) {
    case "end_turn":
      return "응답이 끝났어요";
    case "cancelled":
      return opts.userCancelled ? null : "응답이 중단됐어요";
    case "refusal":
      return "에이전트가 요청을 거절했어요";
    default:
      return `응답이 멈췄어요 · ${outcome.stopReason}`;
  }
}

export function permissionNotice(request: Pick<PermissionRequest, "toolCall">): string {
  const tool = request.toolCall?.title?.trim();
  return tool ? `권한 확인이 필요해요: ${truncate(tool, 80)}` : "권한 확인이 필요해요";
}

const isEnded = (s: TaskInfo["status"] | undefined) => s === "done" || s === "failed";

/** Fires once, when a task moves into done or failed. */
export function taskTransitionNotice(prev: TaskInfo | undefined, next: TaskInfo): string | null {
  if (!isEnded(next.status) || prev?.status === next.status) return null;
  return `${next.memberName} · ${next.title} ${next.status === "done" ? "끝났어요" : "실패했어요"}`;
}

/** Fires once, when a running task becomes stalled (silent for minutes). */
export function taskStalledNotice(prev: TaskInfo | undefined, next: TaskInfo): string | null {
  if (next.status !== "running" || next.stalledSince == null || prev?.stalledSince != null) return null;
  return `${next.memberName} · ${next.title}: 응답이 없어요`;
}

/** Fires when a usage limit moved the task to another member. */
export function reassignNotice(prev: TaskInfo | undefined, next: TaskInfo): string | null {
  const before = prev?.reassigned?.length ?? 0;
  if ((next.reassigned?.length ?? 0) <= before) return null;
  return `${next.title}: 사용 한도로 ${next.memberName}에게 넘겼어요`;
}

export const LEAD_LIMIT_NOTICE = "총괄이 사용 한도에 걸렸어요 · 다른 에이전트로 넘길 수 있어요";

/** Several notices at once become one: the first title plus a count, and the first few lines. */
export function summarize(notices: Notice[]): Notice {
  const [first] = notices;
  if (notices.length === 1) return first;
  const lines = notices.slice(0, 3).map((n) => n.body);
  if (notices.length > 3) lines.push("…");
  return { kind: first.kind, title: `${first.title} 외 ${notices.length - 1}건`, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Queue

export const COALESCE_MS = 1500;

/** Collects notices for `windowMs` after the first one, then delivers them as one. */
export function createCoalescer(deliver: (notice: Notice) => void, windowMs = COALESCE_MS) {
  let pending: Notice[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending;
    pending = [];
    if (batch.length) deliver(summarize(batch));
  };
  return {
    push(notice: Notice) {
      pending.push(notice);
      timer ??= setTimeout(flush, windowMs);
    },
    flush,
    get size() {
      return pending.length;
    },
  };
}

export interface NotifierDeps {
  send: (notice: Notice) => void;
  isFocused: () => boolean;
  settings: () => NotifySettings;
  windowMs?: number;
}

export function createNotifier(deps: NotifierDeps) {
  // Re-check focus at delivery: coming back during the wait makes it moot.
  const queue = createCoalescer((n) => {
    if (!deps.isFocused()) deps.send(n);
  }, deps.windowMs);
  return {
    notify(kind: NoticeKind, title: string, body: string | null | undefined) {
      if (!body || deps.isFocused() || !allowsNotice(deps.settings(), kind)) return;
      queue.push({ kind, title, body });
    },
    flush: queue.flush,
  };
}

// ---------------------------------------------------------------------------
// Focus

let focused = typeof document === "undefined" ? true : document.hasFocus();

export const isAppFocused = () =>
  focused && (typeof document === "undefined" || document.visibilityState !== "hidden");

/** Follow the window's focus; returns a cleanup function. */
export function trackFocus(): () => void {
  focused = document.hasFocus();
  const onFocus = () => (focused = true);
  const onBlur = () => (focused = false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  let disposed = false;
  let unlisten: (() => void) | null = null;
  // The native window's own focus events cover cases the webview misses.
  getCurrentWindow()
    .onFocusChanged(({ payload }) => (focused = payload))
    .then((off) => (disposed ? off() : (unlisten = off)))
    .catch(() => {});
  return () => {
    disposed = true;
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    unlisten?.();
  };
}

// ---------------------------------------------------------------------------
// Desktop

let asked = false;

/** Asks the OS once per run; later calls only check. */
async function ensurePermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    if (asked) return false;
    asked = true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function sendDesktop(notice: Pick<Notice, "title" | "body">): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  try {
    sendNotification({ title: notice.title, body: notice.body });
    return true;
  } catch (e) {
    console.info("알림을 보내지 못했어요:", e);
    return false;
  }
}

export const notifier = createNotifier({
  send: (n) => void sendDesktop(n),
  isFocused: isAppFocused,
  settings: loadNotifySettings,
});
