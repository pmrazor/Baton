import { useEffect, useState } from "react";
import { ChevronRight, Lock } from "lucide-react";
import type { AgentInfo, PermissionRequest, TaskInfo, TaskStatus } from "../types";
import { isTaskActive, sessionKey } from "../types";

const STATUS: Record<TaskStatus, { label: string; tone: string }> = {
  queued: { label: "대기열", tone: "lock" },
  starting: { label: "시작 중", tone: "run" },
  waiting_lock: { label: "대기", tone: "lock" },
  running: { label: "실행 중", tone: "run" },
  done: { label: "완료", tone: "done" },
  failed: { label: "실패", tone: "fail" },
  cancelled: { label: "중단됨", tone: "lock" },
};

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
}

/** One line on where an isolated (worktree) task's changes stand. */
function mergeLine(t: TaskInfo, leadBusy: boolean): string | null {
  if (!t.isolated) return null;
  switch (t.mergeState) {
    case "pending":
      return `${t.changes.length}개 파일 변경 · ${leadBusy ? "병합 검토 중" : "병합 대기"}`;
    case "merged":
      return "워크스페이스에 병합됨";
    case "conflict":
      return `충돌 ${t.conflicts.length}개 · 워크스페이스에서 해결해 주세요`;
    case "discarded":
      return "변경을 버렸어요";
    case "none":
      return "바뀐 파일 없음";
    default:
      return "별도 작업 폴더에서 진행";
  }
}

/** The lead's delegation summary for one turn: one row per task. */
export default function TaskCard({ tasks, agents, permissions, onOpen, onPermission, onMerge, onDiscard, leadBusy }: Props) {
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
        const st = asks.length > 0 ? { label: "권한 요청", tone: "wait" } : STATUS[t.status];
        const time =
          t.startedAt && (t.status === "running" || t.endedAt) ? ` · ${clock((t.endedAt ?? now) - t.startedAt)}` : "";
        const sub =
          t.status === "waiting_lock"
            ? "다른 작업이 파일을 수정 중이라 기다려요"
            : t.status === "failed" && t.error
              ? t.error
              : (mergeLine(t, leadBusy) ?? (t.writes ? "파일 수정 작업" : "읽기 전용 작업"));
        return (
          <div key={t.id} className="task-block">
            <button className="task" disabled={!key} onClick={() => key && onOpen(key)}>
              <span className={`task-avatar agent-${t.agentId}`}>{(agent?.name ?? t.agentId).charAt(0)}</span>
              <span className="task-main">
                <span className="task-title">{t.title}</span>
                <span className="task-sub">
                  {t.memberName} · {sub}
                </span>
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
