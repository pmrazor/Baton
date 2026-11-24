import { describe, expect, it } from "vitest";
import { formatVersion } from "./update";

describe("formatVersion", () => {
  it("shows releases as they are", () => {
    expect(formatVersion("0.1.6")).toBe("0.1.6");
  });

  it("spells out pre-releases", () => {
    expect(formatVersion("0.1.0-alpha.2")).toBe("0.1.0 Alpha 2");
    expect(formatVersion("1.0.0-beta")).toBe("1.0.0 Beta");
    expect(formatVersion("1.0.0-rc1")).toBe("1.0.0 Rc 1");
  });
});
