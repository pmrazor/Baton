import { Fragment, useContext, useState, type ComponentType, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Lock,
  MessageSquare,
  PanelLeft,
  PanelLeftOpen,
  Plus,
  Settings,
  SquarePen,
  Workflow,
  X,
} from "lucide-react";
import { isTaskActive, sessionKey, type AgentInfo, type PermissionRequest, type Session, type Team } from "../types";
import type { ProViewId, UiMode } from "./proLayoutState";
import { canReviewChanges, taskLabel, taskTone, TeamsContext } from "./taskLabels";
import logo from "../assets/logo.png";

export interface ProRailViewItem {
  id: ProViewId;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

export interface ProRailConfig {
  views: readonly ProRailViewItem[];
  activeView: ProViewId | null;
  onToggleView: (id: ProViewId) => void;
  onToggleSubSidebar: () => void;
  onSwitchSimple: () => void;
}

export interface RailProps {
  workspaces: string[];
  workspace: string | null;
  sessions: Session[];
  teams?: Team[];
  activeKey: string | null;
  permissions: PermissionRequest[];
  missing: string[];
  onNewChat: (workspace?: string) => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onActivate: (key: string) => void;
  onToggleRail?: () => void;
  onOpenSettings: () => void;
  pro?: ProRailConfig;
}

interface Props extends RailProps {
  agents: AgentInfo[];
  onRemoveWorkspace: (path: string) => void;
  onImport: (path: string) => void;
  onCloseSession: (key: string) => void;
  /** Icon-only rail instead of the full sidebar. */
  rail: boolean;
  onToggleRail: () => void;
  uiMode: UiMode;
  onUiMode: (mode: UiMode) => void;
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
  const contextTeams = useContext(TeamsContext);
  const teams = p.teams ?? contextTeams;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Leads whose finished tasks are unfolded.
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const waiting = new Set(p.permissions.map((r) => sessionKey(r.agentId, r.sessionId)));

  if (p.rail) return <Rail {...p} />;

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

      <div className="ui-mode-toggle" role="group" aria-label="화면 모드">
        <button type="button" aria-pressed={p.uiMode === "simple"} onClick={() => p.onUiMode("simple")}>
          심플
        </button>
        <button type="button" aria-pressed={p.uiMode === "pro"} onClick={() => p.onUiMode("pro")}>
          프로
        </button>
      </div>

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
                  <button className="icon-btn sm" title="이전 대화 가져오기" onClick={() => p.onImport(ws)}>
                    <History size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    title="목록에서 빼기 (대화 기록은 이 폴더의 .baton에 남아요)"
                    onClick={() => p.onRemoveWorkspace(ws)}
                  >
                    <X size={14} />
                  </button>
                </span>
                <button
                  className="icon-btn sm workspace-new-chat"
                  title="이 폴더에서 새 대화"
                  aria-label="이 폴더에서 새 대화"
                  onClick={() => p.onNewChat(ws)}
                >
                  <Plus size={14} />
                </button>
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
                  {(() => {
                    const { active, finished } = splitTasks(s, childrenOf(s), waiting);
                    const row = (c: Session, done: boolean) => (
                      <div
                        key={c.key}
                        className={`session-row child ${done ? "done" : ""} ${c.key === p.activeKey ? "active" : ""}`}
                      >
                        <button
                          className="session-main"
                          title={taskLabel(s, c, waiting, teams)}
                          onClick={() => p.onActivate(c.key)}
                        >
                          <span className={`dot task-dot ${taskTone(s, c, waiting)}`} />
                          <span className="ellipsis">{c.title}</span>
                        </button>
                      </div>
                    );
                    // Keep the open chat visible even if its group is folded.
                    const open = showDone[s.key] || finished.some((c) => c.key === p.activeKey);
                    return (
                      <>
                        {active.map((c) => row(c, false))}
                        {finished.length > 0 && (
                          <div className="session-row child done-toggle">
                            <button
                              className="session-main"
                              onClick={() => {
                                // Folding away the task being viewed goes back to its lead.
                                if (open && finished.some((c) => c.key === p.activeKey)) p.onActivate(s.key);
                                setShowDone((o) => ({ ...o, [s.key]: !open }));
                              }}
                            >
                              {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                              <span className="ellipsis">완료된 작업 {finished.length}개</span>
                            </button>
                          </div>
                        )}
                        {open && finished.map((c) => row(c, true))}
                      </>
                    );
                  })()}
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

/**
 * Split a lead's task chats: still in play (running, queued, asking
 * permission, or awaiting a merge decision) vs. finished.
 */
function splitTasks(lead: Session, children: Session[], waiting: Set<string>) {
  const inPlay = (c: Session) => {
    const task = lead.tasks?.find((t) => t.id === c.parent?.taskId);
    return waiting.has(c.key) || c.busy || (!!task && (isTaskActive(task.status) || canReviewChanges(task)));
  };
  return { active: children.filter(inPlay), finished: children.filter((c) => !inPlay(c)) };
}

type Tip = { text: string; x: number; y: number };

export function Rail(p: RailProps) {
  const contextTeams = useContext(TeamsContext);
  const teams = p.teams ?? contextTeams;
  const waiting = new Set(p.permissions.map((r) => sessionKey(r.agentId, r.sessionId)));
  // Workspaces whose chats are unfolded under their letter (simple mode rail only).
  const [open, setOpen] = useState<Record<string, boolean>>(() => (p.workspace ? { [p.workspace]: true } : {}));
  // Leads whose finished tasks are unfolded.
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  // The rail scrolls, which would clip a CSS tooltip, so draw one fixed beside the hovered item.
  const [tip, setTip] = useState<Tip | null>(null);
  const tipFor = (text: string) => ({
    "aria-label": text,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ text, x: r.right + 8, y: r.top + r.height / 2 });
    },
    onMouseLeave: () => setTip(null),
  });

  const pro = p.pro;
  // In pro mode the logo is the way back to simple mode; the sub-sidebar opens
  // and closes from its view buttons (and its own ×).
  const logoTip = pro ? "심플 모드로 전환" : "사이드바 펼치기";
  const LogoHoverIcon = pro ? Columns2 : PanelLeftOpen;

  return (
    <aside className="sidebar rail" onScroll={() => setTip(null)}>
      <div className="rail-top" data-tauri-drag-region>
        <button
          className="rail-logo"
          onClick={pro ? pro.onSwitchSimple : p.onToggleRail}
          {...tipFor(logoTip)}
        >
          <img src={logo} alt="" />
          <LogoHoverIcon size={18} className="rail-logo-hover" />
        </button>
      </div>
      {pro ? (
        <>
          <div className="rail-divider" />
          {pro.views.map((view) => {
            const ViewIcon = view.icon;
            const active = pro.activeView === view.id;
            return (
              <button
                key={view.id}
                className={`icon-btn rail-btn rail-view-btn ${active ? "active" : ""}`}
                aria-pressed={active}
                onClick={() => pro.onToggleView(view.id)}
                {...tipFor(view.label)}
              >
                <ViewIcon size={18} />
              </button>
            );
          })}
        </>
      ) : (
        <button className="icon-btn rail-btn" onClick={() => p.onNewChat()} {...tipFor("새 대화")}>
          <SquarePen size={18} />
        </button>
      )}

      <div className="rail-divider" />

      <nav className="rail-workspaces" onScroll={() => setTip(null)}>
        {p.workspaces.map((ws) => {
          const all = p.sessions.filter((s) => s.cwd === ws);
          const flag = all.some((s) => waiting.has(s.key)) ? "waiting" : all.some((s) => s.busy) ? "busy" : null;
          const name = baseName(ws);
          const isOpen = pro ? ws === p.workspace : !!open[ws];
          const chats = all
            .filter((s) => !s.draft && !(s.parent && p.sessions.some((l) => l.key === s.parent!.key)))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <div key={ws} className={`rail-group ${isOpen ? "open" : ""}`}>
              <button
                className={`rail-ws ${ws === p.workspace ? "selected" : ""} ${p.missing.includes(ws) ? "missing" : ""}`}
                aria-expanded={isOpen}
                onClick={() => {
                  p.onSelectWorkspace(ws);
                  if (!pro) setOpen((o) => ({ ...o, [ws]: !o[ws] }));
                }}
                {...tipFor(p.missing.includes(ws) ? `${name} · 폴더를 찾을 수 없어요` : name)}
              >
                {name.charAt(0).toUpperCase()}
                {flag && !isOpen && <span className={`rail-badge ${flag}`} />}
              </button>
              {isOpen && (
                <div className="rail-chats">
                  {!pro && chats.length === 0 && (
                    <button className="icon-btn rail-chat" onClick={() => p.onNewChat(ws)} {...tipFor("이 폴더에서 새 대화")}>
                      <SquarePen size={15} />
                    </button>
                  )}
                  {chats.map((c) => {
                    const Icon = c.lead ? Workflow : MessageSquare;
                    const { active, finished } = splitTasks(
                      c,
                      p.sessions.filter((s) => s.parent?.key === c.key).sort((a, b) => a.createdAt - b.createdAt),
                      waiting,
                    );
                    const doneOpen = showDone[c.key] || finished.some((f) => f.key === p.activeKey);
                    const dot = (t: Session, done: boolean) => (
                      <button
                        key={t.key}
                        className={`rail-task ${done ? "done" : ""} ${t.key === p.activeKey ? "active" : ""}`}
                        onClick={() => p.onActivate(t.key)}
                        {...tipFor(taskLabel(c, t, waiting, teams))}
                      >
                        <span className={`dot task-dot ${taskTone(c, t, waiting)}`} />
                      </button>
                    );
                    return (
                      <Fragment key={c.key}>
                        <button
                          className={`rail-chat ${c.key === p.activeKey ? "active" : ""} ${c.lead ? "lead" : ""}`}
                          onClick={() => p.onActivate(c.key)}
                          {...tipFor(c.lead ? `${c.title} · 총괄` : c.title)}
                        >
                          <Icon size={15} />
                          {waiting.has(c.key) ? (
                            <span className="rail-badge waiting" />
                          ) : (
                            c.busy && <span className="rail-badge busy" />
                          )}
                        </button>
                        {active.map((t) => dot(t, false))}
                        {finished.length > 0 && (
                          <button
                            className="rail-task rail-done-toggle"
                            aria-expanded={doneOpen}
                            onClick={() => {
                              // Folding away the task being viewed goes back to its lead.
                              if (doneOpen && finished.some((f) => f.key === p.activeKey)) p.onActivate(c.key);
                              setShowDone((o) => ({ ...o, [c.key]: !doneOpen }));
                            }}
                            {...tipFor(`완료된 작업 ${finished.length}개 ${doneOpen ? "접기" : "펼치기"}`)}
                          >
                            {doneOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          </button>
                        )}
                        {doneOpen && finished.map((t) => dot(t, true))}
                      </Fragment>
                    );
                  })}
                  {pro && (
                    <button
                      className="icon-btn rail-chat rail-new-chat"
                      onClick={() => p.onNewChat(ws)}
                      {...tipFor("새 대화")}
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <button className="icon-btn rail-btn" onClick={p.onAddWorkspace} {...tipFor("폴더 추가")}>
          <FolderPlus size={18} />
        </button>
      </nav>

      <button className="icon-btn rail-btn" onClick={p.onOpenSettings} {...tipFor("설정")}>
        <Settings size={18} />
      </button>
      {tip && (
        <div className="rail-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.text}
        </div>
      )}
    </aside>
  );
}
