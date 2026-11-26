import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type GuideStatus } from "../api";

/** How long the "made" note stays up after 만들기. */
const NOTE_MS = 4000;

/** Successful status lookups, per folder, for this app run. */
const statusCache = new Map<string, GuideStatus>();
/** Folders the user closed with × during this app run. */
const closedFolders = new Set<string>();

/** Offer to create a project guide only for a lead, when the folder has none and the mode is still "ask". */
export function shouldShowGuideBanner(status: GuideStatus | null | undefined, isAgentMode: boolean): boolean {
  return isAgentMode && !!status && !status.exists && status.mode === "ask";
}

/** Never throws: a failed lookup resolves to null and is not cached. */
async function loadGuideStatus(folder: string): Promise<GuideStatus | null> {
  const cached = statusCache.get(folder);
  if (cached) return cached;
  try {
    const status = await api.guideStatus(folder);
    statusCache.set(folder, status);
    return status;
  } catch {
    return null;
  }
}

/** Offers to create the workspace's project guide (AGENTS.md) for agent-mode chats. */
export default function GuideBanner({ folder, isAgentMode }: { folder: string | null; isAgentMode: boolean }) {
  const [loaded, setLoaded] = useState<{ folder: string; status: GuideStatus } | null>(null);
  /** Folder whose "made" note is showing. */
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!folder) return;
    let alive = true;
    loadGuideStatus(folder).then((status) => {
      if (alive && status) setLoaded({ folder, status });
    });
    return () => {
      alive = false;
    };
  }, [folder]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  if (!folder) return null;

  if (note === folder) {
    return (
      <div className="auth-banner">
        <div className="muted small">다음에 총괄에게 보내는 메시지와 함께 만들어요</div>
      </div>
    );
  }

  const current = loaded?.folder === folder ? loaded.status : null;
  if (!current || closedFolders.has(folder) || !shouldShowGuideBanner(current, isAgentMode)) return null;

  const choose = async (mode: GuideStatus["mode"]) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setGuideMode(folder, mode);
    } catch {
      // Keep the banner so the user can try again.
      setBusy(false);
      return;
    }
    const next = { ...current, mode };
    statusCache.set(folder, next);
    setLoaded({ folder, status: next });
    setBusy(false);
    if (mode === "auto") setNote(folder);
  };

  const close = () => {
    closedFolders.add(folder);
    setLoaded(null);
  };

  return (
    <div className="auth-banner">
      <div>
        <b>이 폴더에는 프로젝트 안내서(AGENTS.md)가 없어요. 만들어 두면 팀원이 매번 프로젝트를 다시 살펴보지 않아서 토큰이 줄어요.</b>
      </div>
      <div className="auth-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => choose("auto")}>
          만들기
        </button>
        <button className="btn" disabled={busy} onClick={() => choose("off")}>
          이 폴더는 안 함
        </button>
        <button className="icon-btn sm" title="닫기" aria-label="닫기" onClick={close}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
