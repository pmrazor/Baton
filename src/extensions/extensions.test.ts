import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentUnit, syntaxTree } from "@codemirror/language";
import {
  DEFAULT_REGISTRY_URL,
  extApi,
  type InstalledExtension,
  type Registry,
} from "./api";
import {
  getInstalledExtensions,
  loadInstalledExtensions,
  onExtensionsChanged,
  registerContributionKind,
  reloadExtensions,
  resetLoadedExtensionsForTests,
} from "./registry";
import {
  convertSimpleModeFile,
  findExtensionLanguageForPath,
  loadExtensionLanguage,
  MAX_SIMPLE_MODE_RULES,
  parseSimpleModeJson,
} from "./languages";
import {
  compareSemver,
  fetchRegistryCached,
  fetchRegistryOnceForHint,
  filterRegistryEntries,
  findSuggestedExtensionForPath,
  isUpdateAvailable,
  loadRegistryUrl,
  REGISTRY_URL_STORAGE_KEY,
  resetRegistryCacheForTests,
  saveRegistryUrl,
} from "./catalog";
import { fenceLanguageForPath, languageForPath } from "../components/code/codeHelpers";
import { deleteSession, ensureTabSession, getSession } from "../components/code/cmEngine";

function makeExt(
  id: string,
  contributes: InstalledExtension["manifest"]["contributes"],
  opts: { enabled?: boolean; version?: string; name?: string } = {},
): InstalledExtension {
  return {
    manifest: {
      id,
      name: opts.name ?? id,
      version: opts.version ?? "1.0.0",
      contributes,
    },
    enabled: opts.enabled ?? true,
    installedAt: 1700000000000,
    source: DEFAULT_REGISTRY_URL,
  };
}

describe("extension contribution registry", () => {
  beforeEach(() => {
    resetLoadedExtensionsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLoadedExtensionsForTests();
  });

  it("loads enabled extensions, ignores disabled ones and unknown kinds, and disposes on reload", async () => {
    const disposed: string[] = [];
    const applied: string[] = [];
    const unregister = registerContributionKind("customTestKind", (ext, entries) => {
      applied.push(`${ext.manifest.id}:${JSON.stringify(entries)}`);
      return () => disposed.push(ext.manifest.id);
    });

    const listSpy = vi.spyOn(extApi, "listInstalled");
    listSpy.mockResolvedValueOnce([
      makeExt("ext-a", { customTestKind: ["x"], futureUnknownKind: { foo: 1 } }),
      makeExt("ext-b", { customTestKind: ["y"] }, { enabled: false }),
    ]);

    const onChange = vi.fn();
    const off = onExtensionsChanged(onChange);

    await loadInstalledExtensions();
    expect(applied).toEqual(['ext-a:["x"]']);
    expect(disposed).toEqual([]);
    expect(getInstalledExtensions()).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    listSpy.mockResolvedValueOnce([
      makeExt("ext-b", { customTestKind: ["y2"] }, { enabled: true }),
    ]);
    await reloadExtensions();

    expect(disposed).toEqual(["ext-a"]);
    expect(applied).toEqual(['ext-a:["x"]', 'ext-b:["y2"]']);
    expect(onChange).toHaveBeenCalledTimes(2);

    off();
    unregister();
  });
});

describe("extension language lookup and built-in precedence", () => {
  beforeEach(() => {
    resetLoadedExtensionsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLoadedExtensionsForTests();
  });

  it("matches basenames first, then longest lower-case extension, while built-ins always win", async () => {
    vi.spyOn(extApi, "listInstalled").mockResolvedValue([
      makeExt("lang-go", {
        languages: [
          {
            id: "go",
            name: "Go",
            extensions: [".go"],
            filenames: ["go.mod", "Dockerfile"],
            grammar: { legacyMode: { mode: "go" } },
          },
        ],
      }),
      makeExt("lang-php", {
        languages: [
          {
            id: "php",
            name: "PHP",
            extensions: [".php"],
            grammar: { legacyMode: { mode: "php" } },
          },
          {
            id: "blade",
            name: "Blade",
            extensions: [".blade.php"],
            grammar: { legacyMode: { mode: "php" } },
          },
        ],
      }),
      makeExt("lang-hijack", {
        languages: [
          {
            id: "fake-ts",
            name: "Fake TS",
            extensions: [".ts"],
            filenames: ["Cargo.lock"],
            grammar: { legacyMode: { mode: "go" } },
          },
        ],
      }),
    ]);

    await loadInstalledExtensions();

    // Basename matches (exact and case-insensitive)
    expect(languageForPath("cmd/go.mod")).toBe("ext:lang-go:go");
    expect(languageForPath("docker/Dockerfile")).toBe("ext:lang-go:go");
    expect(languageForPath("docker/dockerfile")).toBe("ext:lang-go:go");

    // Extension matching (case-insensitive, longest match wins)
    expect(languageForPath("main.go")).toBe("ext:lang-go:go");
    expect(languageForPath("MAIN.GO")).toBe("ext:lang-go:go");
    expect(languageForPath("index.php")).toBe("ext:lang-php:php");
    expect(languageForPath("views/home.blade.php")).toBe("ext:lang-php:blade");

    // Built-in languages always take priority over extensions
    expect(languageForPath("src/app.ts")).toBe("typescript");
    expect(languageForPath("Cargo.lock")).toBe("toml");

    // Markdown fence language uses the short language id, not `ext:<extId>:<langId>`
    expect(fenceLanguageForPath("main.go")).toBe("go");
    expect(fenceLanguageForPath("views/home.blade.php")).toBe("blade");

    // Reloading with empty list clears extension languages
    vi.spyOn(extApi, "listInstalled").mockResolvedValue([]);
    await reloadExtensions();
    expect(findExtensionLanguageForPath("main.go")).toBeNull();
    expect(languageForPath("main.go")).toBeNull();
  });
});

describe("convertSimpleModeFile pure converter", () => {
  it("converts valid simpleMode JSON with i flag, states, and languageData", () => {
    const compiled = parseSimpleModeJson(
      JSON.stringify({
        states: {
          start: [
            { regex: "\\b(?:fn|let|return)\\b", token: "keyword" },
            { regex: "\\btrue|false\\b", flags: "i", token: "atom" },
            { regex: "\\/\\*", token: "comment", next: "comment" },
            { regex: "\\{", indent: true },
            { regex: "\\}", dedent: true },
          ],
          comment: [
            { regex: ".*?\\*\\/", token: "comment", next: "start" },
            { regex: ".*", token: "comment" },
          ],
        },
        languageData: {
          commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
        },
      }),
    );

    expect(compiled.states.start).toHaveLength(5);
    expect(compiled.states.start[0].regex).toBeInstanceOf(RegExp);
    expect((compiled.states.start[0].regex as RegExp).flags).toBe("");
    expect((compiled.states.start[1].regex as RegExp).flags).toBe("i");
    expect(compiled.states.start[2].next).toBe("comment");
    expect(compiled.languageData?.commentTokens?.line).toBe("//");
    expect(compiled.languageData?.commentTokens?.block).toEqual({ open: "/*", close: "*/" });
  });

  it("rejects missing states.start", () => {
    expect(() => convertSimpleModeFile({ states: { other: [] } })).toThrow(/states\.start/);
    expect(() => convertSimpleModeFile({})).toThrow(/states/);
    expect(() => convertSimpleModeFile(null)).toThrow(/JSON object/);
  });

  it("rejects disallowed regex flags (only 'i' is allowed)", () => {
    for (const badFlag of ["g", "m", "u", "s", "gi", "im"]) {
      expect(() =>
        convertSimpleModeFile({
          states: { start: [{ regex: "foo", flags: badFlag, token: "keyword" }] },
        }),
      ).toThrow(/unsupported regex flags/);
    }
  });

  it("catches invalid regex syntax", () => {
    expect(() =>
      convertSimpleModeFile({
        states: { start: [{ regex: "[unclosed", token: "keyword" }] },
      }),
    ).toThrow(/Invalid regex/);
  });

  it("enforces the rule cap", () => {
    const tooMany = Array.from({ length: MAX_SIMPLE_MODE_RULES + 1 }, () => ({
      regex: "a",
      token: "keyword",
    }));
    expect(() => convertSimpleModeFile({ states: { start: tooMany } })).toThrow(/maximum/);
  });

  it("rejects unknown transition states and reserved state names", () => {
    expect(() =>
      convertSimpleModeFile({
        states: { start: [{ regex: "a", next: "missing" }] },
      }),
    ).toThrow(/Unknown 'next' state/);

    expect(() =>
      convertSimpleModeFile({
        states: { start: [], languageData: [] },
      }),
    ).toThrow(/Invalid simpleMode state name/);
  });
});

describe("extension grammar loading (legacyMode & simpleMode)", () => {
  beforeEach(() => {
    resetLoadedExtensionsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLoadedExtensionsForTests();
  });

  it("loads bundled legacyMode (including custom export), comments, and indentUnit", async () => {
    vi.spyOn(extApi, "listInstalled").mockResolvedValue([
      makeExt("lang-bundle", {
        languages: [
          {
            id: "go",
            name: "Go",
            extensions: [".go"],
            grammar: { legacyMode: { mode: "go" } },
            comments: { line: "//", block: ["/*", "*/"] },
            indentUnit: "\t",
          },
          {
            id: "kotlin",
            name: "Kotlin",
            extensions: [".kt"],
            grammar: { legacyMode: { mode: "clike", export: "kotlin" } },
          },
          {
            id: "bad-mode",
            name: "Broken",
            extensions: [".broken"],
            grammar: { legacyMode: { mode: "nonexistent-mode-xyz" } },
          },
        ],
      }),
    ]);

    await loadInstalledExtensions();

    const goExt = await loadExtensionLanguage("ext:lang-bundle:go");
    const goState = EditorState.create({
      doc: "package main\nfunc main() {}\n",
      extensions: [goExt],
    });
    expect(syntaxTree(goState).length).toBeGreaterThan(0);
    expect(goState.languageDataAt("commentTokens", 0)).toEqual([
      { line: "//", block: { open: "/*", close: "*/" } },
    ]);
    expect(getIndentUnit(goState)).toBe(4); // tabSize default is 4

    const ktExt = await loadExtensionLanguage("ext:lang-bundle:kotlin");
    const ktState = EditorState.create({
      doc: "fun main() = println(1)\n",
      extensions: [ktExt],
    });
    expect(syntaxTree(ktState).length).toBeGreaterThan(0);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenExt = await loadExtensionLanguage("ext:lang-bundle:bad-mode");
    expect(brokenExt).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("loads simpleMode grammar from extApi.readFile and applies comments + indentUnit", async () => {
    vi.spyOn(extApi, "listInstalled").mockResolvedValue([
      makeExt("lang-toy", {
        languages: [
          {
            id: "toy",
            name: "Toy",
            extensions: [".toy"],
            grammar: { simpleMode: "grammars/toy.json" },
            comments: { line: "#" },
            indentUnit: "    ",
          },
        ],
      }),
    ]);
    const readSpy = vi.spyOn(extApi, "readFile").mockResolvedValue(
      JSON.stringify({
        states: {
          start: [
            { regex: "#.*", token: "comment" },
            { regex: "\\b(?:def|end)\\b", token: "keyword" },
            { regex: "\\d+", token: "number" },
          ],
        },
      }),
    );

    await loadInstalledExtensions();
    const ext = await loadExtensionLanguage("ext:lang-toy:toy");
    expect(readSpy).toHaveBeenCalledWith("lang-toy", "grammars/toy.json");

    const state = EditorState.create({
      doc: "# hi\ndef foo 42 end\n",
      extensions: [ext],
    });
    expect(syntaxTree(state).length).toBeGreaterThan(0);
    expect(state.languageDataAt("commentTokens", 0)).toEqual([{ line: "#" }]);
    expect(getIndentUnit(state)).toBe(4);
  });

  it("re-detects language for open cmEngine tab sessions when extensions change", async () => {
    const key = "/repo\0main.go";
    deleteSession(key);

    const listSpy = vi.spyOn(extApi, "listInstalled").mockResolvedValue([]);
    await loadInstalledExtensions();

    const session = ensureTabSession(key, "main.go", "package main\nfunc main() {}\n", null);
    expect(session.langId).toBeNull();
    expect(session.state.languageDataAt("commentTokens", 0)).toEqual([]);

    // Install Go extension and reload -> open tab automatically gets Go language.
    listSpy.mockResolvedValue([
      makeExt("lang-go", {
        languages: [
          {
            id: "go",
            name: "Go",
            extensions: [".go"],
            grammar: { legacyMode: { mode: "go" } },
            comments: { line: "//" },
          },
        ],
      }),
    ]);
    await reloadExtensions();

    // Wait a tick for async attachLanguage to complete.
    await vi.waitFor(() => {
      expect(getSession(key)?.langId).toBe("ext:lang-go:go");
    });
    expect(getSession(key)?.state.languageDataAt("commentTokens", 0)).toEqual([
      { line: "//", block: { open: "/*", close: "*/" } },
    ]);

    // Uninstall -> open tab reverts to plain text.
    listSpy.mockResolvedValue([]);
    await reloadExtensions();
    expect(getSession(key)?.langId).toBeNull();
    expect(getSession(key)?.state.languageDataAt("commentTokens", 0)).toEqual([]);

    deleteSession(key);
  });
});

describe("extension catalog helpers (semver, caching, suggestions)", () => {
  beforeEach(() => {
    resetRegistryCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRegistryCacheForTests();
  });

  it("compares semver x.y.z versions accurately", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.10.0", "1.2.0")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("0.2.5", "0.2.6")).toBe(-1);
    expect(compareSemver("invalid", "1.0.0")).toBe(0);

    expect(isUpdateAvailable("1.0.0", "1.0.1")).toBe(true);
    expect(isUpdateAvailable("1.2.0", "1.2.0")).toBe(false);
    expect(isUpdateAvailable("2.0.0", "1.9.0")).toBe(false);
  });

  it("caches registry fetch for the session and only re-fetches when forced", async () => {
    const sample: Registry = {
      version: 1,
      extensions: [
        {
          id: "lang-go",
          name: "Go",
          version: "1.0.0",
          description: "Go syntax",
          kinds: ["languages"],
          keywords: ["go", ".go"],
          files: [],
        },
      ],
    };
    const fetchSpy = vi.spyOn(extApi, "fetchRegistry").mockResolvedValue(sample);

    const first = await fetchRegistryCached(DEFAULT_REGISTRY_URL);
    const second = await fetchRegistryCached(DEFAULT_REGISTRY_URL);
    expect(first).toBe(sample);
    expect(second).toBe(sample);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await fetchRegistryCached(DEFAULT_REGISTRY_URL, { force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry failed hint fetches in the same session", async () => {
    const fetchSpy = vi
      .spyOn(extApi, "fetchRegistry")
      .mockRejectedValue(new Error("offline"));

    expect(await fetchRegistryOnceForHint(DEFAULT_REGISTRY_URL)).toBeNull();
    expect(await fetchRegistryOnceForHint(DEFAULT_REGISTRY_URL)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("suggests an uninstalled registry extension matching file extension keywords", () => {
    const reg: Registry = {
      version: 1,
      extensions: [
        {
          id: "lang-go",
          name: "Go",
          version: "1.0.0",
          kinds: ["languages"],
          keywords: ["go", ".go", "go.mod"],
          files: [],
        },
        {
          id: "lang-kotlin",
          name: "Kotlin",
          version: "1.0.0",
          kinds: ["languages"],
          keywords: [".kt", ".kts"],
          files: [],
        },
      ],
    };

    expect(findSuggestedExtensionForPath("cmd/main.go", reg, [])?.id).toBe("lang-go");
    expect(findSuggestedExtensionForPath("go.mod", reg, [])?.id).toBe("lang-go");
    expect(findSuggestedExtensionForPath("App.KT", reg, [])?.id).toBe("lang-kotlin");
    expect(findSuggestedExtensionForPath("notes.txt", reg, [])).toBeNull();

    // Already installed -> no suggestion
    expect(
      findSuggestedExtensionForPath("cmd/main.go", reg, [makeExt("lang-go", {})]),
    ).toBeNull();
  });

  it("filters registry entries by name, description, publisher, and keywords", () => {
    const entries: Registry["extensions"] = [
      {
        id: "lang-go",
        name: "Go",
        version: "1.0.0",
        description: "Golang highlighting",
        publisher: "baton",
        kinds: ["languages"],
        keywords: [".go"],
        files: [],
      },
      {
        id: "lang-zig",
        name: "Zig",
        version: "0.1.0",
        description: "Zig syntax",
        kinds: ["languages"],
        keywords: [".zig"],
        files: [],
      },
    ];

    expect(filterRegistryEntries(entries, "")).toHaveLength(2);
    expect(filterRegistryEntries(entries, "golang").map((e) => e.id)).toEqual(["lang-go"]);
    expect(filterRegistryEntries(entries, ".zig").map((e) => e.id)).toEqual(["lang-zig"]);
    expect(filterRegistryEntries(entries, "nonexistent")).toEqual([]);
  });

  it("loads and saves registry URL safely even if localStorage is absent", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });

    expect(loadRegistryUrl()).toBe(DEFAULT_REGISTRY_URL);
    expect(saveRegistryUrl("https://example.com/index.json")).toBe(
      "https://example.com/index.json",
    );
    expect(store.get(REGISTRY_URL_STORAGE_KEY)).toBe("https://example.com/index.json");
    expect(loadRegistryUrl()).toBe("https://example.com/index.json");

    // Blank restores default
    expect(saveRegistryUrl("   ")).toBe(DEFAULT_REGISTRY_URL);
    expect(loadRegistryUrl()).toBe(DEFAULT_REGISTRY_URL);

    vi.unstubAllGlobals();
  });
});
