import { Fragment, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Lock,
  MessageSquare,
  PanelLeft,
  PanelLeftOpen,
  Settings,
  SquarePen,
  Workflow,
  X,
} from "lucide-react";
import type { AgentInfo, PermissionRequest, Session } from "../types";
import logo from "../assets/logo.png";
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
  onImport: (path: string) => void;
  /** Folders that no longer exist on disk. */
  missing: string[];
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
          <img className="brand-mark" src={logo} alt="" />
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
          // Task chats are listed under their lead, not on their own.
          const sessions = p.sessions
            .filter((s) => s.cwd === ws && !s.draft && !(s.parent && p.sessions.some((l) => l.key === s.parent!.key)))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const childrenOf = (lead: Session) =>
            p.sessions.filter((s) => s.parent?.key === lead.key).sort((a, b) => a.createdAt - b.createdAt);
          const isOpen = !collapsed[ws];
          const selected = ws === p.workspace;
          return (
            <div key={ws} className="workspace">
              <div
                className={`workspace-row ${selected ? "selected" : ""} ${p.missing.includes(ws) ? "missing" : ""}`}
                title={p.missing.includes(ws) ? `폴더를 찾을 수 없어요: ${ws}` : ws}
              >
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
                  <button className="icon-btn sm" title="이전 대화 가져오기" onClick={() => p.onImport(ws)}>
                    <History size={14} />
                  </button>
                  <button className="icon-btn sm" title="목록에서 제거" onClick={() => p.onRemoveWorkspace(ws)}>
                    <X size={14} />
                  </button>
                </span>
              </div>

              {isOpen &&
                sessions.map((s) => (
                  <Fragment key={s.key}>
                  <div className={`session-row ${s.key === p.activeKey ? "active" : ""}`}>
                    <button className="session-main" onClick={() => p.onActivate(s.key)}>
                      <span className="ellipsis">{s.title}</span>
                      {s.lead && <span className="lead-tag">총괄</span>}
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
                  {childrenOf(s).map((c) => {
                    const tone = taskTone(s, c, waiting);
                    return (
                      <div key={c.key} className={`session-row child ${c.key === p.activeKey ? "active" : ""}`}>
                        <button className="session-main" onClick={() => p.onActivate(c.key)}>
                          <span className={`dot task-dot ${tone}`} />
                          <span className="ellipsis">{c.title}</span>
                        </button>
                      </div>
                    );
                  })}
                  </Fragment>
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

/** Status colour of a task chat, from its lead's task record. */
function taskTone(lead: Session, child: Session, waiting: Set<string>) {
  const task = lead.tasks?.find((t) => t.id === child.parent?.taskId);
  if (waiting.has(child.key)) return "wait";
  if (task?.status === "running" || task?.status === "starting" || child.busy) return "run";
  if (task?.status === "done") return "done";
  if (task?.status === "failed") return "fail";
  return "idle";
}

function Rail(p: Props & { waiting: Set<string> }) {
  // Workspaces whose chats are unfolded under their letter.
  const [open, setOpen] = useState<Record<string, boolean>>(() => (p.workspace ? { [p.workspace]: true } : {}));

  return (
    <aside className="sidebar rail">
      <div className="rail-top" data-tauri-drag-region>
        <button className="rail-logo" title="사이드바 펼치기" onClick={p.onToggleRail}>
          <img src={logo} alt="" />
          <PanelLeftOpen size={18} className="rail-logo-hover" />
        </button>
      </div>
      <button className="icon-btn rail-btn" title="새 대화" onClick={() => p.onNewChat()}>
        <SquarePen size={18} />
      </button>

      <div className="rail-divider" />

      <nav className="rail-workspaces">
        {p.workspaces.map((ws) => {
          const all = p.sessions.filter((s) => s.cwd === ws);
          const flag = all.some((s) => p.waiting.has(s.key)) ? "waiting" : all.some((s) => s.busy) ? "busy" : null;
          const name = baseName(ws);
          const isOpen = !!open[ws];
          const chats = all
            .filter((s) => !s.draft && !(s.parent && p.sessions.some((l) => l.key === s.parent!.key)))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <div key={ws} className={`rail-group ${isOpen ? "open" : ""}`}>
              <button
                className={`rail-ws ${ws === p.workspace ? "selected" : ""} ${p.missing.includes(ws) ? "missing" : ""}`}
                title={p.missing.includes(ws) ? `${name}\n폴더를 찾을 수 없어요: ${ws}` : `${name}\n${ws}`}
                aria-expanded={isOpen}
                onClick={() => {
                  p.onSelectWorkspace(ws);
                  setOpen((o) => ({ ...o, [ws]: !o[ws] }));
                }}
              >
                {name.charAt(0).toUpperCase()}
                {flag && !isOpen && <span className={`rail-badge ${flag}`} />}
              </button>
              {isOpen && (
                <div className="rail-chats">
                  {chats.length === 0 && (
                    <button className="icon-btn rail-chat" title="이 폴더에서 새 대화" onClick={() => p.onNewChat(ws)}>
                      <SquarePen size={15} />
                    </button>
                  )}
                  {chats.map((c) => {
                    const Icon = c.lead ? Workflow : MessageSquare;
                    const children = p.sessions
                      .filter((s) => s.parent?.key === c.key)
                      .sort((a, b) => a.createdAt - b.createdAt);
                    return (
                      <Fragment key={c.key}>
                        <button
                          className={`rail-chat ${c.key === p.activeKey ? "active" : ""} ${c.lead ? "lead" : ""}`}
                          title={c.title}
                          onClick={() => p.onActivate(c.key)}
                        >
                          <Icon size={15} />
                          {p.waiting.has(c.key) ? (
                            <span className="rail-badge waiting" />
                          ) : (
                            c.busy && <span className="rail-badge busy" />
                          )}
                        </button>
                        {children.map((t) => (
                          <button
                            key={t.key}
                            className={`rail-task ${t.key === p.activeKey ? "active" : ""}`}
                            title={t.title}
                            onClick={() => p.onActivate(t.key)}
                          >
                            <span className={`dot task-dot ${taskTone(c, t, p.waiting)}`} />
                          </button>
                        ))}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>
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
