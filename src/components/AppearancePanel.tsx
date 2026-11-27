import { useEffect, useState } from "react";
import { getInstalledExtensions, onExtensionsChanged } from "../extensions/registry";
import {
  findTheme,
  getThemes,
  getThemeSettings,
  onThemeChanged,
  setThemeSetting,
  type ThemeEntry,
} from "../extensions/themes";

function Swatches({ entry }: { entry: ThemeEntry }) {
  const c = entry.theme.colors;
  const s = entry.theme.syntax;
  const colors = [c.bg, c.surface, c.text, c.accent, s?.keyword, s?.string];
  return (
    <span className="theme-swatches" aria-hidden>
      {colors.map((col, i) => (
        <span key={i} className="theme-swatch" style={col ? { background: col } : undefined} />
      ))}
    </span>
  );
}

function Picker({ scheme, label }: { scheme: "light" | "dark"; label: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const a = onThemeChanged(() => force((n) => n + 1));
    const b = onExtensionsChanged(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, []);
  const selected = getThemeSettings()[scheme];
  const themes = [...getThemes()].sort(
    (a, b) => Number(b.theme.type === scheme) - Number(a.theme.type === scheme) || a.theme.name.localeCompare(b.theme.name),
  );
  const current = findTheme(selected);
  const manifest = current ? getInstalledExtensions().find((e) => e.manifest.id === current.extId)?.manifest : undefined;
  const credit = [manifest?.author, manifest?.license].filter(Boolean).join(" · ");

  return (
    <section className="theme-picker">
      <h3>{label}</h3>
      <div className="theme-options" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={!current}
          className={`theme-option${!current ? " selected" : ""}`}
          onClick={() => setThemeSetting(scheme, null)}
        >
          <span>Baton 기본</span>
        </button>
        {themes.map((t) => (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={current?.key === t.key}
            className={`theme-option${current?.key === t.key ? " selected" : ""}`}
            onClick={() => setThemeSetting(scheme, t.key)}
          >
            <span>{t.theme.name}</span>
            <Swatches entry={t} />
          </button>
        ))}
      </div>
      {credit && <div className="muted small">{credit}</div>}
    </section>
  );
}

/** Settings -> 화면: pick a color theme for light and dark system appearance. */
export default function AppearancePanel() {
  const [count, setCount] = useState(getThemes().length);
  useEffect(() => onExtensionsChanged(() => setCount(getThemes().length)), []);
  return (
    <div className="appearance-panel">
      {count === 0 && <p className="muted small">설정 → 확장에서 테마를 설치할 수 있어요</p>}
      <Picker scheme="light" label="밝은 화면일 때" />
      <Picker scheme="dark" label="어두운 화면일 때" />
    </div>
  );
}
