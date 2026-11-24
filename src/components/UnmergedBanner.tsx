import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { UnmergedPatch } from "../types";

/** Work saved from worktrees that were cleaned up unmerged (`.baton/unmerged`). */
export default function UnmergedBanner({ workspace }: { workspace: string }) {
  const [patches, setPatches] = useState<UnmergedPatch[]>([]);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api
        .listUnmerged(workspace)
        .then(setPatches)
        .catch(() => setPatches([])),
    [workspace],
  );

  useEffect(() => {
    setResult(null);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const apply = async (file: string) => {
    try {
      const r = await api.applyUnmerged(workspace, file);
      setResult(
        r.applied
          ? `${file}: ${r.message}`
          : r.conflicts.length
            ? `${file}: ${r.conflicts.join(", ")} 파일에 충돌 표시가 남아 있어요. 직접 해결해 주세요.`
            : `${file}: 적용하지 못했어요. ${r.message}`,
      );
    } catch (e) {
      setResult(`${file}: ${e}`);
    }
    refresh();
  };

  const remove = async (file: string) => {
    if (!(await ask(`'${file}'을(를) 삭제할까요? 이 작업 내용은 되돌릴 수 없어요.`, { kind: "warning" }))) return;
    try {
      await api.deleteUnmerged(workspace, file);
      setResult(null);
    } catch (e) {
      setResult(`${file}: ${e}`);
    }
    refresh();
  };

  if (patches.length === 0 && !result) return null;
  return (
    <div className="auth-banner">
      <div>
        <b>병합하지 않은 작업 {patches.length}개가 남아 있어요</b>
        {result && <div className="muted small">{result}</div>}
      </div>
      {patches.length > 0 && (
        <div className="auth-actions">
          <button className="btn" onClick={() => setOpen(!open)}>
            {open ? "접기" : "펼치기"}
          </button>
        </div>
      )}
      {open &&
        patches.map((p) => (
          <div key={p.file} style={{ display: "flex", flexBasis: "100%", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span title={p.files.join("\n")}>{p.file}</span>
              <div className="muted small">
                파일 {p.files.length}개 · {new Date(p.modified).toLocaleString("ko-KR")}
              </div>
            </div>
            <div className="auth-actions">
              <button className="btn btn-primary" onClick={() => apply(p.file)}>
                적용
              </button>
              <button className="btn" onClick={() => remove(p.file)}>
                삭제
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
