import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Download, FolderPlus } from "lucide-react";
import { api } from "../api";
import { accountLimit, leadLimit } from "../handoff";
import type { State } from "../store";
import {
  accountKey,
  DEFAULT_PROFILE,
  installedAgents,
  profileOf,
  sessionKey,
  type Attachment,
  type ChatItem,
  type Launch,
  type Session,
} from "../types";
import Composer from "./Composer";
import UnmergedBanner from "./UnmergedBanner";
import { ChatRootContext, ToolRow } from "./Messages";
import { groupTurns, TurnView } from "./Turn";
import PermissionCard from "./PermissionCard";
import { baseName } from "./Sidebar";
import { fmtReset } from "./UsagePanel";

// xterm is loaded only once a terminal is opened.
const TerminalView = lazy(() => import("./TerminalView"));

export interface ChatViewProps {
  state: State;
  session: Session | null;
  connecting: string | null;
  tab: Tab;
  /** False when the app renders the title bar itself (rail layout). */
  showTitle: boolean;
  onTab: (tab: Tab) => void;
  onAddWorkspace: () => void;
  onNewChat: (workspace?: string, agentId?: string, launch?: Launch) => void;
  onSend: (session: Session, text: string, attachments: Attachment[]) => void;
  onCancel: (session: Session) => void;
  onPermission: (key: string, optionId: string | null) => void;
  onSetConfig: (session: Session, configId: string, value: unknown) => void;
  onSetMode: (session: Session, modeId: string) => void;
  onDismissAuth: () => void;
  /** Open settings on the agents tab (install / manage). */
  onOpenAgents: () => void;
  agentMode: boolean;
  teamId: string;
  onChangeMode: (opts: { lead?: boolean; team?: string }) => void;
  onOpenSession: (key: string) => void;
  onRetryAttach: (key: string) => void;
  /** Merge a worktree task: everything left, or only `files`. */
  onMergeTask: (session: Session, taskId: string, files?: string[]) => Promise<unknown> | void;
  /** Show one file of a task's result commit; `root` is the lead's folder. */
  onOpenTaskDiff?: (root: string, hash: string, path: string) => void;
  /** Shown under the tab bar (e.g. an available update). */
  banner?: ReactNode;
  onDiscardTask: (session: Session, taskId: string) => void;
  onHandoff: (session: Session, toAgentId: string) => void;
  onDismissLimit: (key: string) => void;
}

export type Tab = "chat" | "code" | "terminal" | "activity" | "logs";

export type TabEntry = readonly [Tab, string];

const TABS: readonly TabEntry[] = [
  ["chat", "대화"],
  ["terminal", "터미널"],
  ["activity", "활동"],
  ["logs", "로그"],
];

export const PRO_TABS: readonly TabEntry[] = [
  ["chat", "대화"],
  ["code", "코드"],
  ["terminal", "터미널"],
  ["activity", "활동"],
  ["logs", "로그"],
];

interface BarProps {
  state: State;
  session: Session | null;
  className?: string;
}

/** Title row: chat title, agent and workspace. Spans the window when the sidebar is a rail. */
/** "Claude Code" or, for a non-default account, "Claude Code · 회사". */
export function accountLabel(state: State, agentId: string, profileId: string) {
  const agent = state.agents.find((a) => a.id === agentId)?.name ?? agentId;
  if (profileId === DEFAULT_PROFILE) return agent;
  const profile = state.profiles.find((p) => p.id === profileId)?.name;
  return profile ? `${agent} · ${profile}` : agent;
}

export function TitleBar({ state, session, className = "", onOpenSession }: BarProps & { onOpenSession?: (key: string) => void }) {
  const agentName = session ? accountLabel(state, session.agentId, profileOf(session.launch)) : null;
  const cwd = session?.cwd ?? state.workspace;
  const parent = session?.parent ? state.sessions.find((s) => s.key === session.parent!.key) : undefined;
  return (
    <header className={`title-bar ${className}`} data-tauri-drag-region>
      {parent && (
        <>
          <button className="crumb" onClick={() => onOpenSession?.(parent.key)}>
            {parent.title}
          </button>
          <span className="crumb-sep">›</span>
        </>
      )}
      <span className="title-text">{session && !session.draft ? session.title : "새 대화"}</span>
      {session?.lead && <span className="pill brand">에이전트 모드</span>}
      {agentName && <span className="pill">{agentName}</span>}
      {cwd && <span className="pill subtle">{baseName(cwd)}</span>}
    </header>
  );
}

export function TabBar(p: {
  session: Session | null;
  cwd: string | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  tabs?: readonly TabEntry[];
  right?: ReactNode;
}) {
  const { session, cwd, tab, onTab, tabs = TABS, right } = p;
  const started = !!session && !session.draft;
  // Code and terminal only need a folder, so they work for a draft too (and then
  // 대화 must stay clickable to get back).
  const enabled = (id: Tab) => (id === "code" || id === "terminal" || id === "chat" ? started || !!cwd : started);
  return (
    <nav className="tab-bar">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          className={tab === id ? "active" : ""}
          disabled={!enabled(id)}
          onClick={() => onTab(id)}
        >
          {label}
        </button>
      ))}
      {right && <div className="tab-bar-right">{right}</div>}
    </nav>
  );
}

export function TerminalPane({ cwd }: { cwd: string }) {
  return (
    <Suspense fallback={<div className="terminal-view" />}>
      <TerminalView cwd={cwd} />
    </Suspense>
  );
}

export function ChatBanners(p: ChatViewProps) {
  const { state, session } = p;
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const limit = leadLimit(session, state.accountUsage);

  return (
    <>
      {p.banner}
      {state.workspace && <UnmergedBanner workspace={state.workspace} />}
      {session?.archived && (
        <div className="auth-banner archived-banner">
          <div>
            <b>끝난 작업이에요</b>
            <div className="muted small">
              작업 폴더가 정리돼서 기록만 볼 수 있어요. 이어서 할 일은 총괄 대화에서 새로 맡겨 주세요.
            </div>
          </div>
        </div>
      )}
      {session?.attachError && (
        <div className="auth-banner">
          <div>
            <b>대화를 다시 연결하지 못했어요</b>
            <div className="muted small">{session.attachError}</div>
          </div>
          <div className="auth-actions">
            <button className="btn btn-primary" onClick={() => p.onRetryAttach(session.key)}>
              다시 시도
            </button>
          </div>
        </div>
      )}
      {state.authPrompt && <AuthBanner {...p} agentName={agentName(state.authPrompt.agentId)} />}
      {session && limit && (
        <LimitBanner
          state={state}
          session={session}
          resetsAt={limit.resetsAt}
          busy={!!p.connecting}
          agentName={agentName(session.agentId)}
          onHandoff={p.onHandoff}
          onDismiss={p.onDismissLimit}
        />
      )}
    </>
  );
}

export default function ChatView(p: ChatViewProps) {
  const { state, session, tab } = p;
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const cwd = session?.cwd ?? state.workspace;

  return (
    <main className="main">
      {p.showTitle && <TitleBar state={state} session={session} onOpenSession={p.onOpenSession} />}
      <TabBar session={session} cwd={cwd} tab={tab} onTab={p.onTab} />

      <ChatBanners {...p} />

      {tab === "terminal" && cwd ? (
        // Without the composer, so keys go to the shell.
        <TerminalPane cwd={cwd} />
      ) : state.agents.length > 0 && installedAgents(state.agents).length === 0 ? (
        <div className="welcome">
          <h1>에이전트를 하나 설치해 주세요</h1>
          <p className="muted">Baton은 이 컴퓨터에 설치된 코딩 에이전트와 대화해요. 아직 찾은 에이전트가 없어요.</p>
          <button className="btn btn-primary" onClick={p.onOpenAgents}>
            <Download size={16} /> 에이전트 설치
          </button>
        </div>
      ) : !state.workspace ? (
        <div className="welcome">
          <h1>작업할 폴더를 열어 주세요</h1>
          <p className="muted">에이전트는 선택한 워크스페이스 안에서 파일을 읽고 수정해요.</p>
          <button className="btn btn-primary" onClick={p.onAddWorkspace}>
            <FolderPlus size={16} /> 폴더 열기
          </button>
        </div>
      ) : tab === "activity" && session ? (
        <ActivityView session={session} />
      ) : tab === "logs" && session ? (
        <LogsView lines={state.logs[session.agentId] ?? []} />
      ) : (
        <ConversationView {...p} agentName={agentName} />
      )}
    </main>
  );
}

/** Within `threshold` px of the end: new content should keep it scrolled down. */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function ConversationView(p: ChatViewProps & { agentName: (id: string) => string }) {
  const { session, state } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const permissions = session
    ? state.permissions.filter((r) => sessionKey(r.agentId, r.sessionId) === session.key)
    : [];
  const items = session?.items ?? [];
  const turns = groupTurns(items);
  const lastTurn = turns.at(-1);
  const busy = !!session?.busy;
  const usable = installedAgents(state.agents);
  const agentId = session?.agentId ?? p.connecting ?? usable[0]?.id ?? null;
  const profileId = profileOf(session?.launch);
  const account = agentId ? accountKey(agentId, profileId) : null;

  const threadRef = useRef<HTMLDivElement>(null);
  const pinToBottom = () => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  };

  // Scrolled up away from the end: offer a button back down.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const jumpToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Opening a chat (or coming back from another tab) shows its end.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setAwayFromBottom(false);
    pinToBottom();
  }, [session?.key]);

  useEffect(pinToBottom, [items, permissions.length]);

  // Markdown, code blocks and thumbnails grow after the first paint: keep
  // following them while the user hasn't scrolled up.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(thread);
    return () => observer.disconnect();
  }, []);

  return (
    <ChatRootContext.Provider value={session?.cwd ?? null}>
      <div
        className="scroll"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
          setAwayFromBottom(!stickToBottom.current);
        }}
      >
        <div className="thread" ref={threadRef}>
          {items.length === 0 ? (
            <div className="welcome inline">
              <h1>무엇을 도와드릴까요?</h1>
              <p className="muted">{state.workspace}</p>
            </div>
          ) : (
            turns.map((turn, i) => (
              <TurnView
                key={turn.key}
                turn={turn}
                running={busy && i === turns.length - 1}
                isLast={i === turns.length - 1}
                tasks={session?.tasks?.filter((t) => t.turnId === turn.user?.id || (i === 0 && !t.turnId))}
                agents={state.agents}
                permissions={state.permissions}
                onOpen={p.onOpenSession}
                onPermission={p.onPermission}
                onMerge={(id, files) => (session ? p.onMergeTask(session, id, files) : undefined)}
                onDiscard={(id) => session && p.onDiscardTask(session, id)}
                onOpenTaskDiff={(hash, path) => session && p.onOpenTaskDiff?.(session.cwd, hash, path)}
                leadBusy={busy}
              />
            ))
          )}
          {permissions.map((r) => (
            <PermissionCard key={r.key} request={r} agentName={p.agentName(r.agentId)} onAnswer={p.onPermission} />
          ))}
          {busy && permissions.length === 0 && lastTurn && lastTurn.process.length === 0 && !lastTurn.answer && (
            <div className="typing">응답 중…</div>
          )}
        </div>
      </div>
      {awayFromBottom && (
        <div className="jump-anchor">
          <button className="jump-bottom" title="맨 아래로" aria-label="맨 아래로" onClick={jumpToBottom}>
            <ArrowDown size={16} />
          </button>
        </div>
      )}
      <Composer
        session={session}
        agents={usable}
        onAddAgent={p.onOpenAgents}
        agentId={agentId}
        profileId={profileId}
        profiles={state.profiles}
        identities={state.identities}
        accountName={agentId ? accountLabel(state, agentId, profileId) : "에이전트"}
        accountUsage={account ? (state.accountUsage[account] ?? null) : null}
        connecting={!!p.connecting}
        onSwitchAgent={(id, profile) =>
          p.onNewChat(state.workspace ?? undefined, id, {
            ...(id === agentId ? session?.launch : undefined),
            profile,
          })
        }
        onSetLaunch={(id, value) =>
          agentId && p.onNewChat(state.workspace ?? undefined, agentId, { ...session?.launch, [id]: value })
        }
        onSend={(text, attachments) => session && p.onSend(session, text, attachments)}
        onCancel={() => session && p.onCancel(session)}
        onSetConfig={(id, v) => session && p.onSetConfig(session, id, v)}
        onSetMode={(id) => session && p.onSetMode(session, id)}
        agentMode={session && !session.draft ? !!session.lead : p.agentMode}
        teamId={session?.lead?.teamId ?? p.teamId}
        teams={state.teams}
        isTask={!!session?.parent}
        onChangeMode={p.onChangeMode}
      />
    </ChatRootContext.Provider>
  );
}

export function ActivityView({ session }: { session: Session }) {
  const tools = session.items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
  return (
    <div className="scroll">
      <div className="thread">
        {tools.length === 0 ? (
          <p className="muted center">아직 실행된 도구가 없어요.</p>
        ) : (
          tools.map((t) => <ToolRow key={t.id} item={t} />)
        )}
      </div>
    </div>
  );
}

export function LogsView({ lines }: { lines: string[] }) {
  return (
    <div className="scroll">
      <div className="thread">
        <pre className="code log">{lines.join("\n") || "로그 없음"}</pre>
      </div>
    </div>
  );
}

function AuthBanner(p: ChatViewProps & { agentName: string }) {
  const name = accountLabel(p.state, p.state.authPrompt!.agentId, p.state.authPrompt!.profileId);
  const prompt = p.state.authPrompt!;
  const agent = p.state.agents.find((a) => a.id === prompt.agentId);
  const terminalMethods = prompt.methods.filter((m) => m.type === "terminal" && m.args);
  return (
    <div className="auth-banner">
      <div>
        <b>{name}</b> · {prompt.message}
        {terminalMethods.length === 0 && agent?.loginHint && <div className="muted small">{agent.loginHint}</div>}
      </div>
      <div className="auth-actions">
        {terminalMethods.length === 0 && agent?.canLogin && (
          <button
            className="btn"
            title={agent.loginNote || undefined}
            onClick={() => api.loginProfile(prompt.agentId, prompt.profileId)}
          >
            로그인
          </button>
        )}
        {terminalMethods.map((m) => (
          <button
            key={m.id}
            className="btn"
            title={m.description ?? undefined}
            onClick={() => api.openLoginTerminal(prompt.agentId, m.args ?? [], prompt.profileId)}
          >
            {m.name} 로그인
          </button>
        ))}
        <button
          className="btn btn-primary"
          onClick={() => p.onNewChat(p.state.workspace ?? undefined, prompt.agentId, { profile: prompt.profileId })}
        >
          다시 시도
        </button>
        <button className="btn" onClick={p.onDismissAuth}>
          닫기
        </button>
      </div>
    </div>
  );
}

function LimitBanner(p: {
  state: State;
  session: Session;
  resetsAt?: number;
  busy: boolean;
  agentName: string;
  onHandoff: (session: Session, toAgentId: string) => void;
  onDismiss: (key: string) => void;
}) {
  const { state, session, resetsAt, busy, agentName, onHandoff, onDismiss } = p;
  const candidates = installedAgents(state.agents).filter(
    (a) => a.id !== session.agentId && !accountLimit(state.accountUsage[accountKey(a.id, DEFAULT_PROFILE)]),
  );
  return (
    <div className="auth-banner">
      <div>
        <b>
          총괄({agentName})이 사용량 한도에 걸렸어요
          {resetsAt !== undefined && ` · ${fmtReset(resetsAt)}`}
        </b>
        <div className="muted small">
          지금까지 대화를 정리해서 다른 에이전트에게 넘길 수 있어요. 정리한 내용만 넘어가서 세세한 맥락은 빠질 수
          있어요.
        </div>
      </div>
      <div className="auth-actions">
        {candidates.map((a) => (
          <button
            key={a.id}
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onHandoff(session, a.id)}
          >
            {a.name}로 이어서 하기
          </button>
        ))}
        <button className="btn" onClick={() => onDismiss(session.key)}>
          닫기
        </button>
      </div>
    </div>
  );
}
