import { describe, expect, it } from "vitest";
import { detectPlatform } from "./platform";

describe("detectPlatform", () => {
  it("detects macOS from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
  });

  it("detects Windows from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  });

  it("detects Linux from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("falls back to navigator.platform-style values", () => {
    expect(detectPlatform("MacIntel")).toBe("mac");
    expect(detectPlatform("Win32")).toBe("windows");
    expect(detectPlatform("Linux x86_64")).toBe("linux");
  });

  it("defaults to Linux when the string is empty or unknown", () => {
    expect(detectPlatform("")).toBe("linux");
    expect(detectPlatform("SomeUnknownPlatform")).toBe("linux");
  });
});
