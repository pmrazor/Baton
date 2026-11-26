import type { Extension } from "@codemirror/state";
import type { StreamParser } from "@codemirror/language";
import type { Rule as SimpleModeCmRule } from "@codemirror/legacy-modes/mode/simple-mode";
import {
  extApi,
  type InstalledExtension,
  type LanguageContribution,
  type SimpleModeFile,
} from "./api";
import { registerContributionKind } from "./registry";

export type ExtensionLanguageId = `ext:${string}:${string}`;

export const MAX_SIMPLE_MODE_RULES = 2000;

const RESERVED_STATE_KEYS = new Set(["__proto__", "constructor", "prototype", "languageData"]);
const SAFE_MODE_NAME = /^[a-z0-9-]+$/i;

// Vite turns this into lazy dynamic imports (one chunk per legacy mode, never in the main bundle).
const legacyModeLoaders = import.meta.glob<Record<string, unknown>>(
  "/node_modules/@codemirror/legacy-modes/mode/*.js",
);

export interface RegisteredExtensionLanguage {
  id: ExtensionLanguageId;
  extensionId: string;
  contribution: LanguageContribution;
}

const registeredById = new Map<ExtensionLanguageId, RegisteredExtensionLanguage>();
const byExactBasename = new Map<string, ExtensionLanguageId>();
const byLowerBasename = new Map<string, ExtensionLanguageId>();
const byExtension = new Map<string, ExtensionLanguageId>();
let sortedExtensionsDesc: string[] = [];

export function makeExtensionLanguageId(extId: string, langId: string): ExtensionLanguageId {
  return `ext:${extId}:${langId}`;
}

export function isExtensionLanguageId(id: string | null | undefined): id is ExtensionLanguageId {
  return typeof id === "string" && id.startsWith("ext:");
}

export function languageIdFromExtensionLang(id: ExtensionLanguageId): string {
  const lastColon = id.lastIndexOf(":");
  return lastColon >= 0 ? id.slice(lastColon + 1) : id;
}

function baseNameOf(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function normalizeExt(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === ".") return null;
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function rebuildLookupIndexes(): void {
  byExactBasename.clear();
  byLowerBasename.clear();
  byExtension.clear();

  for (const entry of registeredById.values()) {
    const { filenames, extensions } = entry.contribution;
    if (Array.isArray(filenames)) {
      for (const name of filenames) {
        if (typeof name !== "string") continue;
        const clean = name.trim();
        if (!clean) continue;
        if (!byExactBasename.has(clean)) byExactBasename.set(clean, entry.id);
        const lower = clean.toLowerCase();
        if (!byLowerBasename.has(lower)) byLowerBasename.set(lower, entry.id);
      }
    }
    if (Array.isArray(extensions)) {
      for (const rawExt of extensions) {
        if (typeof rawExt !== "string") continue;
        const ext = normalizeExt(rawExt);
        if (!ext) continue;
        if (!byExtension.has(ext)) byExtension.set(ext, entry.id);
      }
    }
  }

  sortedExtensionsDesc = [...byExtension.keys()].sort((a, b) => b.length - a.length);
}

function isValidLanguageContribution(value: unknown): value is LanguageContribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id.trim()) return false;
  if (typeof v.name !== "string" || !v.name.trim()) return false;
  if (!v.grammar || typeof v.grammar !== "object" || Array.isArray(v.grammar)) return false;
  return true;
}

function handleLanguageContributions(
  extension: InstalledExtension,
  entries: unknown,
): () => void {
  if (!Array.isArray(entries)) {
    console.warn(
      `[extensions] invalid "languages" contribution in "${extension.manifest.id}": expected an array`,
    );
    return () => {};
  }

  const addedIds: ExtensionLanguageId[] = [];
  for (const item of entries) {
    if (!isValidLanguageContribution(item)) {
      console.warn(
        `[extensions] skipping malformed language entry in "${extension.manifest.id}"`,
      );
      continue;
    }
    const id = makeExtensionLanguageId(extension.manifest.id, item.id);
    registeredById.set(id, {
      id,
      extensionId: extension.manifest.id,
      contribution: item,
    });
    addedIds.push(id);
  }
  rebuildLookupIndexes();

  return () => {
    for (const id of addedIds) {
      registeredById.delete(id);
    }
    rebuildLookupIndexes();
  };
}

// Register the built-in "languages" contribution kind.
registerContributionKind("languages", handleLanguageContributions);

/**
 * Look up an extension-provided language for `path`.
 * Checks exact/case-insensitive basenames (`filenames`) first, then longest
 * matching lower-case extension (`extensions`).
 */
export function findExtensionLanguageForPath(path: string): ExtensionLanguageId | null {
  if (registeredById.size === 0) return null;
  const base = baseNameOf(path);
  if (!base) return null;

  const exact = byExactBasename.get(base);
  if (exact) return exact;

  const lower = base.toLowerCase();
  const lowerMatch = byLowerBasename.get(lower);
  if (lowerMatch) return lowerMatch;

  for (const ext of sortedExtensionsDesc) {
    if (lower.length > ext.length && lower.endsWith(ext)) {
      return byExtension.get(ext) ?? null;
    }
  }
  return null;
}

/** Return the registered language entry for an extension language id, if active. */
export function getExtensionLanguage(
  id: ExtensionLanguageId,
): RegisteredExtensionLanguage | undefined {
  return registeredById.get(id);
}

/** List all currently active extension languages. */
export function listExtensionLanguages(): readonly RegisteredExtensionLanguage[] {
  return [...registeredById.values()];
}

export interface CompiledSimpleMode {
  states: Record<string, SimpleModeCmRule[]> & { start: SimpleModeCmRule[] };
  languageData?: SimpleModeFile["languageData"];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCommentTokens(
  raw: unknown,
): { line?: string; block?: { open: string; close: string } } | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error("Invalid simpleMode languageData.commentTokens");
  }
  const out: { line?: string; block?: { open: string; close: string } } = {};
  if (raw.line !== undefined) {
    if (typeof raw.line !== "string") {
      throw new Error("Invalid commentTokens.line: expected string");
    }
    out.line = raw.line;
  }
  if (raw.block !== undefined) {
    if (
      !isPlainObject(raw.block) ||
      typeof raw.block.open !== "string" ||
      typeof raw.block.close !== "string"
    ) {
      throw new Error("Invalid commentTokens.block: expected { open, close }");
    }
    out.block = { open: raw.block.open, close: raw.block.close };
  }
  return out;
}

/**
 * Pure validator/converter from a parsed `SimpleModeFile` JSON object to
 * CodeMirror `simpleMode` states with compiled `RegExp` rules.
 *
 * Enforces:
 * - `states.start` is required
 * - total rules across all states capped at `MAX_SIMPLE_MODE_RULES` (2000)
 * - regex flags restricted to `""` or `"i"` only
 * - all `next`/`push` targets must reference a defined state
 * - invalid regexes throw a descriptive error
 */
export function convertSimpleModeFile(raw: unknown): CompiledSimpleMode {
  if (!isPlainObject(raw)) {
    throw new Error("SimpleMode grammar must be a JSON object");
  }
  const rawStates = raw.states;
  if (!isPlainObject(rawStates)) {
    throw new Error("SimpleMode grammar must define a 'states' object");
  }
  if (!Object.prototype.hasOwnProperty.call(rawStates, "start") || !Array.isArray(rawStates.start)) {
    throw new Error("SimpleMode grammar requires 'states.start' array");
  }

  const stateNames = Object.keys(rawStates);
  for (const stateName of stateNames) {
    if (!stateName || RESERVED_STATE_KEYS.has(stateName)) {
      throw new Error(`Invalid simpleMode state name: "${stateName}"`);
    }
    if (!Array.isArray(rawStates[stateName])) {
      throw new Error(`SimpleMode state "${stateName}" must be an array of rules`);
    }
  }
  const validStates = new Set(stateNames);

  const compiledStates: Record<string, SimpleModeCmRule[]> = {};
  let totalRules = 0;

  for (const stateName of stateNames) {
    const rawRules = rawStates[stateName] as unknown[];
    totalRules += rawRules.length;
    if (totalRules > MAX_SIMPLE_MODE_RULES) {
      throw new Error(`SimpleMode grammar exceeds maximum of ${MAX_SIMPLE_MODE_RULES} rules`);
    }

    const rules: SimpleModeCmRule[] = [];
    for (let i = 0; i < rawRules.length; i++) {
      const rule = rawRules[i];
      if (!isPlainObject(rule)) {
        throw new Error(`SimpleMode rule ${stateName}[${i}] must be an object`);
      }
      if (typeof rule.regex !== "string") {
        throw new Error(`SimpleMode rule ${stateName}[${i}] must have a string 'regex'`);
      }

      let flags = "";
      if (rule.flags !== undefined) {
        if (typeof rule.flags !== "string" || (rule.flags !== "" && rule.flags !== "i")) {
          throw new Error(
            `SimpleMode rule ${stateName}[${i}] has unsupported regex flags "${String(rule.flags)}" (only "i" is allowed)`,
          );
        }
        flags = rule.flags;
      }

      let compiledRegex: RegExp;
      try {
        compiledRegex = new RegExp(rule.regex, flags);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid regex in simpleMode rule ${stateName}[${i}]: ${msg}`);
      }

      let token: string | string[] | null | undefined;
      if (rule.token === undefined || rule.token === null) {
        token = rule.token;
      } else if (typeof rule.token === "string") {
        token = rule.token;
      } else if (Array.isArray(rule.token)) {
        for (const item of rule.token) {
          if (item !== null && typeof item !== "string") {
            throw new Error(`Invalid token array entry in simpleMode rule ${stateName}[${i}]`);
          }
        }
        token = rule.token as string[];
      } else {
        throw new Error(`Invalid 'token' in simpleMode rule ${stateName}[${i}]`);
      }

      const out: SimpleModeCmRule = { regex: compiledRegex };
      if (token !== undefined) out.token = token;

      if (rule.next !== undefined) {
        if (typeof rule.next !== "string" || !validStates.has(rule.next)) {
          throw new Error(`Unknown 'next' state "${String(rule.next)}" in ${stateName}[${i}]`);
        }
        out.next = rule.next;
      }
      if (rule.push !== undefined) {
        if (typeof rule.push !== "string" || !validStates.has(rule.push)) {
          throw new Error(`Unknown 'push' state "${String(rule.push)}" in ${stateName}[${i}]`);
        }
        out.push = rule.push;
      }
      if (rule.pop !== undefined) {
        if (typeof rule.pop !== "boolean") {
          throw new Error(`Invalid 'pop' in ${stateName}[${i}]: expected boolean`);
        }
        out.pop = rule.pop;
      }
      if (rule.sol !== undefined) {
        if (typeof rule.sol !== "boolean") {
          throw new Error(`Invalid 'sol' in ${stateName}[${i}]: expected boolean`);
        }
        out.sol = rule.sol;
      }
      if (rule.indent !== undefined) {
        if (typeof rule.indent !== "boolean") {
          throw new Error(`Invalid 'indent' in ${stateName}[${i}]: expected boolean`);
        }
        out.indent = rule.indent;
      }
      if (rule.dedent !== undefined) {
        if (typeof rule.dedent !== "boolean") {
          throw new Error(`Invalid 'dedent' in ${stateName}[${i}]: expected boolean`);
        }
        out.dedent = rule.dedent;
      }

      rules.push(out);
    }

    compiledStates[stateName] = rules;
  }

  let languageData: SimpleModeFile["languageData"];
  if (raw.languageData !== undefined) {
    if (!isPlainObject(raw.languageData)) {
      throw new Error("Invalid simpleMode languageData: expected object");
    }
    const commentTokens = validateCommentTokens(raw.languageData.commentTokens);
    if (commentTokens) {
      languageData = { commentTokens };
    }
  }

  return {
    states: compiledStates as CompiledSimpleMode["states"],
    languageData,
  };
}

/** Parse and validate a `SimpleModeFile` JSON string. */
export function parseSimpleModeJson(jsonText: string): CompiledSimpleMode {
  const parsed: unknown = JSON.parse(jsonText);
  return convertSimpleModeFile(parsed);
}

function buildCommentTokens(
  comments: LanguageContribution["comments"],
): { line?: string; block?: { open: string; close: string } } | undefined {
  if (!comments) return undefined;
  const out: { line?: string; block?: { open: string; close: string } } = {};
  if (typeof comments.line === "string" && comments.line.length > 0) {
    out.line = comments.line;
  }
  if (
    Array.isArray(comments.block) &&
    comments.block.length === 2 &&
    typeof comments.block[0] === "string" &&
    typeof comments.block[1] === "string" &&
    comments.block[0].length > 0 &&
    comments.block[1].length > 0
  ) {
    out.block = { open: comments.block[0], close: comments.block[1] };
  }
  return out.line || out.block ? out : undefined;
}

function isStreamParser(value: unknown): value is StreamParser<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StreamParser<unknown>).token === "function"
  );
}

function isValidIndentUnit(unit: string): boolean {
  return /^( +|\t+)$/.test(unit);
}

async function wrapStreamParser(
  parser: StreamParser<unknown>,
  contribution: LanguageContribution,
  extraLanguageData?: SimpleModeFile["languageData"],
): Promise<Extension> {
  const { StreamLanguage, indentUnit } = await import("@codemirror/language");

  const fromContrib = buildCommentTokens(contribution.comments);
  const fromSimple = extraLanguageData?.commentTokens;
  const existingData = (parser.languageData ?? {}) as Record<string, unknown>;
  const existingComments = isPlainObject(existingData.commentTokens)
    ? (existingData.commentTokens as Record<string, unknown>)
    : undefined;

  let mergedParser: StreamParser<unknown> = parser;
  if (fromContrib || fromSimple) {
    mergedParser = {
      ...parser,
      languageData: {
        ...existingData,
        commentTokens: {
          ...(existingComments ?? {}),
          ...(fromSimple ?? {}),
          ...(fromContrib ?? {}),
        },
      },
    };
  }

  const lang = StreamLanguage.define(mergedParser);
  if (typeof contribution.indentUnit === "string" && contribution.indentUnit.length > 0) {
    if (isValidIndentUnit(contribution.indentUnit)) {
      return [lang, indentUnit.of(contribution.indentUnit)];
    }
    console.warn(
      `[extensions] ignoring invalid indentUnit "${contribution.indentUnit}" for language "${contribution.id}"`,
    );
  }
  return lang;
}

/**
 * Load a CodeMirror `Extension` for a registered extension language.
 * Returns `[]` (plain text, no highlighting) and logs a warning on unknown or invalid grammars.
 */
export async function loadExtensionLanguage(id: ExtensionLanguageId): Promise<Extension> {
  const registered = registeredById.get(id);
  if (!registered) return [];

  const { extensionId, contribution } = registered;
  const { grammar } = contribution;

  if ("legacyMode" in grammar) {
    const mode = grammar.legacyMode?.mode;
    const exportName = grammar.legacyMode?.export ?? mode;
    if (
      typeof mode !== "string" ||
      !SAFE_MODE_NAME.test(mode) ||
      mode === "simple-mode" ||
      typeof exportName !== "string" ||
      !exportName
    ) {
      console.warn(
        `[extensions] invalid legacyMode grammar in "${extensionId}" (${contribution.id}):`,
        grammar.legacyMode,
      );
      return [];
    }

    const loaderKey = `/node_modules/@codemirror/legacy-modes/mode/${mode}.js`;
    const loader = legacyModeLoaders[loaderKey];
    if (!loader) {
      console.warn(
        `[extensions] unknown legacyMode "${mode}" in "${extensionId}" (${contribution.id})`,
      );
      return [];
    }

    try {
      const mod = await loader();
      const candidate = mod[exportName];
      if (!isStreamParser(candidate)) {
        console.warn(
          `[extensions] export "${exportName}" in legacyMode "${mode}" is not a StreamParser (${extensionId})`,
        );
        return [];
      }
      return await wrapStreamParser(candidate, contribution);
    } catch (err) {
      console.warn(
        `[extensions] failed to load legacyMode "${mode}" (${extensionId}):`,
        err,
      );
      return [];
    }
  }

  if ("simpleMode" in grammar) {
    const filePath = grammar.simpleMode;
    if (typeof filePath !== "string" || !filePath.trim()) {
      console.warn(
        `[extensions] invalid simpleMode path in "${extensionId}" (${contribution.id})`,
      );
      return [];
    }

    try {
      const jsonText = await extApi.readFile(extensionId, filePath);
      const compiled = parseSimpleModeJson(jsonText);
      const { simpleMode } = await import("@codemirror/legacy-modes/mode/simple-mode");
      const parser = simpleMode(compiled.states);
      return await wrapStreamParser(parser, contribution, compiled.languageData);
    } catch (err) {
      console.warn(
        `[extensions] failed to load simpleMode "${filePath}" in "${extensionId}":`,
        err,
      );
      return [];
    }
  }

  console.warn(`[extensions] unknown grammar kind in "${extensionId}" (${contribution.id})`);
  return [];
}
