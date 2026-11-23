import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { formatVersion, installUpdate } from "../update";

/** Offers a newer release found at startup. */
export default function UpdateBanner({ update, onDismiss }: { update: Update; onDismiss: () => void }) {
  const [progress, setProgress] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const installing = progress !== undefined;

  return (
    <div className="update-banner">
      <div className="grow">
        <b>새 버전 {formatVersion(update.version)}</b>이 있어요
        {update.body && <div className="muted small update-notes">{update.body}</div>}
        {error && <div className="error-text small">업데이트하지 못했어요: {error}</div>}
      </div>
      {installing ? (
        <span className="muted small">{progress === null ? "내려받는 중…" : `내려받는 중 ${progress}%`}</span>
      ) : (
        <>
          <button className="btn small-btn" onClick={onDismiss}>
            나중에
          </button>
          <button
            className="btn btn-primary small-btn"
            onClick={() => {
              setError(null);
              setProgress(null);
              installUpdate(update, setProgress).catch((e) => {
                setProgress(undefined);
                setError(String(e));
              });
            }}
          >
            업데이트 후 다시 시작
          </button>
        </>
      )}
    </div>
  );
}
