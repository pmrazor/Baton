import { describe, expect, it } from "vitest";
import { quotasFromUpdate, quotasFromUsageReport } from "./usage";

describe("Antigravity usage reports", () => {
  // Shape of `agy -p /usage --output-format json` → command.data.
  const report = {
    groups: [
      {
        name: "Gemini Models",
        description: "Models within this group: Gemini 3.8 Flash",
        buckets: [
          { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.95, reset_time: "2026-12-01T07:04:30Z" },
          { id: "gemini-5h", window: "5h", remaining_fraction: 0.05, reset_time: "2026-11-24T12:04:30Z" },
        ],
      },
      { name: "Claude and GPT models", buckets: [{ id: "3p-5h", window: "5h", remaining_fraction: 0 }] },
    ],
  };

  it("turns each limit window into an entry", () => {
    const entries = quotasFromUsageReport(report);
    expect(entries.map((e) => [e.id, e.label, e.status])).toEqual([
      ["antigravity:gemini-weekly", "Gemini 주간 한도", "ok"],
      ["antigravity:gemini-5h", "Gemini 5시간 한도", "warning"],
      ["antigravity:3p-5h", "Claude·GPT 5시간 한도", "limited"],
    ]);
    expect(entries[0].utilization).toBeCloseTo(5);
    expect(entries[0].resetsAt).toBe(Date.UTC(2026, 11, 1, 7, 4, 30));
    expect(entries[0].detail).toBe("Gemini 3.8 Flash");
    expect(entries[2].resetsAt).toBeUndefined();
  });

  it("ignores anything else", () => {
    expect(quotasFromUsageReport(null)).toEqual([]);
    expect(quotasFromUsageReport({ groups: "x" })).toEqual([]);
  });
});

describe("Claude rate limits", () => {
  it("reads every plan window", () => {
    const update = {
      sessionUpdate: "usage_update",
      _meta: {
        "_claude/rateLimit": {
          rateLimitType: "five_hour",
          isUsingOverage: true,
          unifiedWindows: {
            five_hour: { status: "allowed_warning", utilization: 0.9, resetsAt: 1_800_000_000 },
            seven_day: { status: "allowed", utilization: 40 },
          },
        },
      },
    };
    expect(quotasFromUpdate(update)).toEqual([
      {
        id: "claude:five_hour",
        label: "5시간 한도",
        status: "warning",
        utilization: 90,
        resetsAt: 1_800_000_000_000,
        detail: "추가 사용량으로 사용 중",
      },
      { id: "claude:seven_day", label: "주간 한도", status: "ok", utilization: 40, resetsAt: undefined, detail: undefined },
    ]);
  });

  it("ignores updates without a report", () => {
    expect(quotasFromUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 })).toEqual([]);
  });
});
