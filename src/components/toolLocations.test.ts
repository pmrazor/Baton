import { describe, expect, it } from "vitest";
import { isEditCall, locationLabel, resolveLocation } from "./toolLocations";

describe("toolLocations", () => {
  it("formats the label", () => {
    expect(locationLabel("/a/b.ts", 12)).toBe("/a/b.ts:12");
    expect(locationLabel("/a/b.ts")).toBe("/a/b.ts");
    expect(locationLabel("/a/b.ts", 0)).toBe("/a/b.ts");
  });
  it("resolves inside the root", () => {
    expect(resolveLocation("/proj", "/proj/src/a.ts")).toEqual({ root: "/proj", rel: "src/a.ts" });
  });
  it("returns null outside the root or without one", () => {
    expect(resolveLocation("/proj", "/other/a.ts")).toBeNull();
    expect(resolveLocation("/proj", "/project2/a.ts")).toBeNull();
    expect(resolveLocation("/proj", "/proj")).toBeNull();
    expect(resolveLocation(null, "/proj/a.ts")).toBeNull();
  });
  it("detects edit calls", () => {
    expect(isEditCall("edit", [])).toBe(true);
    expect(isEditCall("other", [{ type: "diff" }])).toBe(true);
    expect(isEditCall("read", [{ type: "content" }])).toBe(false);
  });
});
