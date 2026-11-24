import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download, ExternalLink, LogIn, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, toHubError } from "../api";
import TeamsPanel from "./TeamsPanel";
import AboutPanel from "./AboutPanel";
import type { State } from "../store";
import { accountKey, DEFAULT_PROFILE, type AgentInfo, type AgentStatus } from "../types";

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "대기",
  starting: "시작 중",
  ready: "연결됨",
  exited: "종료됨",
  error: "오류",
};

interface Props {
  state: State;
  initialTab?: SettingsTab;
  onAgentsChanged: (agents: AgentInfo[]) => void;
  onProfilesChanged: () => void;
  onTeamsChanged: () => void;
  onClose: () => void;
}

export type SettingsTab = "accounts" | "teams" | "agents" | "about";

const SETTINGS_TABS: [SettingsTab, string][] = [
  ["accounts", "계정"],
  ["teams", "팀"],
  ["agents", "에이전트"],
  ["about", "정보"],
];

export default function SettingsModal({
  state,
  initialTab,
  onAgentsChanged,
  onProfilesChanged,
  onTeamsChanged,
  onClose,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "accounts");
  const [configPath, setConfigPath] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.agentsConfigPath().then(setConfigPath);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="설정">
        <div className="modal-head">
          <h2>설정</h2>
          <button className="icon-btn" title="닫기" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <nav className="settings-tabs" role="tablist">
          {SETTINGS_TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "accounts" &&
          state.agents
            .filter((a) => a.installed && (a.multiAccount || a.canLogin))
            .map((a) => <AgentAccounts key={a.id} agent={a} state={state} onChanged={onProfilesChanged} />)}

        {tab === "teams" && <TeamsPanel state={state} onChanged={onTeamsChanged} />}

        {tab === "about" && <AboutPanel />}

        {tab === "agents" && (
          <>
            <AgentInstall agents={state.agents} onAgentsChanged={onAgentsChanged} />

            <h3>실행 상태</h3>
            <ul className="settings-agents">
              {state.agents.filter((a) => a.installed).map((a) => {
                const st = state.status[a.id]?.status ?? (a.running ? "ready" : "idle");
                return (
                  <li key={a.id}>
                    <span className={`dot dot-${st}`} />
                    <div className="grow">
                      <div>{a.name}</div>
                      <div className="muted small">
                        {STATUS_LABEL[st]}
                        {state.status[a.id]?.message ? ` · ${state.status[a.id]?.message}` : ""}
                      </div>
                    </div>
                    {st === "ready" && (
                      <button className="btn" onClick={() => api.stopAgent(a.id)}>
                        중지
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            <h3>에이전트 설정 파일</h3>
            <p className="muted small">실행 명령, 인자, 환경 변수, 세션 기본값을 바꿀 수 있어요. 수정 후 앱을 다시 시작하세요.</p>
            <div className="path-row">
              <code className="ellipsis">{configPath}</code>
              <button
                className="icon-btn"
                title="경로 복사"
                onClick={() =>
                  navigator.clipboard.writeText(configPath).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  })
                }
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const NODE_PROGRAMS = ["node", "npm", "npx"];

/** Which agents are on this computer, with a way to install the others. */
function AgentInstall({ agents, onAgentsChanged }: { agents: AgentInfo[]; onAgentsChanged: (a: AgentInfo[]) => void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recheck = () => {
    setChecking(true);
    setError(null);
    api
      .refreshAgents()
      .then(onAgentsChanged)
      .catch((e) => setError(toHubError(e).message))
      .finally(() => setChecking(false));
  };
  const install = (a: AgentInfo) => {
    setError(null);
    api.installAgent(a.id).catch((e) => setError(toHubError(e).message));
  };

  return (
    <>
      <div className="settings-head">
        <h3>에이전트</h3>
        <button className="btn small-btn" disabled={checking} onClick={recheck} title="설치한 뒤 눌러 주세요">
          <RefreshCw size={13} /> {checking ? "확인 중…" : "다시 확인"}
        </button>
      </div>
      <ul className="settings-agents">
        {agents.map((a) => {
          const missing = a.install?.missing ?? [];
          const needsNode = missing.some((m) => NODE_PROGRAMS.includes(m));
          return (
            <li key={a.id}>
              <span className={`dot ${a.installed ? "dot-ready" : "dot-idle"}`} />
              <div className="grow">
                <div>{a.name}</div>
                <div className="muted small">
                  {a.installed
                    ? "설치됨"
                    : needsNode
                      ? "Node.js가 먼저 필요해요"
                      : missing.length
                        ? `먼저 필요한 프로그램: ${missing.join(", ")}`
                        : (a.install?.note || "설치되어 있지 않아요")}
                </div>
                {!a.installed && a.install?.command && !missing.length && (
                  <code className="install-cmd">{a.install.command}</code>
                )}
              </div>
              {!a.installed && a.install && (
                <div className="install-actions">
                  {needsNode ? (
                    <button className="btn small-btn" onClick={() => openUrl("https://nodejs.org/en/download")}>
                      <ExternalLink size={13} /> Node.js 받기
                    </button>
                  ) : a.install.command && !missing.length ? (
                    <button className="btn btn-primary small-btn" onClick={() => install(a)} title="터미널에서 이 명령을 실행해요">
                      <Download size={13} /> 설치
                    </button>
                  ) : null}
                  <button className="icon-btn" title="설치 안내 페이지" onClick={() => openUrl(a.install!.url)}>
                    <ExternalLink size={15} />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        설치는 터미널에서 공식 설치 명령으로 진행돼요. 끝나면 <b>다시 확인</b>을 눌러 주세요.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </>
  );
}

/** One agent's accounts: the default login plus any added profiles. */
function AgentAccounts({ agent, state, onChanged }: { agent: AgentInfo; state: State; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows = [
    { id: DEFAULT_PROFILE, name: "기본" },
    ...state.profiles.filter((p) => p.agentId === agent.id),
  ];

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(toHubError(e).message);
    }
  };

  const submit = () =>
    run(async () => {
      if (editing) await api.renameProfile(editing, name);
      else {
        const created = await api.createProfile(agent.id, name);
        // A new account is useless until logged in, so start that right away.
        await api.loginProfile(agent.id, created.id);
      }
      setAdding(false);
      setEditing(null);
      setName("");
      onChanged();
    });

  const remove = (id: string, label: string) =>
    run(async () => {
      const ok = await ask(`'${label}' 계정을 삭제할까요? 이 계정의 로그인 정보도 지워져요.`, {
        title: "계정 삭제",
        kind: "warning",
      });
      if (!ok) return;
      await api.deleteProfile(agent.id, id);
      onChanged();
    });

  return (
    <div className="accounts">
      <div className="accounts-head">
        <b>{agent.name}</b>
        {!agent.multiAccount ? (
          <span className="muted small" title="이 에이전트는 로그인 정보를 한곳에만 저장해서 계정을 나눌 수 없어요">
            계정 하나만 쓸 수 있어요
          </span>
        ) : (
          !adding &&
          !editing && (
            <button className="btn small-btn" onClick={() => setAdding(true)}>
              <Plus size={14} /> 계정 추가
            </button>
          )
        )}
      </div>
      <ul className="account-list">
        {rows.map((r) => {
          const identity = state.identities[accountKey(agent.id, r.id)];
          return (
            <li key={r.id}>
              {editing === r.id ? (
                <NameInput value={name} onChange={setName} onSubmit={submit} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <div className="grow">
                    <div>{r.name}</div>
                    <div className="muted small">
                      {identity?.account?.email
                        ? `${identity.account.email}${identity.label ? ` · ${identity.label}` : ""}`
                        : identity?.label
                          ? `로그인됨 · ${identity.label}`
                          : identity?.kind === "none"
                          ? "로그인 안 됨"
                          : r.id === DEFAULT_PROFILE
                            ? "기존 로그인 사용"
                            : "로그인 상태는 이 계정으로 대화하면 표시돼요"}
                    </div>
                  </div>
                  {agent.canLogin && (
                    <button className="icon-btn" title="로그인" onClick={() => run(() => api.loginProfile(agent.id, r.id))}>
                      <LogIn size={15} />
                    </button>
                  )}
                  {r.id !== DEFAULT_PROFILE && (
                    <>
                      <button
                        className="icon-btn"
                        title="이름 변경"
                        onClick={() => {
                          setAdding(false);
                          setEditing(r.id);
                          setName(r.name);
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button className="icon-btn" title="삭제" onClick={() => remove(r.id, r.name)}>
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          );
        })}
        {adding && (
          <li>
            <NameInput
              value={name}
              placeholder="계정 이름 (예: 회사)"
              onChange={setName}
              onSubmit={submit}
              onCancel={() => {
                setAdding(false);
                setName("");
              }}
            />
          </li>
        )}
      </ul>
      {agent.loginNote && <p className="muted small">로그인: {agent.loginNote}</p>}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

function NameInput(p: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="name-input"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
    >
      <input
        autoFocus
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), p.onCancel())}
      />
      <button type="submit" className="btn btn-primary small-btn" disabled={!p.value.trim()}>
        저장
      </button>
      <button type="button" className="btn small-btn" onClick={p.onCancel}>
        취소
      </button>
    </form>
  );
}
