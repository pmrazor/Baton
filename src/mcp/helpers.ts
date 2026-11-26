import { toHubError } from "../api";
import {
  mcpApi,
  type McpAgentOwnServer,
  type McpAgentSupport,
  type McpCheckResult,
  type McpEnvVar,
  type McpServerConfig,
} from "./api";

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  dsh: "DeepSeek",
};

export interface McpServerDraft {
  name: string;
  enabled: boolean;
  type: "stdio" | "http";
  command: string;
  /** Newline-separated command arguments. */
  argsText: string;
  env: McpEnvVar[];
  url: string;
  headers: McpEnvVar[];
}

export interface ValidationErrors {
  name?: string;
  command?: string;
  url?: string;
  env?: string;
  headers?: string;
}

export interface ImportSkippedItem {
  name: string;
  reason: string;
}

export interface ImportMcpResult {
  servers: McpServerConfig[];
  skipped: ImportSkippedItem[];
  error: string | null;
}

export interface OwnServerGroup {
  agentId: string;
  agentName: string;
  sources: string[];
  servers: McpAgentOwnServer[];
}

export function emptyDraft(): McpServerDraft {
  return {
    name: "",
    enabled: true,
    type: "stdio",
    command: "",
    argsText: "",
    env: [],
    url: "",
    headers: [],
  };
}

export function draftFromServer(server: McpServerConfig): McpServerDraft {
  if (server.transport.type === "stdio") {
    return {
      name: server.name,
      enabled: server.enabled,
      type: "stdio",
      command: server.transport.command,
      argsText: server.transport.args.join("\n"),
      env: server.transport.env.map((e) => ({ ...e })),
      url: "",
      headers: [],
    };
  }
  return {
    name: server.name,
    enabled: server.enabled,
    type: "http",
    command: "",
    argsText: "",
    env: [],
    url: server.transport.url,
    headers: server.transport.headers.map((h) => ({ ...h })),
  };
}

function cleanPairs(rows: McpEnvVar[]): McpEnvVar[] {
  return rows
    .filter((r) => r.name.trim() !== "" || r.value !== "")
    .map((r) => ({ name: r.name.trim(), value: r.value }));
}

export function draftToServer(draft: McpServerDraft): McpServerConfig {
  const name = draft.name.trim();
  if (draft.type === "stdio") {
    const args = draft.argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return {
      name,
      enabled: draft.enabled,
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args,
        env: cleanPairs(draft.env),
      },
    };
  }
  return {
    name,
    enabled: draft.enabled,
    transport: {
      type: "http",
      url: draft.url.trim(),
      headers: cleanPairs(draft.headers),
    },
  };
}

export function serverSummary(server: McpServerConfig): string {
  if (server.transport.type === "stdio") {
    return [server.transport.command, ...server.transport.args].filter(Boolean).join(" ");
  }
  return server.transport.url;
}

function isLocalhostHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function validateHttpUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "서버 URL을 입력해 주세요.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "올바른 URL 형식이 아니에요.";
  }
  if (parsed.protocol === "https:") {
    return undefined;
  }
  if (parsed.protocol === "http:") {
    if (isLocalhostHost(parsed.hostname)) return undefined;
    return "http:// 주소는 localhost(127.0.0.1, ::1)에서만 사용할 수 있어요. 원격 서버는 https://를 사용해 주세요.";
  }
  return "https:// 주소(또는 localhost의 http://)만 사용할 수 있어요.";
}

function validatePairs(rows: McpEnvVar[], kind: "env" | "headers"): string | undefined {
  const seen = new Set<string>();
  const label = kind === "env" ? "환경 변수" : "헤더";
  for (const row of rows) {
    const trimmedName = row.name.trim();
    if (!trimmedName && row.value === "") continue;
    if (!trimmedName) {
      return `${label} 이름을 입력해 주세요.`;
    }
    const key = kind === "headers" ? trimmedName.toLowerCase() : trimmedName;
    if (seen.has(key)) {
      return `같은 이름의 ${label}가 중복되어 있어요.`;
    }
    seen.add(key);
  }
  return undefined;
}

/** Validate a draft MCP server config and return field-keyed Korean error messages. */
export function validateServer(
  draft: McpServerDraft,
  existingNames: Iterable<string> = [],
): ValidationErrors {
  const errors: ValidationErrors = {};
  const existing = new Set(existingNames);
  const name = draft.name.trim();

  if (!name) {
    errors.name = "서버 이름을 입력해 주세요.";
  } else if (!MCP_NAME_RE.test(name)) {
    errors.name = "이름은 영문, 숫자, -, _만 1~64자로 입력할 수 있어요.";
  } else if (name.toLowerCase() === "baton") {
    errors.name = '"baton"은 예약된 이름이라 사용할 수 없어요.';
  } else if (existing.has(name)) {
    errors.name = "이미 같은 이름의 서버가 있어요.";
  }

  if (draft.type === "stdio") {
    if (!draft.command.trim()) {
      errors.command = "실행할 명령을 입력해 주세요.";
    }
    const envErr = validatePairs(draft.env, "env");
    if (envErr) errors.env = envErr;
  } else {
    const urlErr = validateHttpUrl(draft.url);
    if (urlErr) errors.url = urlErr;
    const headerErr = validatePairs(draft.headers, "headers");
    if (headerErr) errors.headers = headerErr;
  }

  return errors;
}

export function hasValidationErrors(errors: ValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseKeyValueMap(raw: unknown): McpEnvVar[] | null {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    const out: McpEnvVar[] = [];
    for (const item of raw) {
      if (!isPlainObject(item) || typeof item.name !== "string") return null;
      const value = item.value === undefined || item.value === null ? "" : String(item.value);
      out.push({ name: item.name.trim(), value });
    }
    return out;
  }
  if (isPlainObject(raw)) {
    const out: McpEnvVar[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
      out.push({ name: k.trim(), value: String(v) });
    }
    return out;
  }
  return null;
}

function looksLikeServerEntry(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.command === "string" ||
    typeof obj.url === "string" ||
    typeof obj.type === "string"
  );
}

/** Top-level keys that wrap the `name → server` map: Claude/Cursor, VS Code, Codex. */
const SERVER_WRAPPER_KEYS = ["mcpServers", "servers", "mcp_servers"] as const;

export type McpImportFormat = "auto" | "json" | "toml";

/** `auto` picks JSON when the text starts with `{`, otherwise TOML. */
export function resolveMcpImportFormat(
  text: string,
  format: McpImportFormat = "auto",
): "json" | "toml" {
  if (format !== "auto") return format;
  return text.trimStart().startsWith("{") ? "json" : "toml";
}

/**
 * Convert an already-parsed config (Claude `mcpServers`, VS Code `servers`, Codex
 * `mcp_servers`, or a bare `{ "<name>": { ... } }` map) into Baton `McpServerConfig`
 * entries, with skipped items and Korean notes.
 */
export function importMcpConfig(
  parsed: unknown,
  existingNames: Iterable<string> = [],
): ImportMcpResult {
  if (!isPlainObject(parsed)) {
    return { servers: [], skipped: [], error: "설정은 객체 형식이어야 해요." };
  }

  let entriesObj: Record<string, unknown> = parsed;
  const wrapperKey = SERVER_WRAPPER_KEYS.find((key) => key in parsed);
  if (wrapperKey) {
    const inner = parsed[wrapperKey];
    if (!isPlainObject(inner)) {
      return {
        servers: [],
        skipped: [],
        error: `"${wrapperKey}" 값은 객체여야 해요.`,
      };
    }
    // A bare server entry that happens to be named like a wrapper stays as-is.
    if (!looksLikeServerEntry(inner)) {
      entriesObj = inner;
    }
  }

  const servers: McpServerConfig[] = [];
  const skipped: ImportSkippedItem[] = [];
  const takenNames = new Set(existingNames);

  for (const [rawName, rawConfig] of Object.entries(entriesObj)) {
    const name = rawName.trim();
    if (!isPlainObject(rawConfig)) {
      skipped.push({ name: name || rawName, reason: "서버 설정 형식이 올바르지 않아요." });
      continue;
    }

    if (!name || !MCP_NAME_RE.test(name)) {
      skipped.push({
        name: name || rawName,
        reason: "이름은 영문, 숫자, -, _만 1~64자로 입력할 수 있어요.",
      });
      continue;
    }
    if (name.toLowerCase() === "baton") {
      skipped.push({ name, reason: '"baton"은 예약된 이름이라 가져올 수 없어요.' });
      continue;
    }
    if (takenNames.has(name)) {
      skipped.push({ name, reason: "이미 같은 이름의 서버가 있어요." });
      continue;
    }

    const rawType = typeof rawConfig.type === "string" ? rawConfig.type.trim().toLowerCase() : "";
    if (rawType === "sse") {
      skipped.push({ name, reason: "sse 서버는 아직 지원하지 않아요." });
      continue;
    }
    // Codex: the token is read from an env var at runtime; Baton stores plain headers only.
    if (rawConfig.bearer_token_env_var !== undefined && rawConfig.bearer_token_env_var !== null) {
      skipped.push({
        name,
        reason: "bearer_token_env_var는 아직 지원하지 않아요 · 헤더로 직접 넣어 주세요",
      });
      continue;
    }
    if (rawConfig.env_http_headers !== undefined && rawConfig.env_http_headers !== null) {
      skipped.push({
        name,
        reason: "env_http_headers는 아직 지원하지 않아요 · 헤더 값을 직접 넣어 주세요",
      });
      continue;
    }

    const enabled =
      typeof rawConfig.enabled === "boolean"
        ? rawConfig.enabled
        : typeof rawConfig.disabled === "boolean"
          ? !rawConfig.disabled
          : true;

    const isHttp =
      rawType === "http" ||
      rawType === "streamable-http" ||
      rawType === "streamablehttp" ||
      (!rawType && typeof rawConfig.url === "string" && typeof rawConfig.command !== "string");

    const isStdio =
      rawType === "stdio" ||
      (!rawType && typeof rawConfig.command === "string");

    if (rawType && !isHttp && !isStdio) {
      skipped.push({ name, reason: `지원하지 않는 전송 방식(${rawType})이에요.` });
      continue;
    }

    if (isHttp) {
      const url = typeof rawConfig.url === "string" ? rawConfig.url.trim() : "";
      const urlErr = validateHttpUrl(url);
      if (urlErr) {
        skipped.push({ name, reason: urlErr });
        continue;
      }
      // VS Code uses `headers`; Codex uses `http_headers`.
      const headers = parseKeyValueMap(rawConfig.headers ?? rawConfig.http_headers);
      if (headers === null) {
        skipped.push({ name, reason: "headers 형식이 올바르지 않아요." });
        continue;
      }
      const headerErr = validatePairs(headers, "headers");
      if (headerErr) {
        skipped.push({ name, reason: headerErr });
        continue;
      }
      servers.push({
        name,
        enabled,
        transport: { type: "http", url, headers: cleanPairs(headers) },
      });
      takenNames.add(name);
      continue;
    }

    if (isStdio) {
      const command = typeof rawConfig.command === "string" ? rawConfig.command.trim() : "";
      if (!command) {
        skipped.push({ name, reason: "실행할 명령(command)이 비어 있어요." });
        continue;
      }
      let args: string[] = [];
      if (rawConfig.args !== undefined && rawConfig.args !== null) {
        if (!Array.isArray(rawConfig.args) || !rawConfig.args.every((a) => typeof a === "string")) {
          skipped.push({ name, reason: "args는 문자열 배열이어야 해요." });
          continue;
        }
        args = rawConfig.args;
      }
      const env = parseKeyValueMap(rawConfig.env);
      if (env === null) {
        skipped.push({ name, reason: "env 형식이 올바르지 않아요." });
        continue;
      }
      const envErr = validatePairs(env, "env");
      if (envErr) {
        skipped.push({ name, reason: envErr });
        continue;
      }
      servers.push({
        name,
        enabled,
        transport: { type: "stdio", command, args, env: cleanPairs(env) },
      });
      takenNames.add(name);
      continue;
    }

    skipped.push({ name, reason: "command 또는 url 항목이 필요해요." });
  }

  return { servers, skipped, error: null };
}

/** Parse pasted JSON text, then import it. */
export function importMcpJson(
  text: string,
  existingNames: Iterable<string> = [],
): ImportMcpResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { servers: [], skipped: [], error: "가져올 JSON을 입력해 주세요." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { servers: [], skipped: [], error: "올바른 JSON 형식이 아니에요." };
  }
  return importMcpConfig(parsed, existingNames);
}

/**
 * Import pasted JSON or TOML. TOML is parsed by the backend (`mcp_parse_toml`),
 * then goes through the same `importMcpConfig` as JSON.
 */
export async function importMcpText(
  text: string,
  format: McpImportFormat,
  existingNames: Iterable<string> = [],
): Promise<ImportMcpResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { servers: [], skipped: [], error: "가져올 JSON 또는 TOML을 입력해 주세요." };
  }
  if (resolveMcpImportFormat(trimmed, format) === "json") {
    return importMcpJson(trimmed, existingNames);
  }
  let parsed: unknown;
  try {
    parsed = await mcpApi.parseToml(trimmed);
  } catch (err) {
    return { servers: [], skipped: [], error: toHubError(err).message };
  }
  return importMcpConfig(parsed, existingNames);
}

export function agentDisplayName(agentId: string, support: McpAgentSupport[]): string {
  const match = support.find((a) => a.agentId === agentId);
  if (match?.agentName) return match.agentName;
  return DEFAULT_AGENT_NAMES[agentId] ?? agentId;
}

export function groupOwnServersByAgent(
  ownServers: McpAgentOwnServer[],
  support: McpAgentSupport[],
): OwnServerGroup[] {
  const map = new Map<string, OwnServerGroup>();
  for (const srv of ownServers) {
    let group = map.get(srv.agentId);
    if (!group) {
      group = {
        agentId: srv.agentId,
        agentName: agentDisplayName(srv.agentId, support),
        sources: [],
        servers: [],
      };
      map.set(srv.agentId, group);
    }
    if (srv.source && !group.sources.includes(srv.source)) {
      group.sources.push(srv.source);
    }
    group.servers.push(srv);
  }
  return Array.from(map.values());
}

export function findOwnServerConflictAgents(
  serverName: string,
  ownServers: McpAgentOwnServer[],
  support: McpAgentSupport[],
): string[] {
  const names: string[] = [];
  for (const own of ownServers) {
    if (own.name !== serverName) continue;
    const label = agentDisplayName(own.agentId, support);
    if (!names.includes(label)) names.push(label);
  }
  return names;
}

export function formatConflictWarning(agentNames: string[]): string | null {
  if (agentNames.length === 0) return null;
  return `${agentNames.join(", ")} 설정에도 같은 이름이 있어요 · 중복으로 붙을 수 있어요`;
}

export function formatCheckSummary(result: McpCheckResult): string {
  return `연결됨 · 도구 ${result.tools.length}개 · ${result.elapsedMs}ms`;
}

export interface LoadedMcpState {
  servers: McpServerConfig[];
  support: McpAgentSupport[];
  ownServers: McpAgentOwnServer[];
  error: string | null;
}

/** Load shared servers, agent transport support, and agent-own servers in parallel. */
export async function loadMcpSettings(): Promise<LoadedMcpState> {
  const [listRes, supportRes, ownRes] = await Promise.allSettled([
    mcpApi.list(),
    mcpApi.agentSupport(),
    mcpApi.agentOwnServers(),
  ]);

  const errors: string[] = [];
  const servers = listRes.status === "fulfilled" ? listRes.value : (errors.push(toHubError(listRes.reason).message), []);
  const support =
    supportRes.status === "fulfilled"
      ? supportRes.value
      : (errors.push(toHubError(supportRes.reason).message), []);
  const ownServers =
    ownRes.status === "fulfilled" ? ownRes.value : (errors.push(toHubError(ownRes.reason).message), []);

  return {
    servers,
    support,
    ownServers,
    error: errors.length > 0 ? `MCP 설정을 불러오지 못했어요: ${errors[0]}` : null,
  };
}

export async function toggleMcpServer(
  servers: McpServerConfig[],
  name: string,
  enabled: boolean,
): Promise<McpServerConfig[]> {
  const next = servers.map((s) => (s.name === name ? { ...s, enabled } : s));
  await mcpApi.save(next);
  return next;
}

export async function deleteMcpServer(
  servers: McpServerConfig[],
  name: string,
): Promise<McpServerConfig[]> {
  const next = servers.filter((s) => s.name !== name);
  await mcpApi.save(next);
  return next;
}

export async function upsertMcpServer(
  servers: McpServerConfig[],
  server: McpServerConfig,
  editingName: string | null,
): Promise<McpServerConfig[]> {
  const next =
    editingName === null
      ? [...servers, server]
      : servers.map((s) => (s.name === editingName ? server : s));
  await mcpApi.save(next);
  return next;
}

export async function appendImportedMcpServers(
  servers: McpServerConfig[],
  imported: McpServerConfig[],
): Promise<McpServerConfig[]> {
  const existing = new Set(servers.map((s) => s.name));
  const additions = imported.filter((s) => !existing.has(s.name));
  const next = [...servers, ...additions];
  await mcpApi.save(next);
  return next;
}

export async function checkMcpServer(server: McpServerConfig): Promise<McpCheckResult> {
  try {
    return await mcpApi.check(server);
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: toHubError(err).message,
      elapsedMs: 0,
    };
  }
}
