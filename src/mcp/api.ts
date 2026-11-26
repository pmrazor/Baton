// Shared MCP servers: registered once in Baton's settings and attached to every
// agent session Baton starts (ACP `session/new` / `session/load` mcpServers),
// so all agents get the same tools. Stored as `mcp.json` in the app config dir.
//
// Agents may also have MCP servers in their own config (e.g. ~/.claude.json,
// ~/.codex/config.toml); those keep working as before and are listed read-only.

import { invoke } from "@tauri-apps/api/core";

export interface McpEnvVar {
  name: string;
  value: string;
}

export type McpTransport =
  | { type: "stdio"; command: string; args: string[]; env: McpEnvVar[] }
  | { type: "http"; url: string; headers: McpEnvVar[] };

export interface McpServerConfig {
  /** Unique, `[A-Za-z0-9_-]{1,64}`; the name agents see. */
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

/** Result of starting a server and running MCP `initialize` + `tools/list`. */
export interface McpCheckResult {
  ok: boolean;
  /** Server-reported name/version from `initialize`, when it answered. */
  serverName?: string | null;
  serverVersion?: string | null;
  tools: { name: string; description?: string | null }[];
  /** Korean message when `ok` is false. */
  error?: string | null;
  elapsedMs: number;
}

/** Whether each installed agent can take a server of this transport. */
export interface McpAgentSupport {
  agentId: string;
  agentName: string;
  /** stdio: always (ACP requires it); http: the agent's `mcpCapabilities.http`; null = unknown until the agent has started once. */
  http: boolean | null;
}

/** A server an agent has in its own config (read-only, informational). */
export interface McpAgentOwnServer {
  agentId: string;
  /** e.g. "~/.claude.json" or "~/.codex/config.toml". */
  source: string;
  name: string;
  /** "stdio" | "http" | "sse" | other as written in that config. */
  kind: string;
  /** Command line or URL, with secrets left out. */
  summary: string;
}

export const mcpApi = {
  list: () => invoke<McpServerConfig[]>("mcp_list"),
  /** Replaces the whole list (validated: unique names, required fields). New sessions use it right away. */
  save: (servers: McpServerConfig[]) => invoke<void>("mcp_save", { servers }),
  check: (server: McpServerConfig) => invoke<McpCheckResult>("mcp_check", { server }),
  agentSupport: () => invoke<McpAgentSupport[]>("mcp_agent_support"),
  agentOwnServers: () => invoke<McpAgentOwnServer[]>("mcp_agent_own_servers"),
  parseToml: (text: string) => invoke<unknown>("mcp_parse_toml", { text }),
};
