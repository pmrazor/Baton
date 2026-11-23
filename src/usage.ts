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

const EXTRACTORS: ((update: unknown) => QuotaEntry[])[] = [fromClaude];

export function quotasFromUpdate(update: unknown): QuotaEntry[] {
  return EXTRACTORS.flatMap((extract) => extract(update));
}
