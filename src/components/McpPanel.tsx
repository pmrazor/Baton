import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileJson,
  Pencil,
  Plug,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toHubError } from "../api";
import type {
  McpAgentOwnServer,
  McpAgentSupport,
  McpCheckResult,
  McpEnvVar,
  McpServerConfig,
} from "../mcp/api";
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
  importMcpText,
  loadMcpSettings,
  resolveMcpImportFormat,
  serverSummary,
  toggleMcpServer,
  upsertMcpServer,
  validateServer,
  type ImportMcpResult,
  type McpImportFormat,
  type McpServerDraft,
  type ValidationErrors,
} from "../mcp/helpers";

type ViewMode =
  | { kind: "list" }
  | { kind: "form"; editingName: string | null; initial: McpServerDraft }
  | { kind: "import" };

/** Settings -> MCP tab: manage shared MCP servers, check connections, and view agent support/own configs. */
export default function McpPanel() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [support, setSupport] = useState<McpAgentSupport[]>([]);
  const [ownServers, setOwnServers] = useState<McpAgentOwnServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [checkingNames, setCheckingNames] = useState<Record<string, boolean>>({});
  const [checkResults, setCheckResults] = useState<Record<string, McpCheckResult>>({});
  const [view, setView] = useState<ViewMode>({ kind: "list" });

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const data = await loadMcpSettings();
    setServers(data.servers);
    setSupport(data.support);
    setOwnServers(data.ownServers);
    setLoadError(data.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ownGroups = useMemo(
    () => groupOwnServersByAgent(ownServers, support),
    [ownServers, support],
  );

  const handleToggle = async (name: string, enabled: boolean) => {
    setActionError(null);
    setSaving(true);
    try {
      const next = await toggleMcpServer(servers, name, enabled);
      setServers(next);
    } catch (err) {
      setActionError(`MCP 설정을 저장하지 못했어요: ${toHubError(err).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setActionError(null);
    setSaving(true);
    try {
      const next = await deleteMcpServer(servers, name);
      setServers(next);
      setCheckResults((prev) => {
        if (!(name in prev)) return prev;
        const copy = { ...prev };
        delete copy[name];
        return copy;
      });
    } catch (err) {
      setActionError(`MCP 서버를 삭제하지 못했어요: ${toHubError(err).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCheck = async (server: McpServerConfig) => {
    setCheckingNames((prev) => ({ ...prev, [server.name]: true }));
    const res = await checkMcpServer(server);
    setCheckResults((prev) => ({ ...prev, [server.name]: res }));
    setCheckingNames((prev) => {
      const next = { ...prev };
      delete next[server.name];
      return next;
    });
  };

  if (view.kind === "form") {
    const existingNames = servers
      .map((s) => s.name)
      .filter((n) => n !== view.editingName);
    return (
      <McpServerForm
        editingName={view.editingName}
        initial={view.initial}
        existingNames={existingNames}
        saving={saving}
        error={actionError}
        onCancel={() => {
          setActionError(null);
          setView({ kind: "list" });
        }}
        onSave={async (server) => {
          setActionError(null);
          setSaving(true);
          try {
            const next = await upsertMcpServer(servers, server, view.editingName);
            setServers(next);
            if (view.editingName && view.editingName !== server.name) {
              setCheckResults((prev) => {
                const copy = { ...prev };
                delete copy[view.editingName!];
                return copy;
              });
            }
            setView({ kind: "list" });
          } catch (err) {
            setActionError(`MCP 서버를 저장하지 못했어요: ${toHubError(err).message}`);
          } finally {
            setSaving(false);
          }
        }}
      />
    );
  }

  if (view.kind === "import") {
    return (
      <McpJsonImporter
        existingNames={servers.map((s) => s.name)}
        saving={saving}
        error={actionError}
        onCancel={() => {
          setActionError(null);
          setView({ kind: "list" });
        }}
        onConfirm={async (imported) => {
          setActionError(null);
          setSaving(true);
          try {
            const next = await appendImportedMcpServers(servers, imported);
            setServers(next);
            setView({ kind: "list" });
          } catch (err) {
            setActionError(`MCP 서버를 가져오지 못했어요: ${toHubError(err).message}`);
          } finally {
            setSaving(false);
          }
        }}
      />
    );
  }

  return (
    <div className="mcp-panel">
      <div className="settings-head">
        <h3>공통 MCP 서버</h3>
        <div className="install-actions">
          <button
            type="button"
            className="btn small-btn"
            disabled={saving}
            onClick={() => {
              setActionError(null);
              setView({ kind: "import" });
            }}
          >
            <FileJson size={13} /> JSON·TOML로 가져오기
          </button>
          <button
            type="button"
            className="btn btn-primary small-btn"
            disabled={saving}
            onClick={() => {
              setActionError(null);
              setView({ kind: "form", editingName: null, initial: emptyDraft() });
            }}
          >
            <Plus size={13} /> 추가
          </button>
        </div>
      </div>

      <p className="muted small mcp-intro">
        여기 등록한 서버는 Baton이 시작하는 모든 에이전트 대화에 붙어요. 새로 시작하거나 다시 연결한
        대화부터 적용돼요.
      </p>

      {loadError && <p className="error-text small">{loadError}</p>}
      {actionError && <p className="error-text small">{actionError}</p>}

      {loading ? (
        <p className="muted small">MCP 설정을 불러오는 중이에요…</p>
      ) : servers.length === 0 ? (
        <p className="muted small">등록된 공통 MCP 서버가 없어요.</p>
      ) : (
        <ul className="settings-agents mcp-list">
          {servers.map((server) => {
            const summary = serverSummary(server);
            const checking = !!checkingNames[server.name];
            const checkResult = checkResults[server.name];
            const conflictAgents = findOwnServerConflictAgents(server.name, ownServers, support);
            const conflictText = formatConflictWarning(conflictAgents);

            return (
              <li
                key={server.name}
                className={server.enabled ? "mcp-item" : "mcp-item mcp-disabled"}
              >
                <div className="mcp-row-main">
                  <div className="grow">
                    <div className="mcp-title-row">
                      <span className="mcp-name">{server.name}</span>
                      <span className="pill mcp-type-badge">{server.transport.type}</span>
                    </div>
                    <div className="muted small ellipsis mcp-summary" title={summary}>
                      {summary}
                    </div>
                    {conflictText && (
                      <div className="mcp-warn-badge small">
                        <AlertTriangle size={12} />
                        <span>{conflictText}</span>
                      </div>
                    )}
                  </div>
                  <div className="install-actions">
                    <label className="ext-toggle small">
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        disabled={saving}
                        onChange={(e) => void handleToggle(server.name, e.target.checked)}
                      />
                      <span>{server.enabled ? "사용" : "사용 안 함"}</span>
                    </label>
                    <button
                      type="button"
                      className="btn small-btn"
                      disabled={checking}
                      onClick={() => void handleCheck(server)}
                    >
                      {checking ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> 확인 중…
                        </>
                      ) : (
                        <>
                          <Plug size={13} /> 연결 확인
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="편집"
                      aria-label={`${server.name} 편집`}
                      disabled={saving}
                      onClick={() => {
                        setActionError(null);
                        setView({
                          kind: "form",
                          editingName: server.name,
                          initial: draftFromServer(server),
                        });
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn mcp-delete-btn"
                      title="삭제"
                      aria-label={`${server.name} 삭제`}
                      disabled={saving}
                      onClick={() => void handleDelete(server.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {checkResult && <McpCheckBanner result={checkResult} />}
              </li>
            );
          })}
        </ul>
      )}

      <h3>에이전트 지원</h3>
      <p className="muted small mcp-section-note">
        stdio 서버는 모든 에이전트가 지원해요. http 서버는 지원하지 않는 에이전트에서는 빠져요.
      </p>
      {support.length === 0 ? (
        !loading && <p className="muted small">설치된 에이전트 정보가 없어요.</p>
      ) : (
        <ul className="settings-agents mcp-support-list">
          {support.map((a) => (
            <li key={a.agentId}>
              <div className="grow">{a.agentName}</div>
              <div className="mcp-support-badges small">
                <span className="mcp-support-cell">
                  <span className="muted">stdio</span>
                  <span className="mcp-ok" aria-label="지원">
                    ✓
                  </span>
                </span>
                <span className="mcp-support-cell">
                  <span className="muted">http</span>
                  {a.http === true ? (
                    <span className="mcp-ok" aria-label="지원">
                      ✓
                    </span>
                  ) : a.http === false ? (
                    <span className="error-text" aria-label="미지원">
                      ✗
                    </span>
                  ) : (
                    <span className="muted">아직 모름 (한 번 실행되면 알 수 있어요)</span>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>에이전트 자체 설정</h3>
      <p className="muted small mcp-section-note">
        각 에이전트가 자체 설정 파일에 두고 있는 서버예요. 원래대로 그 에이전트에서만 작동해요.
      </p>
      {ownGroups.length === 0 ? (
        !loading && <p className="muted small">감지된 에이전트 자체 MCP 설정이 없어요.</p>
      ) : (
        <div className="mcp-own-groups">
          {ownGroups.map((group) => (
            <div key={group.agentId} className="mcp-own-group">
              <div className="mcp-own-head">
                <b>{group.agentName}</b>
                <span className="muted small mcp-own-sources">
                  {group.sources.map((src) => (
                    <code key={src}>{src}</code>
                  ))}
                </span>
              </div>
              <ul className="settings-agents mcp-own-list">
                {group.servers.map((srv) => (
                  <li key={`${srv.source}:${srv.name}`}>
                    <div className="grow">
                      <div className="mcp-title-row">
                        <span className="mcp-name">{srv.name}</span>
                        <span className="pill subtle mcp-type-badge">{srv.kind}</span>
                      </div>
                      {srv.summary && (
                        <div className="muted small ellipsis mcp-summary" title={srv.summary}>
                          {srv.summary}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpCheckBanner({ result }: { result: McpCheckResult }) {
  const [expanded, setExpanded] = useState(false);

  if (!result.ok) {
    return (
      <div className="mcp-check-result">
        <p className="error-text small">{result.error || "연결을 확인하지 못했어요."}</p>
      </div>
    );
  }

  return (
    <div className="mcp-check-result">
      <div className="mcp-check-ok small">
        <Check size={13} className="mcp-ok" />
        <span>{formatCheckSummary(result)}</span>
        {result.tools.length > 0 && (
          <button
            type="button"
            className="link-btn mcp-tools-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            도구 목록 {expanded ? "접기" : "보기"}
          </button>
        )}
      </div>
      {expanded && result.tools.length > 0 && (
        <ul className="mcp-tools-list">
          {result.tools.map((tool) => (
            <li key={tool.name}>
              <code className="mcp-tool-name">{tool.name}</code>
              {tool.description && (
                <span className="muted small mcp-tool-desc">{tool.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface McpServerFormProps {
  editingName: string | null;
  initial: McpServerDraft;
  existingNames: string[];
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (server: McpServerConfig) => Promise<void>;
}

function McpServerForm({
  editingName,
  initial,
  existingNames,
  saving,
  error,
  onCancel,
  onSave,
}: McpServerFormProps) {
  const [draft, setDraft] = useState<McpServerDraft>(initial);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<McpCheckResult | null>(null);

  const validate = () => {
    const nextErrors = validateServer(draft, existingNames);
    setErrors(nextErrors);
    return !hasValidationErrors(nextErrors);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    await onSave(draftToServer(draft));
  };

  const handleDraftCheck = async () => {
    if (!validate()) return;
    setChecking(true);
    setCheckResult(null);
    const res = await checkMcpServer(draftToServer(draft));
    setCheckResult(res);
    setChecking(false);
  };

  return (
    <form
      className="mcp-form"
      onSubmit={(e) => void handleSubmit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <button type="button" className="link-btn" onClick={onCancel}>
        <ArrowLeft size={14} /> MCP 서버 목록
      </button>

      <h3>{editingName === null ? "MCP 서버 추가" : "MCP 서버 편집"}</h3>

      <div className="mcp-form-grid">
        <label className="field grow">
          <span>이름</span>
          <input
            autoFocus
            value={draft.name}
            placeholder="예: filesystem"
            onChange={(e) => {
              setDraft((d) => ({ ...d, name: e.target.value }));
              setErrors((prev) => ({ ...prev, name: undefined }));
            }}
          />
          {errors.name && <span className="error-text small">{errors.name}</span>}
        </label>

        <label className="field mcp-type-field">
          <span>전송 방식</span>
          <select
            value={draft.type}
            onChange={(e) => {
              const type = e.target.value === "http" ? "http" : "stdio";
              setDraft((d) => ({ ...d, type }));
              setErrors({});
              setCheckResult(null);
            }}
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </label>
      </div>

      {draft.type === "stdio" ? (
        <>
          <label className="field mcp-field">
            <span>명령</span>
            <input
              value={draft.command}
              placeholder="예: npx"
              onChange={(e) => {
                setDraft((d) => ({ ...d, command: e.target.value }));
                setErrors((prev) => ({ ...prev, command: undefined }));
              }}
            />
            {errors.command && <span className="error-text small">{errors.command}</span>}
          </label>

          <label className="field mcp-field">
            <span>인자 (한 줄에 하나씩)</span>
            <textarea
              rows={3}
              value={draft.argsText}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
              onChange={(e) => setDraft((d) => ({ ...d, argsText: e.target.value }))}
            />
          </label>

          <KeyValueEditor
            label="환경 변수"
            addLabel="환경 변수 추가"
            namePlaceholder="변수 이름"
            rows={draft.env}
            error={errors.env}
            onChange={(env) => {
              setDraft((d) => ({ ...d, env }));
              setErrors((prev) => ({ ...prev, env: undefined }));
            }}
          />
        </>
      ) : (
        <>
          <label className="field mcp-field">
            <span>URL</span>
            <input
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(e) => {
                setDraft((d) => ({ ...d, url: e.target.value }));
                setErrors((prev) => ({ ...prev, url: undefined }));
              }}
            />
            <span className="muted small">
              https:// 주소를 입력해 주세요. localhost는 http://도 사용할 수 있어요.
            </span>
            {errors.url && <span className="error-text small">{errors.url}</span>}
          </label>

          <KeyValueEditor
            label="헤더"
            addLabel="헤더 추가"
            namePlaceholder="헤더 이름 (예: Authorization)"
            rows={draft.headers}
            error={errors.headers}
            onChange={(headers) => {
              setDraft((d) => ({ ...d, headers }));
              setErrors((prev) => ({ ...prev, headers: undefined }));
            }}
          />
        </>
      )}

      <label className="ext-toggle small mcp-enabled-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
        />
        <span>이 서버 사용</span>
      </label>

      {checkResult && <McpCheckBanner result={checkResult} />}
      {error && <p className="error-text small">{error}</p>}

      <div className="editor-actions mcp-form-actions">
        <button
          type="button"
          className="btn small-btn mcp-check-draft-btn"
          disabled={checking || saving}
          onClick={() => void handleDraftCheck()}
        >
          {checking ? (
            <>
              <span className="spinner" aria-hidden="true" /> 확인 중…
            </>
          ) : (
            <>
              <Plug size={13} /> 저장 전 연결 확인
            </>
          )}
        </button>
        <button type="button" className="btn small-btn" disabled={saving} onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="btn btn-primary small-btn" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}

interface KeyValueEditorProps {
  label: string;
  addLabel: string;
  namePlaceholder: string;
  rows: McpEnvVar[];
  error?: string;
  onChange: (rows: McpEnvVar[]) => void;
}

function KeyValueEditor({
  label,
  addLabel,
  namePlaceholder,
  rows,
  error,
  onChange,
}: KeyValueEditorProps) {
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  const updateRow = (index: number, patch: Partial<McpEnvVar>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
    setRevealed((prev) => {
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k);
        if (idx < index) next[idx] = v;
        else if (idx > index) next[idx - 1] = v;
      }
      return next;
    });
  };

  return (
    <div className="mcp-kv-section">
      <div className="settings-head">
        <span className="section-label">{label}</span>
        <button
          type="button"
          className="btn small-btn"
          onClick={() => onChange([...rows, { name: "", value: "" }])}
        >
          <Plus size={12} /> {addLabel}
        </button>
      </div>
      {rows.length > 0 && (
        <div className="mcp-kv-rows">
          {rows.map((row, idx) => {
            const shown = !!revealed[idx];
            return (
              <div key={idx} className="mcp-kv-row">
                <input
                  value={row.name}
                  placeholder={namePlaceholder}
                  aria-label={`${label} 이름 ${idx + 1}`}
                  onChange={(e) => updateRow(idx, { name: e.target.value })}
                />
                <div className="mcp-secret-wrap">
                  <input
                    type={shown ? "text" : "password"}
                    value={row.value}
                    placeholder="값"
                    aria-label={`${label} 값 ${idx + 1}`}
                    onChange={(e) => updateRow(idx, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-btn sm"
                    title={shown ? "값 숨기기" : "값 보기"}
                    aria-label={shown ? "값 숨기기" : "값 보기"}
                    onClick={() => setRevealed((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                  >
                    {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="삭제"
                  aria-label={`${label} ${idx + 1} 삭제`}
                  onClick={() => removeRow(idx)}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

interface McpJsonImporterProps {
  existingNames: string[];
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (servers: McpServerConfig[]) => Promise<void>;
}

const JSON_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}`;

const TOML_EXAMPLE = `[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "…" }`;

const IMPORT_FORMATS: { value: McpImportFormat; label: string }[] = [
  { value: "auto", label: "자동" },
  { value: "json", label: "JSON" },
  { value: "toml", label: "TOML" },
];

function McpJsonImporter({
  existingNames,
  saving,
  error,
  onCancel,
  onConfirm,
}: McpJsonImporterProps) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<McpImportFormat>("auto");
  const [preview, setPreview] = useState<ImportMcpResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const resolvedFormat = resolveMcpImportFormat(text, format);

  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    // Drop results from earlier input so a slow TOML parse cannot overwrite newer text.
    let cancelled = false;
    setPreviewing(true);
    void importMcpText(text, format, existingNames).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setPreviewing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [text, format, existingNames]);

  return (
    <div
      className="mcp-import"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <button type="button" className="link-btn" onClick={onCancel}>
        <ArrowLeft size={14} /> MCP 서버 목록
      </button>

      <h3>JSON·TOML로 가져오기</h3>
      <p className="muted small mcp-intro">
        Claude·Cursor 형식의 JSON, VS Code의 <code>servers</code> JSON, Codex의 TOML(
        <code>[mcp_servers.이름]</code>)을 붙여 넣어 주세요. 형식은 자동으로 알아봐요.
      </p>

      <div className="field mcp-field">
        <div className="segmented mcp-format-switch" role="group" aria-label="입력 형식">
          {IMPORT_FORMATS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={format === opt.value ? "active" : ""}
              aria-pressed={format === opt.value}
              onClick={() => setFormat(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field mcp-field">
        <span>MCP 설정 ({resolvedFormat.toUpperCase()})</span>
        <textarea
          autoFocus
          rows={8}
          className="mcp-json-input"
          value={text}
          placeholder={resolvedFormat === "toml" ? TOML_EXAMPLE : JSON_EXAMPLE}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <details className="muted small mcp-import-help">
        <summary>입력 예시 보기</summary>
        <div className="section-label">JSON</div>
        <pre className="code">{JSON_EXAMPLE}</pre>
        <div className="section-label">TOML (Codex config.toml)</div>
        <pre className="code">{TOML_EXAMPLE}</pre>
      </details>

      {text.trim() && (
        <div className="mcp-import-preview">
          {previewing && !preview ? (
            <p className="muted small">확인하는 중이에요…</p>
          ) : preview?.error ? (
            <p className="error-text small">{preview.error}</p>
          ) : preview ? (
            <>
              {preview.servers.length > 0 && (
                <>
                  <div className="section-label">추가할 서버 ({preview.servers.length}개)</div>
                  <ul className="settings-agents mcp-preview-list">
                    {preview.servers.map((srv) => (
                      <li key={srv.name}>
                        <div className="grow">
                          <div className="mcp-title-row">
                            <span className="mcp-name">{srv.name}</span>
                            <span className="pill mcp-type-badge">{srv.transport.type}</span>
                          </div>
                          <div className="muted small ellipsis mcp-summary">
                            {serverSummary(srv)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {preview.skipped.length > 0 && (
                <>
                  <div className="section-label mcp-skipped-label">
                    건너뛴 항목 ({preview.skipped.length}개)
                  </div>
                  <ul className="settings-agents mcp-skipped-list">
                    {preview.skipped.map((item, idx) => (
                      <li key={`${item.name}-${idx}`}>
                        <div className="grow">
                          <span className="mcp-name">{item.name}</span>
                          <div className="muted small">{item.reason}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {preview.servers.length === 0 && preview.skipped.length === 0 && (
                <p className="muted small">가져올 서버가 없어요.</p>
              )}
            </>
          ) : null}
        </div>
      )}

      {error && <p className="error-text small">{error}</p>}

      <div className="editor-actions">
        <button type="button" className="btn small-btn" disabled={saving} onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary small-btn"
          disabled={saving || previewing || !preview || preview.servers.length === 0}
          onClick={() => {
            if (preview && preview.servers.length > 0) {
              void onConfirm(preview.servers);
            }
          }}
        >
          {saving
            ? "가져오는 중…"
            : preview && preview.servers.length > 0
              ? `${preview.servers.length}개 추가`
              : "가져오기"}
        </button>
      </div>
    </div>
  );
}
