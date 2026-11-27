// Extensions: packages Baton downloads on demand from a registry (a folder of
// static files, e.g. on GitHub). Phase 1 is data-only: an extension is a
// manifest plus data files, never code that runs in the app.
//
// Registry layout (all relative to the folder that holds index.json):
//   index.json            -> Registry
//   <id>/extension.json   -> ExtensionManifest
//   <id>/<other files>    -> listed in the index entry's `files` with sha256
//
// Contribution kinds are open-ended: `contributes` maps a kind ("languages"
// today; themes, snippets… later) to its entries. Baton keeps kinds it doesn't
// know and ignores them, so newer extensions still install on older apps.

import { invoke } from "@tauri-apps/api/core";

export interface ExtensionManifest {
  /** Unique id, `[a-z0-9-]+`, e.g. "lang-go". Also the install folder name. */
  id: string;
  name: string;
  /** Semver `x.y.z`. */
  version: string;
  description?: string;
  publisher?: string;
  /** Minimum Baton version, e.g. "0.2.6". */
  baton?: string;
  /** SPDX id of the original work's license, e.g. "MIT" (themes and grammars ported from elsewhere). */
  license?: string;
  /** Original author / project credited, e.g. "Catppuccin". */
  author?: string;
  /** Project page of the original work. */
  homepage?: string;
  contributes: ExtensionContributes;
}

export interface ExtensionContributes {
  languages?: LanguageContribution[];
  themes?: ThemeContribution[];
  [kind: string]: unknown;
}

/** App color tokens a theme may set: the CSS variables in src/styles.css without "--". */
export const THEME_COLOR_KEYS = [
  "bg", "sidebar", "surface", "surface-2", "surface-3", "hover", "border",
  "text", "text-2", "muted",
  "accent", "accent-soft", "on-accent", "brand", "brand-soft",
  "danger", "danger-soft", "ok", "warn", "add-bg", "del-bg", "code-bg",
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** Editor syntax colors: the `--cm-<key>` variables in src/components/code/code.css. */
export const THEME_SYNTAX_KEYS = [
  "keyword", "string", "comment", "number", "type", "func", "var", "prop", "op", "tag", "heading",
] as const;
export type ThemeSyntaxKey = (typeof THEME_SYNTAX_KEYS)[number];

/** Terminal (xterm) colors. */
export const THEME_TERMINAL_KEYS = [
  "background", "foreground", "cursor", "selection",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
export type ThemeTerminalKey = (typeof THEME_TERMINAL_KEYS)[number];

/**
 * A color theme. Values are CSS colors: `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb(...)` or `hsl(...)` (space or comma syntax, optional alpha). Missing
 * keys fall back to Baton's built-in light/dark value for `type`; missing
 * terminal colors are derived from `colors` as today.
 */
export interface ThemeContribution {
  /** `[a-z0-9-]+`, unique within the extension, e.g. "mocha". */
  id: string;
  /** Display name, e.g. "Catppuccin Mocha". */
  name: string;
  type: "light" | "dark";
  colors: Partial<Record<ThemeColorKey, string>>;
  syntax?: Partial<Record<ThemeSyntaxKey, string>>;
  terminal?: Partial<Record<ThemeTerminalKey, string>>;
}

export interface LanguageContribution {
  /** Language id, `[a-z0-9-]+`, e.g. "go". */
  id: string;
  /** Display name, e.g. "Go". */
  name: string;
  /** File extensions with the dot, lower-case, e.g. [".go"]. */
  extensions?: string[];
  /** Exact file basenames, e.g. ["go.mod", "Dockerfile"]. */
  filenames?: string[];
  grammar: LanguageGrammar;
  comments?: { line?: string; block?: [string, string] };
  /** e.g. "  " or "\t". */
  indentUnit?: string;
}

/**
 * Where the highlighting comes from:
 * - `legacyMode`: a mode bundled with Baton from `@codemirror/legacy-modes`
 *   (`mode` = module name under `mode/`, `export` = exported name when it
 *   differs from `mode`, e.g. { mode: "clike", export: "kotlin" }).
 * - `simpleMode`: a JSON file in the extension in CodeMirror simple-mode form
 *   (`SimpleModeFile`), regexes as strings.
 */
export type LanguageGrammar = { legacyMode: { mode: string; export?: string } } | { simpleMode: string };

/** JSON form of CodeMirror's simple mode: `states.start` is required. */
export interface SimpleModeFile {
  states: Record<string, SimpleModeRule[]>;
  languageData?: { commentTokens?: { line?: string; block?: { open: string; close: string } } };
}

export interface SimpleModeRule {
  /** Regex source, matched at the current position. */
  regex: string;
  /** Regex flags, only "i" is allowed. */
  flags?: string;
  /** Highlight tag name(s) (e.g. "keyword", "string", "comment"), or null. */
  token?: string | string[] | null;
  next?: string;
  push?: string;
  pop?: boolean;
  sol?: boolean;
  indent?: boolean;
  dedent?: boolean;
}

export interface RegistryFile {
  /** Path inside the extension folder, `/`-separated, no `..`. */
  path: string;
  sha256: string;
  size: number;
}

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  baton?: string;
  license?: string;
  author?: string;
  homepage?: string;
  /** Contribution kinds it provides, e.g. ["languages"] or ["themes"]. */
  kinds: string[];
  /** Short tags for search, e.g. language ids and file extensions. */
  keywords?: string[];
  /** Every file to download, always including "extension.json". */
  files: RegistryFile[];
}

export interface Registry {
  version: 1;
  extensions: RegistryEntry[];
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  enabled: boolean;
  /** Unix ms. */
  installedAt: number;
  /** Registry URL (or local folder) it came from. */
  source: string;
}

/** Registry URL: an https URL or an absolute local path to an index.json. */
export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/pmrazor/Baton/main/extensions/index.json";

export const extApi = {
  fetchRegistry: (url: string) => invoke<Registry>("ext_fetch_registry", { url }),
  /** Downloads every file of the entry, checks sizes and sha256, then installs (replacing an older version). */
  install: (url: string, id: string) => invoke<InstalledExtension>("ext_install", { url, id }),
  uninstall: (id: string) => invoke<void>("ext_uninstall", { id }),
  setEnabled: (id: string, enabled: boolean) => invoke<void>("ext_set_enabled", { id, enabled }),
  listInstalled: () => invoke<InstalledExtension[]>("ext_list_installed"),
  /** Text of a file inside an installed extension (e.g. a simple-mode grammar). */
  readFile: (id: string, path: string) => invoke<string>("ext_read_file", { id, path }),
};
