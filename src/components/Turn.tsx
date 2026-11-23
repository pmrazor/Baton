import { useEffect, useState } from "react";
import { Atom, ChevronRight } from "lucide-react";
import type { AgentInfo, ChatItem, PermissionRequest, TaskInfo } from "../types";
import { ChatItemView, Md, PlanView, ThoughtRow, ToolRow } from "./Messages";
import TaskCard from "./TaskCard";

/** What starts a turn: the user's message, or a lead's instruction to a task. */
type UserItem = Extract<ChatItem, { kind: "user" | "brief" }>;

export interface TurnGroup {
  key: string;
  user: UserItem | null;
  /** Thoughts, tool calls, plans and interim text before the answer. */
  process: ChatItem[];
  /** The trailing assistant message, shown outside the process group. */
  answer: ChatItem | null;
  /** Notices (errors, "중단됨") stay visible after the answer. */
  notices: ChatItem[];
}

/** Split a transcript into turns, each starting at a user message. */
export function groupTurns(items: ChatItem[]): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let rest: ChatItem[] = [];
  let user: UserItem | null = null;

  const flush = () => {
    if (!user && rest.length === 0) return;
    const notices = rest.filter((i) => i.kind === "notice");
    const body = rest.filter((i) => i.kind !== "notice");
    const last = body.at(-1);
    const answer = last?.kind === "assistant" ? last : null;
    turns.push({
      key: user?.id ?? `pre-${rest[0]?.id}`,
      user,
      process: answer ? body.slice(0, -1) : body,
      answer,
      notices,
    });
  };

  for (const item of items) {
    if (item.kind === "user" || item.kind === "brief") {
      flush();
      user = item;
      rest = [];
    } else {
      rest.push(item);
    }
  }
  flush();
  return turns;
}

function fmtDuration(ms: number) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}초`;
  return `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
}

interface TurnProps {
  turn: TurnGroup;
  running: boolean;
  isLast: boolean;
  /** Tasks the lead created during this turn (agent mode). */
  tasks?: TaskInfo[];
  agents?: AgentInfo[];
  permissions?: PermissionRequest[];
  onOpen?: (sessionKey: string) => void;
  onPermission?: (key: string, optionId: string | null) => void;
  onMerge?: (taskId: string) => void;
  onDiscard?: (taskId: string) => void;
  /** The lead conversation is responding. */
  leadBusy?: boolean;
}

export function TurnView(p: TurnProps) {
  const { turn, running, isLast, tasks, agents, permissions, onOpen, onPermission } = p;
  return (
    <>
      {turn.user && <ChatItemView item={turn.user} isLast={false} />}
      {turn.process.length > 0 && (
        <ProcessGroup steps={turn.process} running={running} startedAt={turn.user?.startedAt} durationMs={turn.user?.durationMs} />
      )}
      {tasks && tasks.length > 0 && (
        <TaskCard
          tasks={tasks}
          agents={agents ?? []}
          permissions={permissions ?? []}
          onOpen={onOpen ?? (() => {})}
          onPermission={onPermission ?? (() => {})}
          onMerge={p.onMerge ?? (() => {})}
          onDiscard={p.onDiscard ?? (() => {})}
          leadBusy={!!p.leadBusy}
        />
      )}
      {turn.answer && <ChatItemView item={turn.answer} isLast={isLast && !running} />}
      {turn.notices.map((n) => (
        <ChatItemView key={n.id} item={n} isLast={false} />
      ))}
    </>
  );
}

function ProcessGroup(p: { steps: ChatItem[]; running: boolean; startedAt?: number; durationMs?: number }) {
  // Follows the turn (open while running, folded when done) until the user toggles it.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? p.running;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!p.running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [p.running]);

  const label = p.running
    ? `작업 중${p.startedAt ? ` · ${fmtDuration(now - p.startedAt)}` : ""}`
    : p.durationMs !== undefined
      ? `${fmtDuration(p.durationMs)} 동안 작업`
      : "작업 과정";

  return (
    <div className={`process ${open ? "open" : ""} ${p.running ? "running" : ""}`}>
      <button className="process-head" onClick={() => setUserOpen(!open)}>
        <Atom size={15} className="process-icon" />
        <span>{label}</span>
        <ChevronRight size={14} className="trace-chev" />
      </button>
      {open && (
        <div className="process-body">
          {p.steps.map((step) => (
            <Step key={step.id} item={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function Step({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "thought":
      return <ThoughtRow text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanView entries={item.entries} />;
    case "assistant":
      return (
        <div className="process-note">
          <Md text={item.text} />
        </div>
      );
    default:
      return <ChatItemView item={item} isLast={false} />;
  }
}
