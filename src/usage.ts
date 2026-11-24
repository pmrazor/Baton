// Account-level usage reported by agents, normalised to QuotaEntry.
// Each agent family reports this differently; add an extractor per family.

import type { QuotaEntry } from "./types";

const CLAUDE_LIMIT_LABEL: Record<string, string> = {
  five_hour: "5시간 한도",
  seven_day: "주간 한도",
  seven_day_opus: "주간 Opus 한도",
  seven_day_sonnet: "주간 Sonnet 한도",
  seven_day_overage_included: "주간 한도 (추가 사용량 포함)",
  overage: "추가 사용량",
};

const CLAUDE_STATUS: Record<string, QuotaEntry["status"]> = {
  allowed: "ok",
  allowed_warning: "warning",
  rejected: "limited",
};

function claudeEntry(type: string, w: any, detail?: string): QuotaEntry {
  const util = typeof w.utilization === "number" ? w.utilization : undefined;
  const resets = typeof w.resetsAt === "number" ? w.resetsAt : undefined;
  return {
    id: `claude:${type}`,
    label: CLAUDE_LIMIT_LABEL[type] ?? "구독 한도",
    status: CLAUDE_STATUS[w.status] ?? "ok",
    // Reported as a 0–1 fraction; tolerate 0–100 too.
    utilization: util === undefined ? undefined : util <= 1 ? util * 100 : util,
    // Unix seconds; tolerate ms.
    resetsAt: resets === undefined ? undefined : resets < 1e12 ? resets * 1000 : resets,
    detail,
  };
}

/**
 * Claude Code ACP adapter: `usage_update._meta["_claude/rateLimit"]`.
 * `unifiedWindows` carries every plan window (five_hour, seven_day, …) with
 * utilization; the top-level fields describe only the binding one.
 */
function fromClaude(update: any): QuotaEntry[] {
  const info = update?._meta?.["_claude/rateLimit"];
  if (!info || typeof info !== "object") return [];
  const overage = info.isUsingOverage ? "추가 사용량으로 사용 중" : undefined;
  const windows = info.unifiedWindows;
  if (windows && typeof windows === "object") {
    return Object.entries(windows)
      .filter(([, w]) => w && typeof w === "object" && (w as any).status)
      .map(([type, w]) => claudeEntry(type, w, type === info.rateLimitType ? overage : undefined));
  }
  return info.status ? [claudeEntry(info.rateLimitType ?? "plan", info, overage)] : [];
}

const GROUP_LABEL: Record<string, string> = {
  "Gemini Models": "Gemini",
  "Claude and GPT models": "Claude·GPT",
  codex: "Codex",
};

/** "5h" → "5시간 한도", "weekly" → "주간 한도", "3d" → "3일 한도". */
function windowLabel(window: unknown, fallback: unknown): string {
  if (window === "weekly") return "주간 한도";
  const m = /^(\d+)([mhd])$/.exec(String(window));
  if (m) return `${m[1]}${{ m: "분", h: "시간", d: "일" }[m[2] as "m" | "h" | "d"]} 한도`;
  return typeof fallback === "string" ? fallback : "한도";
}

/**
 * Plan limits Baton read itself (`account-usage`), as limit groups (models
 * sharing a meter) with the fraction left in each window. Antigravity's
 * `agy -p /usage` and Codex's `account/rateLimits/read` both arrive this way.
 */
export function quotasFromUsageReport(usage: unknown): QuotaEntry[] {
  const groups = (usage as any)?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g: any) =>
    (Array.isArray(g?.buckets) ? g.buckets : []).map((b: any): QuotaEntry => {
      const left = typeof b.remaining_fraction === "number" ? Math.min(1, Math.max(0, b.remaining_fraction)) : undefined;
      // Codex gives Unix seconds, Antigravity an ISO timestamp.
      const resets =
        typeof b.resets_at === "number"
          ? b.resets_at * 1000
          : typeof b.reset_time === "string"
            ? Date.parse(b.reset_time)
            : NaN;
      const group = GROUP_LABEL[g.name] ?? String(g.name ?? "모델");
      return {
        id: `antigravity:${b.id ?? `${g.name}-${b.window}`}`,
        label: `${group} ${windowLabel(b.window, b.name)}`,
        status: left === undefined ? "ok" : left <= 0 ? "limited" : left < 0.1 ? "warning" : "ok",
        utilization: left === undefined ? undefined : (1 - left) * 100,
        resetsAt: Number.isNaN(resets) ? undefined : resets,
        detail: typeof g.description === "string" ? g.description.replace(/^Models within this group: /, "") : undefined,
      };
    }),
  );
}

const EXTRACTORS: ((update: unknown) => QuotaEntry[])[] = [fromClaude];

export function quotasFromUpdate(update: unknown): QuotaEntry[] {
  return EXTRACTORS.flatMap((extract) => extract(update));
}
