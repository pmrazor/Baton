import { groupTurns } from "./components/Turn";
import { accountKey, profileOf, type AccountUsage, type Session, type TaskInfo } from "./types";

/** Brief header shown in the new lead chat for the handoff memo. */
export const HANDOFF_BRIEF_LABEL = "이전 총괄에게서 인수인계";

const MAX_MSG_CHARS = 1500;
const MAX_MEMO_CHARS = 24_000;
const TRUNC_SUFFIX = "… [truncated]";

const LIMIT_PHRASES = [
  "usage limit",
  "rate limit",
  "usagelimitexceeded",
  "ratelimitexceeded",
  "resource_exhausted",
  "quota exceeded",
];

/** Whether an error message indicates the account hit a usage / rate limit. */
export function isLimitError(message: string): boolean {
  const s = message.toLowerCase();
  if (s.includes("hit your") && s.includes("limit")) return true;
  if (LIMIT_PHRASES.some((p) => s.includes(p))) return true;
  return /(?:^|\D)429(?:\D|$)/.test(s);
}

/** Whether an account's usage report shows an active limit (future or unknown reset). */
export function accountLimit(usage: AccountUsage | undefined, now = Date.now()): { resetsAt?: number } | null {
  if (!usage) return null;
  const hit = Object.values(usage.entries).filter(
    (e) => e.status === "limited" && (e.resetsAt === undefined || e.resetsAt > now),
  );
  if (hit.length === 0) return null;
  const resets = hit.map((e) => e.resetsAt).filter((r): r is number => r !== undefined);
  return { resetsAt: resets.length > 0 ? Math.max(...resets) : undefined };
}

/** Whether a lead session should show the usage-limit handoff banner. */
export function leadLimit(
  session: Session | null,
  accountUsage: Record<string, AccountUsage>,
  now = Date.now(),
): { resetsAt?: number } | null {
  if (!session?.lead || session.draft) return null;
  if (session.limited?.dismissed) return null;
  const acc = accountLimit(accountUsage[accountKey(session.agentId, profileOf(session.launch))], now);
  if (session.limited) return { resetsAt: session.limited.resetsAt ?? acc?.resetsAt };
  if (session.handedTo) return null;
  return acc;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - TRUNC_SUFFIX.length))}${TRUNC_SUFFIX}`;
}

function formatTasks(tasks: TaskInfo[] | undefined): string {
  if (!tasks || tasks.length === 0) return "";
  const lines = tasks.map((t) => {
    const parts = [`- [${t.id}] "${t.title}" (${t.memberName}) — status: ${t.status}`];
    if (t.mergeState) parts.push(`mergeState: ${t.mergeState}`);
    if (t.changes.length > 0) parts.push(`changed files: ${t.changes.join(", ")}`);
    if (t.error) parts.push(`error: ${truncate(t.error, 300)}`);
    return parts.join("; ");
  });
  return [
    "## Tasks",
    "These tasks now belong to you. Use get_result, wait, or merge_task with these task ids.",
    ...lines,
  ].join("\n");
}

/** Build the first message sent to a replacement lead taking over a rate-limited conversation. */
export function handoffMemo(oldSession: Session, agentName: string): string {
  const header = `[Baton handoff — note from the app] The previous lead (${agentName}) hit its usage limit. You are taking over this conversation with the same team. Below is a summary Baton kept; details the previous lead only had in its head are not included, so re-read files as needed.`;
  const footer =
    "Start by calling list_agents and checking unfinished tasks, then continue the user's request. First reply to the user in Korean, briefly saying what you picked up.";

  const tasksBlock = formatTasks(oldSession.tasks);

  const turnBlocks: string[] = [];
  for (const turn of groupTurns(oldSession.items)) {
    const lines: string[] = [];
    if (turn.user) {
      const label = turn.user.kind === "brief" ? "Handoff" : "User";
      const body = turn.user.text.trim();
      const files =
        turn.user.attachments && turn.user.attachments.length > 0
          ? ` [attachments: ${turn.user.attachments.map((a) => a.path).join(", ")}]`
          : "";
      if (body || files) {
        lines.push(`${label}: ${truncate(body, MAX_MSG_CHARS)}${files}`.trimEnd());
      }
    }
    if (turn.answer && turn.answer.kind === "assistant" && turn.answer.text.trim()) {
      lines.push(`Lead: ${truncate(turn.answer.text, MAX_MSG_CHARS)}`);
    }
    if (lines.length > 0) turnBlocks.push(lines.join("\n"));
  }

  let conversationBlock = "";
  if (turnBlocks.length > 0) {
    const fixedParts = [header, tasksBlock, footer].filter(Boolean);
    const convHeading = "## Conversation\n";
    // Reserve space for header, tasks, footer, section separators, and heading.
    const overhead = fixedParts.join("\n\n").length + 2 + convHeading.length;
    const budget = Math.max(0, MAX_MEMO_CHARS - overhead);
    const omitReserve = `(${turnBlocks.length} earlier turns omitted)\n\n`.length;

    const kept: string[] = [];
    let used = 0;
    for (let i = turnBlocks.length - 1; i >= 0; i--) {
      const block = turnBlocks[i];
      const sep = kept.length > 0 ? 2 : 0;
      const reserve = i > 0 ? omitReserve : 0;
      if (used + sep + block.length + reserve <= budget) {
        kept.push(block);
        used += sep + block.length;
      } else {
        break;
      }
    }
    kept.reverse();
    const omitted = turnBlocks.length - kept.length;
    const bodyParts: string[] = [];
    if (omitted > 0) {
      bodyParts.push(`(${omitted} earlier ${omitted === 1 ? "turn" : "turns"} omitted)`);
    }
    if (kept.length > 0) {
      bodyParts.push(...kept);
    }
    conversationBlock = `${convHeading}${bodyParts.join("\n\n")}`;
  }

  return [header, conversationBlock, tasksBlock, footer].filter(Boolean).join("\n\n");
}
