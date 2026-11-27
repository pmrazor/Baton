import { describe, expect, it } from "vitest";
import type { ThemeContribution } from "./api";
import { isSafeColor, isValidTheme, parseSettings, safeTerminalColors, themeCssText } from "./themes";

describe("isSafeColor", () => {
  it("accepts plain colors", () => {
    for (const v of ["#fff", "#1d1d1f", "#1d1d1f80", "rgb(1 2 3)", "rgb(1, 2, 3)", "rgba(0,0,0,0.5)", "rgb(0 0 0 / 5%)", "hsl(210, 50%, 40%)", "hsla(210 50% 40% / .5)"]) {
      expect(isSafeColor(v), v).toBe(true);
    }
  });
  it("rejects anything else", () => {
    for (const v of ["url(x)", "var(--bg)", "#fff; color: red", "red", "#ffff", "rgb(0 0 0); x", "rgb(url(a))", "", 5, null, "#fff}"]) {
      expect(isSafeColor(v), String(v)).toBe(false);
    }
  });
});

describe("themeCssText", () => {
  const theme = {
    id: "t",
    name: "T",
    type: "dark",
    colors: { bg: "#000", text: "url(x)", bogus: "#fff" },
    syntax: { keyword: "#f0f", nope: "#fff" },
  } as unknown as ThemeContribution;
  it("emits known safe keys only", () => {
    expect(themeCssText(theme)).toBe("--bg: #000; --cm-keyword: #f0f;");
  });
});

describe("misc", () => {
  it("validates themes", () => {
    expect(isValidTheme({ id: "a", name: "A", type: "dark", colors: {} })).toBe(true);
    expect(isValidTheme({ id: "A!", name: "A", type: "dark", colors: {} })).toBe(false);
    expect(isValidTheme({ id: "a", name: "A", type: "x", colors: {} })).toBe(false);
  });
  it("parses settings defensively", () => {
    expect(parseSettings(null)).toEqual({ light: null, dark: null });
    expect(parseSettings("{bad")).toEqual({ light: null, dark: null });
    expect(parseSettings('{"light":"a:b","dark":3}')).toEqual({ light: "a:b", dark: null });
  });
  it("filters terminal colors", () => {
    const t = { id: "a", name: "A", type: "dark", colors: {}, terminal: { red: "#f00", blue: "var(--x)", zz: "#fff" } } as unknown as ThemeContribution;
    expect(safeTerminalColors(t)).toEqual({ red: "#f00" });
  });
});
