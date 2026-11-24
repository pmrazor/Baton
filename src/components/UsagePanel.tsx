import type { ReactNode } from "react";
import type { AccountUsage, AgentCommand, AuthStatus, QuotaEntry, Session } from "../types";
import { Popover } from "./Popover";

export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function fmtReset(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `${time} 초기화` : `${d.getMonth() + 1}/${d.getDate()} ${time} 초기화`;
}

const STATUS_LABEL: Record<QuotaEntry["status"], string> = {
  ok: "정상",
  warning: "주의",
  limited: "한도 도달",
};

interface Props {
  session: Session | null;
  agentName: string;
  account: AccountUsage | null;
  identity?: AuthStatus;
  commands?: AgentCommand[];
}

/** Past this share of the context window, warn that compaction is near. */
const CONTEXT_WARN = 0.8;

/** Context ring in the composer; click for session + account usage. */
export default function UsageButton({ session, agentName, account, identity, commands }: Props) {
  const u = session?.usage;
  const ratio = u && u.size > 0 ? Math.min(1, u.used / u.size) : 0;
  const entries = Object.values(account?.entries ?? {});
  const warn = entries.some((e) => e.status !== "ok");

  return (
    <Popover
      align="right"
      button={({ toggle }) => (
        <button className="context-ring" onClick={toggle} title="사용량">
          <Ring ratio={ratio} tone={ratio > 0.8 || warn ? "high" : ""} />
          {warn && <span className="ring-alert" />}
        </button>
      )}
    >
      {() => (
        <div className="usage-card">
          <section>
            <div className="usage-head">이 대화</div>
            <Row label="컨텍스트">
              {u && u.size > 0 ? (
                <>
                  <Bar percent={ratio * 100} />
                  <span>
                    {fmtTokens(u.used)} / {fmtTokens(u.size)}
                  </span>
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
            {ratio >= CONTEXT_WARN && (
              <div className="context-warn">
                컨텍스트가 {Math.round(ratio * 100)}% 찼어요. 더 차면 에이전트가 앞부분을 자동으로 요약해요.
                {commands?.some((c) => c.name === "compact") && (
                  <>
                    {" "}
                    지금 정리하려면 입력창에 <code>/compact</code>를 보내세요.
                  </>
                )}
              </div>
            )}
            {session?.lastTurn && (
              <Row label="마지막 응답">
                <span>
                  {(session.lastTurn.durationMs / 1000).toFixed(1)}s
                  {session.lastTurn.outputTokens !== undefined &&
                    ` · 입력 ${fmtTokens(session.lastTurn.inputTokens ?? 0)} · 출력 ${fmtTokens(session.lastTurn.outputTokens)}`}
                </span>
              </Row>
            )}
            {u?.cost && (
              <Row label="예상 비용">
                <span title="에이전트가 API 단가로 환산한 값이에요. 구독 요금과는 달라요.">
                  ≈ {u.cost.currency === "USD" ? "$" : `${u.cost.currency} `}
                  {u.cost.amount.toFixed(2)}
                </span>
              </Row>
            )}
          </section>

          <section>
            <div className="usage-head">{agentName} 계정</div>
            {identity?.account?.email && (
              <p className="muted small identity">
                {identity.account.email}
                {identity.label ? ` · ${identity.label}` : ""}
              </p>
            )}
            {entries.length === 0 ? (
              <p className="muted small">
                {account === null
                  ? "아직 받은 계정 사용량이 없어요. 이 에이전트가 지원하면 응답 후에 표시돼요."
                  : "표시할 한도 정보가 없어요."}
              </p>
            ) : (
              entries.map((e) => (
                <div key={e.id} className="quota">
                  <div className="quota-line">
                    <span>{e.label}</span>
                    <span className={`quota-status ${e.status}`}>{STATUS_LABEL[e.status]}</span>
                  </div>
                  {e.utilization !== undefined && <Bar percent={e.utilization} />}
                  <div className="muted small">
                    {[
                      e.utilization !== undefined ? `${Math.round(e.utilization)}% 사용` : null,
                      e.resetsAt ? fmtReset(e.resetsAt) : null,
                      e.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="usage-row">
      <span className="muted">{label}</span>
      <span className="usage-value">{children}</span>
    </div>
  );
}

function Bar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span className="bar">
      <span className={`bar-fill ${p > 80 ? "high" : ""}`} style={{ width: `${p}%` }} />
    </span>
  );
}

function Ring({ ratio, tone }: { ratio: number; tone: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-label={`컨텍스트 ${Math.round(ratio * 100)}%`}>
      <circle cx="9" cy="9" r={r} className="ring-track" />
      <circle
        cx="9"
        cy="9"
        r={r}
        className={`ring-fill ${tone}`}
        // Keep a sliver visible so a near-empty ring still reads as "in use".
        strokeDasharray={`${ratio > 0 ? Math.max(1.5, c * ratio) : 0} ${c}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}
