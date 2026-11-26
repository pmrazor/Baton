import { useCallback, useContext, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { api, toHubError } from "../api";
import type { AgentInfo, PermissionRequest, TaskChanges, TaskInfo, Team } from "../types";
import { isTaskActive, sessionKey } from "../types";
import { commitFileLetter, LETTER_TITLE, letterTone } from "./git/gitHelpers";
import {
  canReviewChanges,
  formatReassigned,
  formatTaskUsage,
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
  /** Merge everything left, or only `files`. */
  onMerge: (taskId: string, files?: string[]) => Promise<unknown> | void;
  onDiscard: (taskId: string) => void;
  /** Show one file of a task's result commit (base → task) in the 코드 tab. */
  onOpenDiff?: (hash: string, path: string) => void;
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
  onOpenDiff,
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
        const usageLine = formatTaskUsage(t.usage);
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
                {usageLine && (
                  <span className="task-sub task-usage" title={usageLine.title}>
                    {usageLine.label}
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
            {t.mergeState === "conflict" && (
              <div className="task-merge conflict">
                <span className="grow mono ellipsis" title={t.conflicts.join("\n")}>
                  충돌: {t.conflicts.join(", ")}
                </span>
              </div>
            )}
            {canReviewChanges(t) && (
              <TaskReview task={t} leadBusy={leadBusy} onMerge={onMerge} onDiscard={onDiscard} onOpenDiff={onOpenDiff} />
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

/** Remount key for a task's file list: a merge or another turn changes what's left. */
function reviewStamp(t: TaskInfo): string {
  return `${t.endedAt ?? ""}|${t.merged?.length ?? 0}|${t.changes.join("\n")}`;
}

/**
 * A worktree task's unmerged files: merge all, merge the checked ones, or
 * discard the rest. Clicking a path shows its base → task diff.
 */
function TaskReview(p: {
  task: TaskInfo;
  leadBusy: boolean;
  onMerge: (taskId: string, files?: string[]) => Promise<unknown> | void;
  onDiscard: (taskId: string) => void;
  onOpenDiff?: (hash: string, path: string) => void;
}) {
  const { task: t, leadBusy } = p;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<TaskChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Paths the user unchecked; everything else is selected. */
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [merging, setMerging] = useState(false);
  const stamp = reviewStamp(t);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .taskChanges(t.id)
      .then((r) => alive && setList(r))
      .catch((e) => alive && setError(toHubError(e).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [t.id]);

  // Fetch on opening, and again when a merge or another turn changed what's left.
  useEffect(() => (open ? load() : undefined), [open, stamp, load]);

  const files = list?.files ?? [];
  const selected = files.filter((f) => !unchecked.has(f.path)).map((f) => f.path);
  const locked = leadBusy || merging;
  const lockedTitle = leadBusy ? "총괄이 작업 중이라 끝난 뒤에 고를 수 있어요" : undefined;

  const merge = async (only?: string[]) => {
    setMerging(true);
    try {
      await p.onMerge(t.id, only);
    } finally {
      setMerging(false);
    }
  };

  const toggle = (path: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <>
      <div className="task-merge">
        <button
          className="task-review-toggle"
          aria-expanded={open}
          title={open ? "변경 목록 닫기" : "바뀐 파일을 하나씩 보고 골라서 병합해요"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          변경 보기
        </button>
        <span className="grow mono ellipsis" title={t.changes.join("\n")}>
          {t.changes.slice(0, 3).join(", ")}
          {t.changes.length > 3 && ` 외 ${t.changes.length - 3}개`}
        </span>
        {open && list && (
          <button
            className="btn small-btn"
            disabled={locked || selected.length === 0}
            title={lockedTitle}
            onClick={() => merge(selected)}
          >
            선택한 파일 병합 ({selected.length})
          </button>
        )}
        <button className="btn btn-primary small-btn" disabled={locked} title={lockedTitle} onClick={() => merge()}>
          병합
        </button>
        <button className="btn small-btn" disabled={locked} title={lockedTitle} onClick={() => p.onDiscard(t.id)}>
          버리기
        </button>
      </div>
      {open && (
        <div className="task-files">
          {loading && !list && (
            <div className="task-files-note">
              <span className="spinner" /> 변경 목록을 불러오는 중…
            </div>
          )}
          {error && <div className="task-files-note error">{error}</div>}
          {list && files.length === 0 && !loading && <div className="task-files-note">남은 변경이 없어요</div>}
          {files.map((f) => {
            const letter = commitFileLetter(f.status);
            const checked = !unchecked.has(f.path);
            return (
              <div key={f.path} className="task-file">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  aria-label={`${f.path} 병합에 포함`}
                  onChange={() => toggle(f.path)}
                />
                <span className={`task-file-letter tone-${letterTone(letter)}`} title={LETTER_TITLE[letter]}>
                  {letter}
                </span>
                <button
                  className={`task-file-path mono ellipsis${letter === "D" ? " deleted" : ""}`}
                  title={`${f.path} · 바뀐 내용 보기`}
                  disabled={!p.onOpenDiff || !list}
                  onClick={() => list && p.onOpenDiff?.(list.result, f.path)}
                >
                  {f.path}
                </button>
              </div>
            );
          })}
          {loading && list && (
            <div className="task-files-note">
              <span className="spinner" /> 새로 고치는 중…
            </div>
          )}
        </div>
      )}
    </>
  );
}
