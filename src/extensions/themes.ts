import {
  THEME_COLOR_KEYS,
  THEME_SYNTAX_KEYS,
  THEME_TERMINAL_KEYS,
  type InstalledExtension,
  type ThemeContribution,
} from "./api";
import { onExtensionsChanged, registerContributionKind } from "./registry";

export interface ThemeEntry {
  /** `<extId>:<themeId>` */
  key: string;
  extId: string;
  theme: ThemeContribution;
}

export interface ThemeSettings {
  light: string | null;
  dark: string | null;
}

const SETTINGS_KEY = "baton.theme";
const CACHE_KEY = "baton.themeCache";
const STYLE_ID = "baton-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = new RegExp(
  String.raw`^(?:rgba?|hsla?)\(\s*${NUM}(?:deg)?%?(?:\s*,\s*|\s+)${NUM}%?(?:\s*,\s*|\s+)${NUM}%?(?:\s*(?:,|/)\s*${NUM}%?)?\s*\)$`,
  "i",
);

/** Only plain color literals: no url(), var(), semicolons or other CSS. */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length > 0 && v.length <= 64 && (HEX.test(v) || FUNC.test(v));
}

const COLOR_SET = new Set<string>(THEME_COLOR_KEYS);
const SYNTAX_SET = new Set<string>(THEME_SYNTAX_KEYS);
const TERMINAL_SET = new Set<string>(THEME_TERMINAL_KEYS);

/** CSS declarations (`--key: value;`) for a theme; unknown keys and unsafe values are skipped. */
export function themeCssText(theme: ThemeContribution): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(theme.colors ?? {})) {
    if (COLOR_SET.has(k) && isSafeColor(v)) out.push(`--${k}: ${v.trim()};`);
  }
  for (const [k, v] of Object.entries(theme.syntax ?? {})) {
    if (SYNTAX_SET.has(k) && isSafeColor(v)) out.push(`--cm-${k}: ${v.trim()};`);
  }
  return out.join(" ");
}

/** Terminal colors that are safe (known keys, valid values). */
export function safeTerminalColors(theme: ThemeContribution | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme?.terminal ?? {})) {
    if (TERMINAL_SET.has(k) && isSafeColor(v)) out[k] = v.trim();
  }
  return out;
}

export function isValidTheme(t: unknown): t is ThemeContribution {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    /^[a-z0-9-]+$/.test(o.id) &&
    typeof o.name === "string" &&
    (o.type === "light" || o.type === "dark") &&
    !!o.colors &&
    typeof o.colors === "object"
  );
}

export function parseSettings(raw: string | null): ThemeSettings {
  try {
    const o = raw ? JSON.parse(raw) : null;
    const pick = (x: unknown) => (typeof x === "string" && x ? x : null);
    return { light: pick(o?.light), dark: pick(o?.dark) };
  } catch {
    return { light: null, dark: null };
  }
}

// ---------- state ----------

let entries: ThemeEntry[] = [];
const listeners = new Set<() => void>();
let settings: ThemeSettings = { light: null, dark: null };
try {
  settings = parseSettings(localStorage.getItem(SETTINGS_KEY));
} catch {
  /* storage unavailable */
}

function prefersDark(): boolean {
  try {
    return matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function getThemes(): readonly ThemeEntry[] {
  return entries;
}

export function getThemeSettings(): ThemeSettings {
  return settings;
}

export function findTheme(key: string | null): ThemeEntry | null {
  return key ? (entries.find((e) => e.key === key) ?? null) : null;
}

/** The theme in effect now, or null for Baton's default. */
export function getActiveTheme(): ThemeEntry | null {
  return findTheme(prefersDark() ? settings.dark : settings.light);
}

/** "light" | "dark" actually shown (active theme type, else the OS preference). */
export function getEffectiveScheme(): "light" | "dark" {
  return getActiveTheme()?.theme.type ?? (prefersDark() ? "dark" : "light");
}

export function onThemeChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function writeStyle(css: string, type: "light" | "dark" | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  let el = document.getElementById(STYLE_ID);
  if (!css || !type) {
    el?.remove();
    delete root.dataset.theme;
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
  }
  // `:root:root` outranks the stylesheets' `:root` rules (incl. lazy-loaded code.css) whatever the load order.
  el.textContent = `:root:root { ${css} color-scheme: ${type}; }`;
  document.head.appendChild(el); // (re)append: last in <head> wins
  root.dataset.theme = type;
}

function apply() {
  const active = getActiveTheme();
  const css = active ? themeCssText(active.theme) : "";
  writeStyle(css, active ? active.theme.type : null);
  try {
    if (css && active) localStorage.setItem(CACHE_KEY, JSON.stringify({ css, type: active.theme.type }));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.warn("[themes] listener failed:", err);
    }
  }
}

/** Apply the cached theme synchronously (before first render, avoids a flash). */
export function applyCachedTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o?.css === "string" && (o.type === "light" || o.type === "dark")) {
      // Re-validate: the cache is only ever written by us, but keep the same bar.
      const safe = o.css
        .split(";")
        .map((d: string) => d.trim())
        .filter((d: string) => {
          const m = /^--[a-z0-9-]+:\s*(.+)$/.exec(d);
          return !!m && isSafeColor(m[1]);
        })
        .map((d: string) => `${d};`)
        .join(" ");
      writeStyle(safe, o.type);
    }
  } catch {
    /* ignore */
  }
}

export function setThemeSetting(scheme: "light" | "dark", key: string | null): void {
  settings = { ...settings, [scheme]: key };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  apply();
}

try {
  matchMedia(DARK_QUERY).addEventListener("change", apply);
} catch {
  /* no matchMedia (tests) */
}

function handleThemeContributions(extension: InstalledExtension, raw: unknown): () => void {
  if (!Array.isArray(raw)) {
    console.warn(`[extensions] invalid "themes" contribution in "${extension.manifest.id}": expected an array`);
    return () => {};
  }
  const added: ThemeEntry[] = [];
  for (const t of raw) {
    if (!isValidTheme(t)) {
      console.warn(`[extensions] skipping malformed theme in "${extension.manifest.id}"`);
      continue;
    }
    added.push({ key: `${extension.manifest.id}:${t.id}`, extId: extension.manifest.id, theme: t });
  }
  entries = [...entries, ...added];
  return () => {
    entries = entries.filter((e) => !added.includes(e));
  };
}

registerContributionKind("themes", handleThemeContributions);
// Extensions (re)load → recompute (a removed theme falls back to default; the cache refreshes).
onExtensionsChanged(apply);
