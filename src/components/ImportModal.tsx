import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, toHubError, type AgentSessionInfo, type ImportResult } from "../api";
import type { State } from "../store";
import { AUTO_TEAM, DEFAULT_PROFILE, sessionKey } from "../types";
import { baseName } from "./Sidebar";

export interface Imported {
  info: AgentSessionInfo;
  title: string;
  updatedAt: number;
  result: ImportResult;
  teamId: string | null;
}

interface Props {
  state: State;
  cwd: string;
  defaultTeam: string;
  onImported: (items: Imported[]) => void;
  onClose: () => void;
}

function titleOf(s: AgentSessionInfo, agentName: string) {
  return s.title?.trim() || `${agentName} 대화 · ${s.sessionId.slice(0, 6)}`;
}

function ago(iso?: string | null) {
  if (!iso) return "";
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (Number.isNaN(min)) return "";
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 1440)}일 전`;
}

/** Pick saved agent sessions for a folder and bring them in as chats or leads. */
export default function ImportModal({ state, cwd, defaultTeam, onImported, onClose }: Props) {
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lead, setLead] = useState(false);
  const [team, setTeam] = useState(defaultTeam || AUTO_TEAM);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const known = new Set(state.sessions.map((s) => s.key));
    api
      .listAgentSessions(cwd)
      .then((list) =>
        setSessions(
          list
            .filter((s) => !known.has(sessionKey(s.agentId, s.sessionId)))
            .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0),
        ),
      )
      .catch((e) => setError(toHubError(e).message));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cwd]);

  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const accountName = (id: string) => (id === DEFAULT_PROFILE ? null : state.profiles.find((p) => p.id === id)?.name);
  const keyOf = (s: AgentSessionInfo) => `${s.agentId}/${s.profileId}/${s.sessionId}`;

  const run = async () => {
    if (!sessions) return;
    setError(null);
    const chosen = sessions.filter((s) => picked.has(keyOf(s)));
    const done: Imported[] = [];
    for (const s of chosen) {
      const title = titleOf(s, agentName(s.agentId));
      setBusy(title);
      try {
        const launch = { profile: s.profileId };
        const result = await api.importSession(s.agentId, s.sessionId, cwd, launch, lead ? team : null);
        done.push({ info: s, title, updatedAt: Date.parse(s.updatedAt ?? "") || Date.now(), result, teamId: lead ? team : null });
      } catch (e) {
        setError(`'${title}' 가져오기 실패: ${toHubError(e).message}`);
        break;
      }
    }
    setBusy(null);
    if (done.length) onImported(done);
    if (done.length === chosen.length) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-label="이전 대화 가져오기">
        <div className="modal-head">
          <h2>이전 대화 가져오기 · {baseName(cwd)}</h2>
          <button className="icon-btn" title="닫기" onClick={onClose} disabled={!!busy}>
            <X size={17} />
          </button>
        </div>
        <p className="muted small">
          에이전트가 이 폴더에 저장해 둔 대화예요. 터미널이나 다른 앱의 Claude Code에서 한 대화도 포함돼요. 같은 대화를 두
          앱에서 동시에 이어 가면 기록이 꼬일 수 있으니, 한쪽에서 끝낸 대화를 가져오세요.
        </p>

        {sessions === null && !error && <p className="muted small">대화 목록을 불러오는 중…</p>}
        {sessions?.length === 0 && <p className="muted small">가져올 대화가 없어요.</p>}
        {sessions && sessions.length > 0 && (
          <ul className="import-list">
            {sessions.map((s) => {
              const k = keyOf(s);
              const account = accountName(s.profileId);
              return (
                <li key={k}>
                  <label>
                    <input
                      id={`import-${k}`}
                      type="checkbox"
                      checked={picked.has(k)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const next = new Set(p);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                    <span className="import-agent">
                      {agentName(s.agentId)}
                      {account && ` · ${account}`}
                    </span>
                    <span className="grow ellipsis">{titleOf(s, agentName(s.agentId))}</span>
                    <span className="muted small">{ago(s.updatedAt)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="import-mode">
          <span className="muted small">가져올 방식</span>
          <div className="mode-switch inline" role="group" aria-label="가져올 방식">
            <button aria-pressed={!lead} onClick={() => setLead(false)}>
              채팅
            </button>
            <button aria-pressed={lead} className="agent" onClick={() => setLead(true)}>
              에이전트
            </button>
          </div>
          {lead && (
            <select id="import-team" aria-label="팀" value={team} onChange={(e) => setTeam(e.target.value)}>
              {state.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  팀: {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && <p className="error-text small">{error}</p>}
        <div className="editor-actions">
          <button className="btn" onClick={onClose} disabled={!!busy}>
            취소
          </button>
          <button className="btn btn-primary" disabled={!picked.size || !!busy} onClick={run}>
            {busy ? `가져오는 중… ${busy}` : `${picked.size}개 가져오기`}
          </button>
        </div>
      </div>
    </div>
  );
}
