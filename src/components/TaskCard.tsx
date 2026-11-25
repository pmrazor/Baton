import { useContext, useEffect, useState } from "react";
import { ChevronRight, Lock } from "lucide-react";
import type { AgentInfo, PermissionRequest, TaskInfo, Team } from "../types";
import { isTaskActive, sessionKey } from "../types";
import {
  formatReassigned,
  memberNameMap,
  taskStatusBadge,
  taskSubLine,
  TeamsContext,
} from "./taskLabels";

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Props {
  tasks: TaskInfo[];
  agents: AgentInfo[];
  permissions: PermissionRequest[];
  onOpen: (sessionKey: string) => void;
  onPermission: (key: string, optionId: string | null) => void;
  onMerge: (taskId: string) => void;
  onDiscard: (taskId: string) => void;
  /** The lead is mid-turn and may still be reviewing finished tasks. */
  leadBusy: boolean;
  teams?: Team[];
}

/** The lead's delegation summary for one turn: one row per task. */
export default function TaskCard({
  tasks,
  agents,
  permissions,
  onOpen,
  onPermission,
  onMerge,
  onDiscard,
  leadBusy,
  teams,
}: Props) {
  const contextTeams = useContext(TeamsContext);
  const memberNames = memberNameMap(teams ?? contextTeams, tasks);
  const [now, setNow] = useState(Date.now());
  const live = tasks.some((t) => isTaskActive(t.status));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div className="tasks">
      <div className="tasks-head">
        <b>작업 분배</b>
        <span>총괄이 {tasks.length}개 작업을 맡겼어요</span>
        <span className="tasks-count">
          {done} / {tasks.length} 완료
        </span>
      </div>
      {tasks.map((t) => {
        const key = t.sessionId ? sessionKey(t.agentId, t.sessionId) : null;
        const asks = key ? permissions.filter((p) => sessionKey(p.agentId, p.sessionId) === key) : [];
        const agent = agents.find((a) => a.id === t.agentId);
        const st = taskStatusBadge(t, asks.length > 0);
        const time =
          t.startedAt && (t.status === "running" || t.endedAt) ? ` · ${clock((t.endedAt ?? now) - t.startedAt)}` : "";
        const sub = taskSubLine(t, leadBusy);
        const reassignedLine = formatReassigned(t.reassigned, memberNames);
        return (
          <div key={t.id} className="task-block">
            <button className="task" disabled={!key} onClick={() => key && onOpen(key)}>
              <span className={`task-avatar agent-${t.agentId}`}>{(agent?.name ?? t.agentId).charAt(0)}</span>
              <span className="task-main">
                <span className="task-title">{t.title}</span>
                <span className="task-sub" title={t.error ?? undefined}>
                  {t.memberName} · {sub}
                </span>
                {reassignedLine && (
                  <span className="task-sub task-reassigned" title={reassignedLine}>
                    {reassignedLine}
                  </span>
                )}
              </span>
              <span className={`task-status ${st.tone}`}>
                {t.status === "running" && asks.length === 0 && <span className="spinner" />}
                {st.label}
                {asks.length === 0 && time}
              </span>
              {key && <ChevronRight size={15} className="task-chev" />}
            </button>
            {/* While the lead is working it decides; the buttons are for what it leaves pending. */}
            {t.mergeState === "pending" && !leadBusy && (
              <div className="task-merge">
                <span className="grow mono ellipsis" title={t.changes.join("\n")}>
                  {t.changes.slice(0, 3).join(", ")}
                  {t.changes.length > 3 && ` 외 ${t.changes.length - 3}개`}
                </span>
                <button className="btn btn-primary small-btn" onClick={() => onMerge(t.id)}>
                  병합
                </button>
                <button className="btn small-btn" onClick={() => onDiscard(t.id)}>
                  버리기
                </button>
              </div>
            )}
            {t.mergeState === "conflict" && (
              <div className="task-merge conflict">
                <span className="grow mono ellipsis" title={t.conflicts.join("\n")}>
                  충돌: {t.conflicts.join(", ")}
                </span>
              </div>
            )}
            {asks.map((p) => (
              <div key={p.key} className="task-perm">
                <Lock size={13} aria-hidden />
                <span className="grow">
                  <b>{t.memberName}</b> 권한 요청 · <code>{p.toolCall?.title ?? "도구 실행"}</code>
                </span>
                {p.options.map((o) => (
                  <button
                    key={o.optionId}
                    className={o.kind.startsWith("allow") ? "btn btn-primary small-btn" : "btn small-btn"}
                    onClick={() => onPermission(p.key, o.optionId)}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
