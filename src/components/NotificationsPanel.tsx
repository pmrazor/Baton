import { useState } from "react";
import {
  loadNotifySettings,
  saveNotifySettings,
  type NoticeKind,
  type NotifySettings,
} from "../notify";

const KINDS: [NoticeKind, string, string][] = [
  ["turn", "응답 완료", "대화의 응답이 끝나거나 오류로 멈추면 알려 드려요"],
  ["permission", "권한 요청", "에이전트가 도구 실행 허락을 기다릴 때 알려 드려요"],
  ["task", "하위 작업 완료·실패", "팀원에게 맡긴 작업이 끝나거나 실패하면 알려 드려요"],
  ["limit", "한도 관련", "사용 한도로 작업이 다른 팀원에게 넘어가거나 총괄이 한도에 걸리면 알려 드려요"],
];

/** Desktop notification settings, saved per user in localStorage. */
export default function NotificationsPanel() {
  const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);

  const change = (patch: Partial<NotifySettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveNotifySettings(next);
  };

  return (
    <>
      <div className="settings-head">
        <h3>데스크톱 알림</h3>
      </div>
      <p className="muted small">
        Baton 창을 보고 있지 않을 때만 알려 드려요. 짧은 시간에 여러 건이 생기면 하나로 묶어서 보내요.
      </p>
      <ul className="settings-agents notify-list">
        <li>
          <label>
            <div className="grow">
              <div>알림 받기</div>
              <div className="muted small">끄면 아래 항목과 관계없이 알림을 보내지 않아요</div>
            </div>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          </label>
        </li>
        {KINDS.map(([kind, label, hint]) => (
          <li key={kind} className={settings.enabled ? undefined : "disabled"}>
            <label>
              <div className="grow">
                <div>{label}</div>
                <div className="muted small">{hint}</div>
              </div>
              <input
                type="checkbox"
                checked={settings[kind]}
                disabled={!settings.enabled}
                onChange={(e) => change({ [kind]: e.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
