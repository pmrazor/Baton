import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { findUpdate, formatVersion, installUpdate } from "../update";

interface Licenses {
  fonts: { name: string; license: string; text: string }[];
  packages: { name: string; version: string; license: string; url: string; source: "cargo" | "npm" }[];
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "found"; update: Update }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

export default function AboutPanel() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const [licenses, setLicenses] = useState<Licenses | null>(null);

  useEffect(() => {
    getVersion().then(setVersion);
    // ~120 KB of data; only load it when this tab opens.
    import("../assets/licenses.json").then((m) => setLicenses(m.default as Licenses));
  }, []);

  const runCheck = () => {
    setState({ kind: "checking" });
    findUpdate()
      .then((update) => setState(update ? { kind: "found", update } : { kind: "latest" }))
      .catch((e) => setState({ kind: "error", message: String(e) }));
  };

  const byLicense = new Map<string, Licenses["packages"]>();
  for (const p of licenses?.packages ?? []) {
    byLicense.set(p.license, [...(byLicense.get(p.license) ?? []), p]);
  }

  return (
    <div className="about">
      <div className="about-head">
        <div>
          <div className="about-name">Baton</div>
          <div className="muted small">
            {version ? `${formatVersion(version)} (${version})` : ""} · 여러 코딩 에이전트를 한곳에서
          </div>
        </div>
        <div className="about-update">
          {state.kind === "found" ? (
            <button
              className="btn btn-primary small-btn"
              onClick={() => {
                const update = state.update;
                setState({ kind: "installing", percent: null });
                installUpdate(update, (percent) => setState({ kind: "installing", percent })).catch((e) =>
                  setState({ kind: "error", message: String(e) }),
                );
              }}
            >
              {formatVersion(state.update.version)}로 업데이트
            </button>
          ) : (
            <button
              className="btn small-btn"
              disabled={state.kind === "checking" || state.kind === "installing"}
              onClick={runCheck}
            >
              업데이트 확인
            </button>
          )}
          <span className="muted small">
            {state.kind === "checking" && "확인 중…"}
            {state.kind === "latest" && "최신 버전이에요"}
            {state.kind === "installing" && (state.percent === null ? "내려받는 중…" : `내려받는 중 ${state.percent}%`)}
            {state.kind === "error" && <span className="error-text">확인하지 못했어요: {state.message}</span>}
          </span>
        </div>
      </div>
      <button className="link-btn" onClick={() => openUrl("https://github.com/pmrazor/Baton")}>
        github.com/pmrazor/Baton
      </button>

      <h3>오픈소스 라이선스</h3>
      <p className="muted small">Baton은 아래 오픈소스 소프트웨어와 폰트를 사용해요.</p>

      {licenses?.fonts.map((f) => (
        <details key={f.name} className="license-block">
          <summary>
            {f.name} <span className="muted small">· {f.license}</span>
          </summary>
          <pre className="code log">{f.text}</pre>
        </details>
      ))}

      {[...byLicense.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([license, pkgs]) => (
          <details key={license} className="license-block">
            <summary>
              {license} <span className="muted small">· 패키지 {pkgs.length}개</span>
            </summary>
            <ul className="license-pkgs">
              {pkgs.map((p) => (
                <li key={`${p.source}:${p.name}@${p.version}`}>
                  <button className="link-btn" onClick={() => /^https?:/.test(p.url) && openUrl(p.url)}>
                    {p.name}
                  </button>
                  <span className="muted small">
                    {p.version} · {p.source === "cargo" ? "Rust" : "npm"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
    </div>
  );
}
