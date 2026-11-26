import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpApi,
  type McpAgentOwnServer,
  type McpAgentSupport,
  type McpCheckResult,
  type McpServerConfig,
} from "./api";
import {
  appendImportedMcpServers,
  checkMcpServer,
  deleteMcpServer,
  draftFromServer,
  draftToServer,
  emptyDraft,
  findOwnServerConflictAgents,
  formatCheckSummary,
  formatConflictWarning,
  groupOwnServersByAgent,
  hasValidationErrors,
  importMcpConfig,
  importMcpJson,
  importMcpText,
  loadMcpSettings,
  resolveMcpImportFormat,
  serverSummary,
  toggleMcpServer,
  upsertMcpServer,
  validateServer,
  type McpServerDraft,
} from "./helpers";

function makeStdioDraft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    ...emptyDraft(),
    name: "filesystem",
    type: "stdio",
    command: "npx",
    argsText: "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
    ...overrides,
  };
}

function makeHttpDraft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    ...emptyDraft(),
    name: "remote",
    type: "http",
    url: "https://mcp.example.com/v1",
    ...overrides,
  };
}

describe("validateServer", () => {
  it("accepts a valid stdio server draft", () => {
    const errors = validateServer(makeStdioDraft(), ["other"]);
    expect(hasValidationErrors(errors)).toBe(false);
  });

  it("rejects empty, invalid-character, too-long, reserved, and duplicate names", () => {
    expect(validateServer(makeStdioDraft({ name: "   " })).name).toBeTruthy();
    expect(validateServer(makeStdioDraft({ name: "bad name!" })).name).toMatch(/영문/);
    expect(validateServer(makeStdioDraft({ name: "a".repeat(65) })).name).toMatch(/64/);
    expect(validateServer(makeStdioDraft({ name: "baton" })).name).toMatch(/baton/);
    expect(validateServer(makeStdioDraft({ name: "Baton" })).name).toMatch(/baton/);
    expect(validateServer(makeStdioDraft({ name: "dup" }), ["dup"]).name).toMatch(/이미/);
  });

  it("allows 64-character names with letters, digits, hyphens, and underscores", () => {
    const okName = "A_z-09".repeat(10) + "abcd";
    expect(okName).toHaveLength(64);
    expect(hasValidationErrors(validateServer(makeStdioDraft({ name: okName })))).toBe(false);
  });

  it("validates stdio command and env rows", () => {
    expect(validateServer(makeStdioDraft({ command: "  " })).command).toBeTruthy();
    expect(
      validateServer(makeStdioDraft({ env: [{ name: "", value: "secret" }] })).env,
    ).toMatch(/환경 변수 이름/);
    expect(
      validateServer(
        makeStdioDraft({
          env: [
            { name: "TOKEN", value: "1" },
            { name: "TOKEN", value: "2" },
          ],
        }),
      ).env,
    ).toMatch(/중복/);
    // Blank trailing row is ignored.
    expect(
      hasValidationErrors(
        validateServer(
          makeStdioDraft({
            env: [
              { name: "TOKEN", value: "1" },
              { name: "", value: "" },
            ],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("validates http URLs (https everywhere, http only on localhost) and headers", () => {
    expect(hasValidationErrors(validateServer(makeHttpDraft({ url: "https://api.test/mcp" })))).toBe(
      false,
    );
    expect(
      hasValidationErrors(validateServer(makeHttpDraft({ url: "http://localhost:3000/mcp" }))),
    ).toBe(false);
    expect(
      hasValidationErrors(validateServer(makeHttpDraft({ url: "http://127.0.0.1:8080" }))),
    ).toBe(false);
    expect(
      hasValidationErrors(validateServer(makeHttpDraft({ url: "http://[::1]:8080/mcp" }))),
    ).toBe(false);

    expect(validateServer(makeHttpDraft({ url: "" })).url).toBeTruthy();
    expect(validateServer(makeHttpDraft({ url: "not-a-url" })).url).toMatch(/형식/);
    expect(validateServer(makeHttpDraft({ url: "http://example.com/mcp" })).url).toMatch(
      /localhost/,
    );
    expect(validateServer(makeHttpDraft({ url: "ftp://example.com/mcp" })).url).toMatch(/https/);

    expect(
      validateServer(makeHttpDraft({ headers: [{ name: "", value: "Bearer x" }] })).headers,
    ).toMatch(/헤더 이름/);
    expect(
      validateServer(
        makeHttpDraft({
          headers: [
            { name: "Authorization", value: "a" },
            { name: "authorization", value: "b" },
          ],
        }),
      ).headers,
    ).toMatch(/중복/);
  });
});

describe("draft conversion and summary", () => {
  it("round-trips stdio and http servers and drops blank lines/empty pairs", () => {
    const stdio = draftToServer(
      makeStdioDraft({
        name: " fs ",
        command: " npx ",
        argsText: " -y \n\n  @mcp/fs  \r\n  ",
        env: [
          { name: " KEY ", value: "val" },
          { name: "", value: "" },
        ],
      }),
    );
    expect(stdio).toEqual({
      name: "fs",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@mcp/fs"],
        env: [{ name: "KEY", value: "val" }],
      },
    });
    expect(serverSummary(stdio)).toBe("npx -y @mcp/fs");
    expect(draftToServer(draftFromServer(stdio))).toEqual(stdio);

    const http = draftToServer(
      makeHttpDraft({
        name: " remote ",
        url: " https://example.com/mcp ",
        headers: [{ name: " Authorization ", value: "Bearer 123" }],
      }),
    );
    expect(http).toEqual({
      name: "remote",
      enabled: true,
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer 123" }],
      },
    });
    expect(serverSummary(http)).toBe("https://example.com/mcp");
    expect(draftToServer(draftFromServer(http))).toEqual(http);
  });
});

describe("importMcpJson", () => {
  it("parses Claude-style wrapper object with stdio and http servers", () => {
    const json = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          env: { API_KEY: "secret", DEBUG: "1" },
        },
        docs: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });

    const result = importMcpJson(json);
    expect(result.error).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: "filesystem",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          env: [
            { name: "API_KEY", value: "secret" },
            { name: "DEBUG", value: "1" },
          ],
        },
      },
      {
        name: "docs",
        enabled: true,
        transport: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok" }],
        },
      },
    ]);
  });

  it("accepts inner object without mcpServers wrapper", () => {
    const json = JSON.stringify({
      local: { url: "http://localhost:8080/mcp" },
      disabled_srv: { command: "node", args: ["server.js"], disabled: true },
    });

    const result = importMcpJson(json);
    expect(result.error).toBeNull();
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toEqual({
      name: "local",
      enabled: true,
      transport: { type: "http", url: "http://localhost:8080/mcp", headers: [] },
    });
    expect(result.servers[1]).toEqual({
      name: "disabled_srv",
      enabled: false,
      transport: { type: "stdio", command: "node", args: ["server.js"], env: [] },
    });
  });

  it("skips sse servers with the expected Korean note, plus duplicates and invalid entries", () => {
    const json = JSON.stringify({
      mcpServers: {
        legacy: { type: "sse", url: "https://legacy.example.com/sse" },
        existing: { command: "npx", args: ["foo"] },
        baton: { command: "npx", args: ["bar"] },
        "bad name": { command: "npx" },
        insecure: { type: "http", url: "http://remote.example.com/mcp" },
        good: { command: "uvx", args: ["mcp-server-git"] },
      },
    });

    const result = importMcpJson(json, ["existing"]);
    expect(result.error).toBeNull();
    expect(result.servers.map((s) => s.name)).toEqual(["good"]);
    expect(result.skipped).toEqual([
      { name: "legacy", reason: "sse 서버는 아직 지원하지 않아요." },
      { name: "existing", reason: "이미 같은 이름의 서버가 있어요." },
      { name: "baton", reason: '"baton"은 예약된 이름이라 가져올 수 없어요.' },
      { name: "bad name", reason: "이름은 영문, 숫자, -, _만 1~64자로 입력할 수 있어요." },
      {
        name: "insecure",
        reason:
          "http:// 주소는 localhost(127.0.0.1, ::1)에서만 사용할 수 있어요. 원격 서버는 https://를 사용해 주세요.",
      },
    ]);
  });

  it("returns Korean error for empty, malformed, or non-object JSON", () => {
    expect(importMcpJson("   ").error).toBeTruthy();
    expect(importMcpJson("{invalid").error).toMatch(/JSON/);
    expect(importMcpJson("[]").error).toMatch(/객체/);
    expect(importMcpJson('{"mcpServers": []}').error).toMatch(/mcpServers/);
  });
});

describe("agent own servers grouping & conflict detection", () => {
  const support: McpAgentSupport[] = [
    { agentId: "claude", agentName: "Claude", http: true },
    { agentId: "codex", agentName: "Codex", http: null },
  ];
  const own: McpAgentOwnServer[] = [
    {
      agentId: "claude",
      source: "~/.claude.json",
      name: "github",
      kind: "stdio",
      summary: "npx -y @modelcontextprotocol/server-github",
    },
    {
      agentId: "claude",
      source: "~/.claude.json",
      name: "sentry",
      kind: "http",
      summary: "https://mcp.sentry.dev",
    },
    {
      agentId: "codex",
      source: "~/.codex/config.toml",
      name: "github",
      kind: "stdio",
      summary: "github-mcp",
    },
  ];

  it("groups own servers by agent with unique source paths", () => {
    const groups = groupOwnServersByAgent(own, support);
    expect(groups).toHaveLength(2);
    expect(groups[0].agentName).toBe("Claude");
    expect(groups[0].sources).toEqual(["~/.claude.json"]);
    expect(groups[0].servers).toHaveLength(2);
    expect(groups[1].agentName).toBe("Codex");
    expect(groups[1].sources).toEqual(["~/.codex/config.toml"]);
  });

  it("formats conflict warnings matching shared server names", () => {
    const claudeOnly = findOwnServerConflictAgents("sentry", own, support);
    expect(formatConflictWarning(claudeOnly)).toBe(
      "Claude 설정에도 같은 이름이 있어요 · 중복으로 붙을 수 있어요",
    );

    const both = findOwnServerConflictAgents("github", own, support);
    expect(formatConflictWarning(both)).toBe(
      "Claude, Codex 설정에도 같은 이름이 있어요 · 중복으로 붙을 수 있어요",
    );

    expect(formatConflictWarning(findOwnServerConflictAgents("none", own, support))).toBeNull();
  });

  it("formats check summary", () => {
    const res: McpCheckResult = {
      ok: true,
      tools: [
        { name: "read_file", description: "Read a file" },
        { name: "list_dir", description: null },
      ],
      elapsedMs: 142,
    };
    expect(formatCheckSummary(res)).toBe("연결됨 · 도구 2개 · 142ms");
  });
});

describe("mcpApi action wrappers (mocked)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sampleServer: McpServerConfig = {
    name: "fs",
    enabled: true,
    transport: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: [] },
  };

  it("loads list, support, and own servers together", async () => {
    vi.spyOn(mcpApi, "list").mockResolvedValueOnce([sampleServer]);
    vi.spyOn(mcpApi, "agentSupport").mockResolvedValueOnce([
      { agentId: "claude", agentName: "Claude", http: true },
    ]);
    vi.spyOn(mcpApi, "agentOwnServers").mockResolvedValueOnce([]);

    const state = await loadMcpSettings();
    expect(state.error).toBeNull();
    expect(state.servers).toEqual([sampleServer]);
    expect(state.support).toHaveLength(1);
    expect(state.ownServers).toEqual([]);
  });

  it("returns Korean error when loading fails", async () => {
    vi.spyOn(mcpApi, "list").mockRejectedValueOnce({ message: "설정 파일 읽기 실패" });
    vi.spyOn(mcpApi, "agentSupport").mockResolvedValueOnce([]);
    vi.spyOn(mcpApi, "agentOwnServers").mockResolvedValueOnce([]);

    const state = await loadMcpSettings();
    expect(state.error).toBe("MCP 설정을 불러오지 못했어요: 설정 파일 읽기 실패");
  });

  it("toggles, deletes, upserts, and imports by saving the full list", async () => {
    const saveSpy = vi.spyOn(mcpApi, "save").mockResolvedValue(undefined);

    const toggled = await toggleMcpServer([sampleServer], "fs", false);
    expect(toggled[0].enabled).toBe(false);
    expect(saveSpy).toHaveBeenLastCalledWith([{ ...sampleServer, enabled: false }]);

    const added: McpServerConfig = {
      name: "remote",
      enabled: true,
      transport: { type: "http", url: "https://mcp.example.com", headers: [] },
    };
    const afterAdd = await upsertMcpServer([sampleServer], added, null);
    expect(afterAdd).toEqual([sampleServer, added]);
    expect(saveSpy).toHaveBeenLastCalledWith([sampleServer, added]);

    const renamed: McpServerConfig = { ...added, name: "remote2" };
    const afterEdit = await upsertMcpServer(afterAdd, renamed, "remote");
    expect(afterEdit).toEqual([sampleServer, renamed]);

    const afterDelete = await deleteMcpServer(afterEdit, "fs");
    expect(afterDelete).toEqual([renamed]);
    expect(saveSpy).toHaveBeenLastCalledWith([renamed]);

    const afterImport = await appendImportedMcpServers([sampleServer], [sampleServer, added]);
    expect(afterImport).toEqual([sampleServer, added]);
    expect(saveSpy).toHaveBeenLastCalledWith([sampleServer, added]);
  });

  it("wraps mcpApi.check results and catches rejected promises", async () => {
    const checkSpy = vi.spyOn(mcpApi, "check");
    checkSpy.mockResolvedValueOnce({
      ok: true,
      tools: [{ name: "ping", description: "Ping" }],
      elapsedMs: 55,
    });
    const okRes = await checkMcpServer(sampleServer);
    expect(okRes.ok).toBe(true);
    expect(okRes.tools).toHaveLength(1);

    checkSpy.mockRejectedValueOnce({ message: "명령을 찾을 수 없어요" });
    const errRes = await checkMcpServer(sampleServer);
    expect(errRes.ok).toBe(false);
    expect(errRes.error).toBe("명령을 찾을 수 없어요");
  });
});

describe("importMcpConfig (VS Code and Codex shapes)", () => {
  it("parses VS Code `servers` with stdio, http, and sse entries", () => {
    const result = importMcpConfig({
      servers: {
        fs: {
          type: "stdio",
          command: "npx",
          args: ["-y", "fs"],
          env: { ROOT: "/work" },
        },
        docs: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer t" },
        },
        legacy: { type: "sse", url: "https://old.example.com/sse" },
      },
      inputs: [],
    });

    expect(result.error).toBeNull();
    expect(result.servers).toEqual([
      {
        name: "fs",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "fs"],
          env: [{ name: "ROOT", value: "/work" }],
        },
      },
      {
        name: "docs",
        enabled: true,
        transport: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer t" }],
        },
      },
    ]);
    expect(result.skipped).toEqual([
      { name: "legacy", reason: "sse 서버는 아직 지원하지 않아요." },
    ]);
  });

  it("maps Codex-shaped objects (env, http_headers, enabled = false)", () => {
    const result = importMcpConfig({
      mcp_servers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "t", RETRIES: 3, VERBOSE: true },
          enabled: false,
        },
        docs: {
          url: "https://d.dev/mcp",
          http_headers: { "X-Team": "core" },
        },
      },
    });

    expect(result.error).toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: "github",
        enabled: false,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: [
            { name: "GITHUB_TOKEN", value: "t" },
            { name: "RETRIES", value: "3" },
            { name: "VERBOSE", value: "true" },
          ],
        },
      },
      {
        name: "docs",
        enabled: true,
        transport: {
          type: "http",
          url: "https://d.dev/mcp",
          headers: [{ name: "X-Team", value: "core" }],
        },
      },
    ]);
  });

  it("skips Codex entries that use bearer_token_env_var", () => {
    const result = importMcpConfig({
      mcp_servers: {
        api: {
          url: "https://api.example.com/mcp",
          bearer_token_env_var: "API_TOKEN",
        },
      },
    });

    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: "api",
        reason: "bearer_token_env_var는 아직 지원하지 않아요 · 헤더로 직접 넣어 주세요",
      },
    ]);
  });

  it("keeps the wrapper-free shape and rejects non-object input", () => {
    const result = importMcpConfig({
      filesystem: { command: "npx", args: ["fs"] },
    });
    expect(result.servers.map((s) => s.name)).toEqual(["filesystem"]);

    expect(importMcpConfig("text").error).toMatch(/객체/);
    expect(importMcpConfig({ mcp_servers: [] }).error).toMatch(/mcp_servers/);
  });
});

describe("importMcpText and format detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-detects JSON when the text starts with `{`, otherwise TOML", () => {
    expect(resolveMcpImportFormat('  {"mcpServers": {}}')).toBe("json");
    expect(resolveMcpImportFormat("[mcp_servers.a]\ncommand = \"x\"")).toBe("toml");
    expect(resolveMcpImportFormat("{}", "toml")).toBe("toml");
    expect(resolveMcpImportFormat("[a]", "json")).toBe("json");
  });

  it("sends TOML through mcpApi.parseToml and then the shared importer", async () => {
    const parse = vi.spyOn(mcpApi, "parseToml").mockResolvedValueOnce({
      mcp_servers: {
        github: { command: "npx", args: ["-y", "srv"], env: { GITHUB_TOKEN: "t" } },
      },
    });

    const result = await importMcpText(
      '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "srv"]\nenv = { GITHUB_TOKEN = "t" }',
      "auto",
      ["other"],
    );

    expect(parse).toHaveBeenCalledWith(expect.stringContaining("[mcp_servers.github]"));
    expect(result.error).toBeNull();
    expect(result.servers).toEqual([
      {
        name: "github",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "srv"],
          env: [{ name: "GITHUB_TOKEN", value: "t" }],
        },
      },
    ]);
  });

  it("returns the backend parse error for invalid TOML", async () => {
    vi.spyOn(mcpApi, "parseToml").mockRejectedValueOnce(
      "올바른 TOML 형식이 아니에요: TOML parse error at line 1",
    );
    const result = await importMcpText("= broken", "toml", []);
    expect(result.servers).toEqual([]);
    expect(result.error).toBe("올바른 TOML 형식이 아니에요: TOML parse error at line 1");
  });

  it("does not call the backend for JSON, and rejects empty input", async () => {
    const parse = vi.spyOn(mcpApi, "parseToml");
    const json = await importMcpText('{"mcpServers":{"a":{"command":"x"}}}', "auto", []);
    expect(json.servers.map((s) => s.name)).toEqual(["a"]);
    expect(parse).not.toHaveBeenCalled();

    const empty = await importMcpText("   ", "auto", []);
    expect(empty.error).toBeTruthy();
    expect(parse).not.toHaveBeenCalled();
  });
});
