import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Download, FolderPlus } from "lucide-react";
import { api } from "../api";
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
import { ToolRow } from "./Messages";
import { groupTurns, TurnView } from "./Turn";
import PermissionCard from "./PermissionCard";
import { baseName } from "./Sidebar";

// xterm is loaded only once a terminal is opened.
const TerminalView = lazy(() => import("./TerminalView"));

interface Props {
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
  onMergeTask: (session: Session, taskId: string) => void;
  /** Shown under the tab bar (e.g. an available update). */
  banner?: ReactNode;
  onDiscardTask: (session: Session, taskId: string) => void;
}

export type Tab = "chat" | "terminal" | "activity" | "logs";

const TABS = [
  ["chat", "대화"],
  ["terminal", "터미널"],
  ["activity", "활동"],
  ["logs", "로그"],
] as const;

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

function TabBar(p: { session: Session | null; cwd: string | null; tab: Tab; onTab: (tab: Tab) => void }) {
  const { session, cwd, tab, onTab } = p;
  const started = !!session && !session.draft;
  // The terminal only needs a folder, so it works for a draft too (and then
  // 대화 must stay clickable to get back).
  const enabled = (id: Tab) => (id === "terminal" || id === "chat" ? started || !!cwd : started);
  return (
    <nav className="tab-bar">
      {TABS.map(([id, label]) => (
        <button
          key={id}
          className={tab === id ? "active" : ""}
          disabled={!enabled(id)}
          onClick={() => onTab(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export default function ChatView(p: Props) {
  const { state, session, tab } = p;
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const cwd = session?.cwd ?? state.workspace;

  return (
    <main className="main">
      {p.showTitle && <TitleBar state={state} session={session} onOpenSession={p.onOpenSession} />}
      <TabBar session={session} cwd={cwd} tab={tab} onTab={p.onTab} />

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

      {tab === "terminal" && cwd ? (
        // Without the composer, so keys go to the shell.
        <Suspense fallback={<div className="terminal-view" />}>
          <TerminalView cwd={cwd} />
        </Suspense>
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

function ConversationView(p: Props & { agentName: (id: string) => string }) {
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

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, permissions.length]);

  return (
    <>
      <div
        className="scroll"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="thread">
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
                tasks={session?.tasks?.filter((t) => t.turnId === turn.user?.id)}
                agents={state.agents}
                permissions={state.permissions}
                onOpen={p.onOpenSession}
                onPermission={p.onPermission}
                onMerge={(id) => session && p.onMergeTask(session, id)}
                onDiscard={(id) => session && p.onDiscardTask(session, id)}
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
    </>
  );
}

function ActivityView({ session }: { session: Session }) {
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

function LogsView({ lines }: { lines: string[] }) {
  return (
    <div className="scroll">
      <div className="thread">
        <pre className="code log">{lines.join("\n") || "로그 없음"}</pre>
      </div>
    </div>
  );
}

function AuthBanner(p: Props & { agentName: string }) {
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
