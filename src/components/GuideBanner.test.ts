import { describe, expect, it } from "vitest";
import { shouldShowGuideBanner } from "./GuideBanner";
import type { GuideStatus } from "../api";

const missing: GuideStatus = { exists: false, file: null, mode: "ask", stale: [] };

describe("shouldShowGuideBanner", () => {
  it("offers a guide to a lead when the folder has none and the mode is ask", () => {
    expect(shouldShowGuideBanner(missing, true)).toBe(true);
  });

  it("stays hidden outside agent mode", () => {
    expect(shouldShowGuideBanner(missing, false)).toBe(false);
  });

  it("stays hidden when the guide already exists", () => {
    expect(shouldShowGuideBanner({ ...missing, exists: true, file: "AGENTS.md" }, true)).toBe(false);
  });

  it("stays hidden after the user chose auto or off", () => {
    expect(shouldShowGuideBanner({ ...missing, mode: "auto" }, true)).toBe(false);
    expect(shouldShowGuideBanner({ ...missing, mode: "off" }, true)).toBe(false);
  });

  it("stays hidden until the status is known", () => {
    expect(shouldShowGuideBanner(null, true)).toBe(false);
    expect(shouldShowGuideBanner(undefined, true)).toBe(false);
  });
});
