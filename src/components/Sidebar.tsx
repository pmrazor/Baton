import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Lock,
  PanelLeft,
  PanelLeftOpen,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import type { AgentInfo, PermissionRequest, Session } from "../types";
import { sessionKey } from "../types";

interface Props {
  agents: AgentInfo[];
  workspaces: string[];
  workspace: string | null;
  sessions: Session[];
  activeKey: string | null;
  permissions: PermissionRequest[];
  onNewChat: (workspace?: string) => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onRemoveWorkspace: (path: string) => void;
  onActivate: (key: string) => void;
  onCloseSession: (key: string) => void;
  /** Icon-only rail instead of the full sidebar. */
  rail: boolean;
  onToggleRail: () => void;
  onOpenSettings: () => void;
}

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

function relativeTime(ts: number) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간`;
  return `${Math.floor(min / 1440)}일`;
}

export default function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const waiting = new Set(p.permissions.map((r) => sessionKey(r.agentId, r.sessionId)));

  if (p.rail) return <Rail {...p} waiting={waiting} />;

  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark" aria-hidden />
          Baton
        </div>
        <button className="icon-btn" title="사이드바 접기" onClick={p.onToggleRail}>
          <PanelLeft size={17} />
        </button>
      </div>

      <button className="new-chat" onClick={() => p.onNewChat()}>
        <SquarePen size={16} />
        새 대화
      </button>

      <div className="section-head">
        <span>워크스페이스</span>
        <button className="icon-btn" title="폴더 추가" onClick={p.onAddWorkspace}>
          <FolderPlus size={16} />
        </button>
      </div>

      <nav className="workspace-tree">
        {p.workspaces.length === 0 && (
          <button className="empty-hint" onClick={p.onAddWorkspace}>
            작업할 폴더를 추가하세요
          </button>
        )}
        {p.workspaces.map((ws) => {
          const sessions = p.sessions
            .filter((s) => s.cwd === ws && !s.draft)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const isOpen = !collapsed[ws];
          const selected = ws === p.workspace;
          return (
            <div key={ws} className="workspace">
              <div className={`workspace-row ${selected ? "selected" : ""}`} title={ws}>
                <button
                  className="workspace-name"
                  onClick={() => {
                    p.onSelectWorkspace(ws);
                    if (selected) setCollapsed((c) => ({ ...c, [ws]: !c[ws] }));
                  }}
                >
                  {isOpen ? <FolderOpen size={16} className="folder" /> : <Folder size={16} className="folder" />}
                  <span className="ellipsis">{baseName(ws)}</span>
                  {sessions.length > 0 &&
                    (isOpen ? <ChevronDown size={13} className="chev" /> : <ChevronRight size={13} className="chev" />)}
                </button>
                <span className="row-actions">
                  <button className="icon-btn sm" title="이 폴더에서 새 대화" onClick={() => p.onNewChat(ws)}>
                    <SquarePen size={14} />
                  </button>
                  <button className="icon-btn sm" title="목록에서 제거" onClick={() => p.onRemoveWorkspace(ws)}>
                    <X size={14} />
                  </button>
                </span>
              </div>

              {isOpen &&
                sessions.map((s) => (
                  <div key={s.key} className={`session-row ${s.key === p.activeKey ? "active" : ""}`}>
                    <button className="session-main" onClick={() => p.onActivate(s.key)}>
                      <span className="ellipsis">{s.title}</span>
                      <span className="session-meta">
                        {waiting.has(s.key) ? (
                          <Lock size={12} className="waiting" aria-label="권한 요청 대기" />
                        ) : s.busy ? (
                          <span className="spinner" aria-label="응답 중" />
                        ) : (
                          <span className="time">{relativeTime(s.updatedAt)}</span>
                        )}
                      </span>
                    </button>
                    <button className="icon-btn sm close" title="대화 삭제" onClick={() => p.onCloseSession(s.key)}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </nav>

      <button className="sidebar-foot" onClick={p.onOpenSettings}>
        <Settings size={16} />
        설정
      </button>
    </aside>
  );
}

function Rail(p: Props & { waiting: Set<string> }) {
  const openWorkspace = (ws: string) => {
    p.onSelectWorkspace(ws);
    const current = p.sessions.find((s) => s.key === p.activeKey);
    if (current?.cwd === ws) return;
    const latest = p.sessions
      .filter((s) => s.cwd === ws && !s.draft)
      .reduce<Session | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
    if (latest) p.onActivate(latest.key);
    else p.onNewChat(ws);
  };

  return (
    <aside className="sidebar rail">
      <div className="rail-top" data-tauri-drag-region>
        <button className="icon-btn" title="사이드바 펼치기" onClick={p.onToggleRail}>
          <PanelLeftOpen size={18} />
        </button>
      </div>
      <button className="icon-btn rail-btn" title="새 대화" onClick={() => p.onNewChat()}>
        <SquarePen size={18} />
      </button>

      <div className="rail-divider" />

      <nav className="rail-workspaces">
        {p.workspaces.map((ws) => {
          const sessions = p.sessions.filter((s) => s.cwd === ws);
          const flag = sessions.some((s) => p.waiting.has(s.key))
            ? "waiting"
            : sessions.some((s) => s.busy)
              ? "busy"
              : null;
          const name = baseName(ws);
          return (
            <button
              key={ws}
              className={`rail-ws ${ws === p.workspace ? "selected" : ""}`}
              title={`${name}\n${ws}`}
              onClick={() => openWorkspace(ws)}
            >
              {name.charAt(0).toUpperCase()}
              {flag && <span className={`rail-badge ${flag}`} />}
            </button>
          );
        })}
        <button className="icon-btn rail-btn" title="폴더 추가" onClick={p.onAddWorkspace}>
          <FolderPlus size={18} />
        </button>
      </nav>

      <button className="icon-btn rail-btn" title="설정" onClick={p.onOpenSettings}>
        <Settings size={18} />
      </button>
    </aside>
  );
}
