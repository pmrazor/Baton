import { useEffect, useRef, useState, type ComponentType, type PointerEvent, type ReactNode } from "react";
import { Download, Folder, FolderPlus, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { installedAgents } from "../types";
import {
  ActivityView,
  ChatBanners,
  ConversationView,
  LogsView,
  PRO_TABS,
  TabBar,
  TerminalPane,
  TitleBar,
  type ChatViewProps,
} from "./ChatView";
import { Rail, type ProRailViewItem, type RailProps } from "./Sidebar";
import {
  PRO_VIEWS,
  clampChatPanelWidth,
  clampSubSidebarWidth,
  isNarrowViewport,
  resolveChatPanelMode,
  toggleProView,
  toggleSubSidebar,
  type ProViewId,
} from "./proLayoutState";

const VIEW_ICONS: Record<ProViewId, ComponentType<{ size?: number }>> = {
  files: Folder,
};

const RAIL_VIEWS: readonly ProRailViewItem[] = PRO_VIEWS.map((v) => ({
  ...v,
  icon: VIEW_ICONS[v.id],
}));

export interface ProLayoutProps {
  rail: Omit<RailProps, "pro" | "onToggleRail">;
  chat: ChatViewProps;
  /** Rendered inside the sub-sidebar when the 파일 view is active. */
  fileTree: ReactNode;
  /** Rendered inside the center area when the 코드 tab is active. */
  editor: ReactNode;
  subWidth: number;
  onSubWidthChange: (width: number) => void;
  chatWidth: number;
  onChatWidthChange: (width: number) => void;
  onSwitchSimple: () => void;
}

export default function ProLayout(p: ProLayoutProps) {
  const { chat } = p;
  const { state, session, tab } = chat;
  const [activeView, setActiveView] = useState<ProViewId | null>("files");
  const [lastView, setLastView] = useState<ProViewId>("files");
  const [isNarrow, setIsNarrow] = useState(() => isNarrowViewport(window.innerWidth));
  const [wideChatOpen, setWideChatOpen] = useState(true);
  const [narrowChatOpen, setNarrowChatOpen] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const next = isNarrowViewport(window.innerWidth);
      setIsNarrow((prev) => {
        if (prev !== next) setNarrowChatOpen(false);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Returning to the full-width 대화 tab closes any narrow overlay.
  useEffect(() => {
    if (tab === "chat") setNarrowChatOpen(false);
  }, [tab]);

  const noAgents = state.agents.length > 0 && installedAgents(state.agents).length === 0;
  const noWorkspace = !state.workspace;
  const blocked = noAgents || noWorkspace;
  const chatPanelMode = blocked ? "none" : resolveChatPanelMode(tab, isNarrow, wideChatOpen, narrowChatOpen);

  useEffect(() => {
    if (chatPanelMode !== "overlay") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNarrowChatOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatPanelMode]);

  const handleToggleView = (id: ProViewId) => {
    setActiveView((cur) => {
      const next = toggleProView(cur, id);
      if (next) setLastView(next);
      return next;
    });
  };

  const handleToggleSubSidebar = () => {
    setActiveView((cur) => toggleSubSidebar(cur, lastView));
  };

  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const cwd = session?.cwd ?? state.workspace;
  const activeViewMeta = activeView ? PRO_VIEWS.find((v) => v.id === activeView) : null;

  const reopenChatButton =
    chatPanelMode === "collapsed" ? (
      <button
        type="button"
        className="tab-bar-action"
        title="채팅 패널 열기"
        onClick={() => (isNarrow ? setNarrowChatOpen(true) : setWideChatOpen(true))}
      >
        <PanelRightOpen size={15} />
        <span>대화</span>
      </button>
    ) : undefined;

  return (
    <div className="app pro-mode">
      <TitleBar className="full" state={state} session={session} onOpenSession={chat.onOpenSession} />
      <div className="pro-body">
        <Rail
          {...p.rail}
          pro={{
            views: RAIL_VIEWS,
            activeView,
            onToggleView: handleToggleView,
            onToggleSubSidebar: handleToggleSubSidebar,
            onSwitchSimple: p.onSwitchSimple,
          }}
        />

        {activeView && (
          <>
            <aside className="pro-sub-sidebar" style={{ width: p.subWidth }}>
              <div className="pro-pane-head">
                {/* The view's own content names the folder (the file tree's first row), like VS Code's explorer. */}
                <span className="pro-pane-title grow">{activeViewMeta?.label ?? ""}</span>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="사이드바 닫기"
                  aria-label="사이드바 닫기"
                  onClick={() => setActiveView(null)}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="pro-pane-body">{activeView === "files" && p.fileTree}</div>
            </aside>
            <Splitter
              label="사이드바 너비 조절"
              width={p.subWidth}
              direction="right"
              clamp={clampSubSidebarWidth}
              onWidth={p.onSubWidthChange}
            />
          </>
        )}

        <div className="pro-stage">
          <main className="main pro-center">
            <TabBar
              session={session}
              cwd={cwd}
              tab={tab}
              onTab={chat.onTab}
              tabs={PRO_TABS}
              right={reopenChatButton}
            />

            <ChatBanners {...chat} />

            {tab === "terminal" && cwd ? (
              <TerminalPane cwd={cwd} />
            ) : noAgents ? (
              <div className="welcome">
                <h1>에이전트를 하나 설치해 주세요</h1>
                <p className="muted">Baton은 이 컴퓨터에 설치된 코딩 에이전트와 대화해요. 아직 찾은 에이전트가 없어요.</p>
                <button className="btn btn-primary" onClick={chat.onOpenAgents}>
                  <Download size={16} /> 에이전트 설치
                </button>
              </div>
            ) : noWorkspace ? (
              <div className="welcome">
                <h1>작업할 폴더를 열어 주세요</h1>
                <p className="muted">에이전트는 선택한 워크스페이스 안에서 파일을 읽고 수정해요.</p>
                <button className="btn btn-primary" onClick={chat.onAddWorkspace}>
                  <FolderPlus size={16} /> 폴더 열기
                </button>
              </div>
            ) : tab === "code" ? (
              <div className="pro-editor-slot">{p.editor}</div>
            ) : tab === "activity" ? (
              session ? <ActivityView session={session} /> : null
            ) : tab === "logs" ? (
              session ? <LogsView lines={state.logs[session.agentId] ?? []} /> : null
            ) : (
              <ConversationView {...chat} agentName={agentName} />
            )}
          </main>

          {chatPanelMode === "docked" && (
            <>
              <Splitter
                label="채팅 패널 너비 조절"
                width={p.chatWidth}
                direction="left"
                clamp={clampChatPanelWidth}
                onWidth={p.onChatWidthChange}
              />
              <aside className="pro-chat-panel" style={{ width: p.chatWidth }}>
                <div className="pro-pane-head">
                  <span className="pro-pane-title">대화</span>
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="채팅 패널 접기"
                    aria-label="채팅 패널 접기"
                    onClick={() => setWideChatOpen(false)}
                  >
                    <PanelRightClose size={15} />
                  </button>
                </div>
                <ConversationView {...chat} agentName={agentName} />
              </aside>
            </>
          )}

          {chatPanelMode === "overlay" && (
            <>
              <div className="pro-overlay-backdrop" onClick={() => setNarrowChatOpen(false)} />
              <aside className="pro-chat-panel overlay" style={{ width: p.chatWidth }}>
                <div className="pro-pane-head">
                  <span className="pro-pane-title">대화</span>
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="채팅 패널 닫기"
                    aria-label="채팅 패널 닫기"
                    onClick={() => setNarrowChatOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                <ConversationView {...chat} agentName={agentName} />
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Splitter(p: {
  label: string;
  width: number;
  direction: "right" | "left";
  clamp: (width: number) => number;
  onWidth: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: p.width };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const raw = p.direction === "right" ? drag.current.startWidth + dx : drag.current.startWidth - dx;
    p.onWidth(p.clamp(raw));
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      className={`pro-splitter ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 16 : -16;
        p.onWidth(p.clamp(p.direction === "right" ? p.width + step : p.width - step));
      }}
    />
  );
}
