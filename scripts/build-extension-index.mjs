#!/usr/bin/env node
// Builds extensions/index.json from the extension folders.
// Node ESM with no dependencies: run with `npm run extensions:index`.

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");
const INDEX_PATH = path.join(EXTENSIONS_DIR, "index.json");
const MAX_FILE_SIZE = 1024 * 1024;
const ID_RE = /^[a-z0-9-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(`build-extension-index: ${message}`);
  process.exit(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => compareStrings(a.name, b.name));
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(abs, rel)));
    } else if (entry.isFile()) {
      files.push({ abs, rel });
    } else {
      fail(`${rel}: only regular files and folders are allowed`);
    }
  }
  return files;
}

function checkStringList(value, where, prefix) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} must be a non-empty array`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      fail(`${where} must contain non-empty strings`);
    }
    if (prefix && !item.startsWith(prefix)) {
      fail(`${where}: "${item}" must start with "${prefix}"`);
    }
  }
}

async function validateLanguage(extensionId, index, language, dir) {
  const where = `${extensionId}: contributes.languages[${index}]`;
  if (!isPlainObject(language)) fail(`${where} must be an object`);
  if (typeof language.id !== "string" || !ID_RE.test(language.id)) {
    fail(`${where}.id must match ${ID_RE}`);
  }
  if (typeof language.name !== "string" || !language.name.trim()) {
    fail(`${where}.name is required`);
  }
  checkStringList(language.extensions, `${where}.extensions`, ".");
  checkStringList(language.filenames, `${where}.filenames`);

  const grammar = language.grammar;
  if (!isPlainObject(grammar)) fail(`${where}.grammar is required`);

  const hasLegacy = grammar.legacyMode !== undefined;
  const hasSimple = grammar.simpleMode !== undefined;
  if (hasLegacy === hasSimple) {
    fail(`${where}.grammar must have exactly one of legacyMode or simpleMode`);
  }

  if (hasLegacy) {
    if (!isPlainObject(grammar.legacyMode)) {
      fail(`${where}.grammar.legacyMode must be an object`);
    }
    if (typeof grammar.legacyMode.mode !== "string" || !grammar.legacyMode.mode) {
      fail(`${where}.grammar.legacyMode.mode is required`);
    }
    if (
      grammar.legacyMode.export !== undefined &&
      (typeof grammar.legacyMode.export !== "string" || !grammar.legacyMode.export)
    ) {
      fail(`${where}.grammar.legacyMode.export must be a non-empty string when given`);
    }
    return;
  }

  const rel = grammar.simpleMode;
  if (typeof rel !== "string" || !rel) {
    fail(`${where}.grammar.simpleMode must be a file path`);
  }
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    fail(`${where}.grammar.simpleMode must be a relative path without ".."`);
  }
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    fail(`${where}.grammar.simpleMode escapes the extension folder`);
  }
  let text;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    fail(`${where}.grammar.simpleMode: ${rel} not found`);
  }
  let simple;
  try {
    simple = JSON.parse(text);
  } catch (error) {
    fail(`${where}.grammar.simpleMode: ${rel} is not valid JSON (${error.message})`);
  }
  if (
    !isPlainObject(simple) ||
    !isPlainObject(simple.states) ||
    !Array.isArray(simple.states.start) ||
    simple.states.start.length === 0
  ) {
    fail(`${where}.grammar.simpleMode: ${rel} must have a non-empty states.start array`);
  }
}

function keywordsFor(languages) {
  const keywords = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim() && !keywords.includes(value)) {
      keywords.push(value);
    }
  };
  for (const language of languages) {
    add(language.id);
    for (const extension of language.extensions ?? []) add(extension);
    for (const filename of language.filenames ?? []) add(filename);
  }
  return keywords;
}

async function loadExtension(folderName) {
  const dir = path.join(EXTENSIONS_DIR, folderName);
  const manifestPath = path.join(dir, "extension.json");

  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    fail(`${folderName}: missing extension.json`);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`${folderName}/extension.json: invalid JSON (${error.message})`);
  }
  if (!isPlainObject(manifest)) fail(`${folderName}/extension.json must be an object`);

  if (typeof manifest.id !== "string" || !ID_RE.test(manifest.id)) {
    fail(`${folderName}: manifest id must match ${ID_RE}`);
  }
  if (manifest.id !== folderName) {
    fail(`${folderName}: manifest id "${manifest.id}" must equal the folder name`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail(`${folderName}: manifest name is required`);
  }
  if (typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) {
    fail(`${folderName}: manifest version must be x.y.z`);
  }
  if (!isPlainObject(manifest.contributes)) {
    fail(`${folderName}: manifest contributes must be an object`);
  }

  const languages = manifest.contributes.languages;
  if (!Array.isArray(languages) || languages.length === 0) {
    fail(`${folderName}: contributes.languages must be a non-empty array`);
  }
  for (const [index, language] of languages.entries()) {
    await validateLanguage(manifest.id, index, language, dir);
  }

  const files = [];
  for (const file of await listFiles(dir)) {
    const info = await stat(file.abs);
    if (info.size > MAX_FILE_SIZE) {
      fail(`${folderName}/${file.rel}: ${info.size} bytes exceeds the 1 MB limit`);
    }
    const bytes = await readFile(file.abs);
    if (bytes.length > MAX_FILE_SIZE) {
      fail(`${folderName}/${file.rel}: ${bytes.length} bytes exceeds the 1 MB limit`);
    }
    files.push({ path: file.rel, sha256: sha256(bytes), size: bytes.length });
  }
  files.sort((a, b) => {
    if (a.path === "extension.json") return -1;
    if (b.path === "extension.json") return 1;
    return compareStrings(a.path, b.path);
  });

  const kinds = Object.keys(manifest.contributes)
    .filter((kind) => Array.isArray(manifest.contributes[kind]) && manifest.contributes[kind].length > 0)
    .sort(compareStrings);

  const entry = { id: manifest.id, name: manifest.name, version: manifest.version };
  if (typeof manifest.description === "string") entry.description = manifest.description;
  if (typeof manifest.publisher === "string") entry.publisher = manifest.publisher;
  if (typeof manifest.baton === "string") entry.baton = manifest.baton;
  entry.kinds = kinds;
  entry.keywords = keywordsFor(languages);
  entry.files = files;
  return entry;
}

async function main() {
  let entries;
  try {
    entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true });
  } catch {
    fail(`no extensions folder at ${path.relative(ROOT, EXTENSIONS_DIR) || "."}`);
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);

  const extensions = [];
  for (const folder of folders) extensions.push(await loadExtension(folder));
  extensions.sort((a, b) => compareStrings(a.id, b.id));

  await writeFile(INDEX_PATH, `${JSON.stringify({ version: 1, extensions }, null, 2)}\n`);
  console.log(`build-extension-index: wrote ${extensions.length} extension(s) to extensions/index.json`);
}

await main();
