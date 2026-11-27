import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { toHubError } from "../api";
import {
  DEFAULT_REGISTRY_URL,
  extApi,
  type InstalledExtension,
  type Registry,
  type RegistryEntry,
} from "../extensions/api";
import {
  fetchRegistryCached,
  filterRegistryEntries,
  getCachedRegistry,
  isUpdateAvailable,
  loadRegistryUrl,
  saveRegistryUrl,
} from "../extensions/catalog";
import {
  getInstalledExtensions,
  onExtensionsChanged,
  reloadExtensions,
} from "../extensions/registry";

const KIND_LABELS: Record<string, string> = { languages: "언어", themes: "테마" };

function KindBadges({ kinds }: { kinds: string[] }) {
  return (
    <>
      {kinds
        .filter((k) => KIND_LABELS[k])
        .map((k) => (
          <span key={k} className="ext-kind-badge small">
            {KIND_LABELS[k]}
          </span>
        ))}
    </>
  );
}

function CreditLine({ author, license }: { author?: string; license?: string }) {
  const text = [author, license].filter(Boolean).join(" · ");
  return text ? <div className="muted small">{text}</div> : null;
}

function formatError(err: unknown): string {
  return toHubError(err).message;
}

/** Settings -> 확장 tab: browse registry, install/update, toggle, and uninstall extensions. */
export default function ExtensionsPanel() {
  const [registryUrl, setRegistryUrl] = useState<string>(loadRegistryUrl);
  const [registry, setRegistry] = useState<Registry | null>(() =>
    getCachedRegistry(loadRegistryUrl()),
  );
  const [installed, setInstalled] = useState<readonly InstalledExtension[]>(() =>
    getInstalledExtensions(),
  );
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [themeHintId, setThemeHintId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, "install" | "uninstall" | "toggle">>({});

  useEffect(() => {
    return onExtensionsChanged(() => {
      setInstalled([...getInstalledExtensions()]);
    });
  }, []);

  const fetchList = useCallback(async (url: string, force: boolean) => {
    const saved = saveRegistryUrl(url);
    setRegistryUrl(saved);
    setLoading(true);
    setLoadError(null);
    try {
      const reg = await fetchRegistryCached(saved, { force });
      setRegistry(reg);
      if (force) {
        await reloadExtensions().catch(() => undefined);
      }
    } catch (err) {
      setLoadError(`확장 목록을 불러오지 못했어요: ${formatError(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const currentUrl = loadRegistryUrl();
    if (!getCachedRegistry(currentUrl)) {
      void fetchList(currentUrl, false);
    }
  }, [fetchList]);

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledExtension>();
    for (const ext of installed) {
      map.set(ext.manifest.id, ext);
    }
    return map;
  }, [installed]);

  const registryById = useMemo(() => {
    const map = new Map<string, RegistryEntry>();
    for (const entry of registry?.extensions ?? []) {
      map.set(entry.id, entry);
    }
    return map;
  }, [registry]);

  const filteredRegistry = useMemo(
    () => filterRegistryEntries(registry?.extensions ?? [], query),
    [registry, query],
  );

  const filteredInstalled = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...installed];
    return installed.filter((ext) => {
      const m = ext.manifest;
      return (
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.description?.toLowerCase().includes(q) ?? false) ||
        (m.publisher?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [installed, query]);

  const setBusy = (id: string, kind: "install" | "uninstall" | "toggle" | null) => {
    setBusyIds((prev) => {
      const next = { ...prev };
      if (kind === null) delete next[id];
      else next[id] = kind;
      return next;
    });
  };

  const handleInstall = async (id: string) => {
    setActionError(null);
    setBusy(id, "install");
    try {
      const url = saveRegistryUrl(registryUrl);
      const done = await extApi.install(url, id);
      await reloadExtensions();
      setThemeHintId(Object.keys(done.manifest.contributes ?? {}).includes("themes") ? id : null);
    } catch (err) {
      setActionError(`확장을 설치하지 못했어요: ${formatError(err)}`);
    } finally {
      setBusy(id, null);
    }
  };

  const handleUninstall = async (id: string) => {
    setActionError(null);
    setBusy(id, "uninstall");
    try {
      await extApi.uninstall(id);
      await reloadExtensions();
    } catch (err) {
      setActionError(`확장을 삭제하지 못했어요: ${formatError(err)}`);
    } finally {
      setBusy(id, null);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    setActionError(null);
    setBusy(id, "toggle");
    try {
      await extApi.setEnabled(id, enabled);
      await reloadExtensions();
    } catch (err) {
      setActionError(`확장 상태를 바꾸지 못했어요: ${formatError(err)}`);
    } finally {
      setBusy(id, null);
    }
  };

  return (
    <div className="ext-panel">
      <div className="settings-head">
        <h3>확장</h3>
        <button
          type="button"
          className="btn small-btn"
          disabled={loading}
          onClick={() => void fetchList(registryUrl, true)}
        >
          <RefreshCw size={13} /> {loading ? "불러오는 중…" : "새로고침"}
        </button>
      </div>

      <form
        className="ext-url-form"
        onSubmit={(e) => {
          e.preventDefault();
          void fetchList(registryUrl, true);
        }}
      >
        <label className="ext-field-label" htmlFor="ext-registry-url">
          레지스트리 URL
        </label>
        <div className="name-input">
          <input
            id="ext-registry-url"
            type="text"
            value={registryUrl}
            placeholder={DEFAULT_REGISTRY_URL}
            onChange={(e) => setRegistryUrl(e.target.value)}
            onBlur={() => setRegistryUrl(saveRegistryUrl(registryUrl))}
          />
        </div>
      </form>

      <div className="ext-search">
        <Search size={14} className="ext-search-icon" />
        <input
          type="search"
          value={query}
          placeholder="확장 검색 (이름, 설명, 키워드…)"
          aria-label="확장 검색"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {actionError && <p className="error-text small">{actionError}</p>}

      {installed.length > 0 && (
        <>
          <h3>설치된 확장</h3>
          {filteredInstalled.length === 0 ? (
            <p className="muted small">검색 결과가 없어요.</p>
          ) : (
            <ul className="settings-agents ext-list">
              {filteredInstalled.map((ext) => {
                const { manifest } = ext;
                const regEntry = registryById.get(manifest.id);
                const canUpdate = regEntry
                  ? isUpdateAvailable(manifest.version, regEntry.version)
                  : false;
                const busy = busyIds[manifest.id];
                return (
                  <li key={manifest.id} className={ext.enabled ? undefined : "ext-disabled"}>
                    <div className="grow">
                      <div className="ext-title-row">
                        <span className="ext-name">{manifest.name}</span>
                        <span className="ext-version muted small">v{manifest.version}</span>
                        {manifest.publisher && (
                          <span className="muted small">· {manifest.publisher}</span>
                        )}
                        <KindBadges kinds={Object.keys(manifest.contributes ?? {})} />
                      </div>
                      {manifest.description && (
                        <div className="muted small">{manifest.description}</div>
                      )}
                      <CreditLine author={manifest.author} license={manifest.license} />
                    </div>
                    <div className="install-actions">
                      {canUpdate && regEntry && (
                        <button
                          type="button"
                          className="btn btn-primary small-btn"
                          disabled={!!busy}
                          onClick={() => void handleInstall(manifest.id)}
                        >
                          <Download size={13} />
                          {busy === "install"
                            ? "업데이트 중…"
                            : `업데이트 (${regEntry.version})`}
                        </button>
                      )}
                      <label className="ext-toggle small">
                        <input
                          type="checkbox"
                          checked={ext.enabled}
                          disabled={!!busy}
                          onChange={(e) => void handleToggle(manifest.id, e.target.checked)}
                        />
                        <span>{ext.enabled ? "사용" : "사용 안 함"}</span>
                      </label>
                      <button
                        type="button"
                        className="btn small-btn ext-delete-btn"
                        disabled={!!busy}
                        title="삭제"
                        onClick={() => void handleUninstall(manifest.id)}
                      >
                        <Trash2 size={13} /> {busy === "uninstall" ? "삭제 중…" : "삭제"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <h3>확장 목록</h3>
      {loading && !registry ? (
        <p className="muted small">확장 목록을 불러오는 중이에요…</p>
      ) : loadError ? (
        <p className="error-text small">{loadError}</p>
      ) : filteredRegistry.length === 0 ? (
        <p className="muted small">
          {query.trim() ? "검색 결과가 없어요." : "사용 가능한 확장이 없어요."}
        </p>
      ) : (
        <ul className="settings-agents ext-list">
          {filteredRegistry.map((entry) => {
            const inst = installedById.get(entry.id);
            const canUpdate = inst
              ? isUpdateAvailable(inst.manifest.version, entry.version)
              : false;
            const busy = busyIds[entry.id];
            return (
              <li key={entry.id}>
                <div className="grow">
                  <div className="ext-title-row">
                    <span className="ext-name">{entry.name}</span>
                    <span className="ext-version muted small">v{entry.version}</span>
                    {entry.publisher && (
                      <span className="muted small">· {entry.publisher}</span>
                    )}
                    <KindBadges kinds={entry.kinds} />
                  </div>
                  {entry.description && (
                    <div className="muted small">{entry.description}</div>
                  )}
                  <CreditLine author={entry.author} license={entry.license} />
                  {themeHintId === entry.id && inst && (
                    <div className="small">설정 → 화면에서 고를 수 있어요</div>
                  )}
                </div>
                <div className="install-actions">
                  {!inst ? (
                    <button
                      type="button"
                      className="btn btn-primary small-btn"
                      disabled={!!busy}
                      onClick={() => void handleInstall(entry.id)}
                    >
                      <Download size={13} />
                      {busy === "install" ? "설치 중…" : "설치"}
                    </button>
                  ) : canUpdate ? (
                    <button
                      type="button"
                      className="btn btn-primary small-btn"
                      disabled={!!busy}
                      onClick={() => void handleInstall(entry.id)}
                    >
                      <Download size={13} />
                      {busy === "install" ? "업데이트 중…" : `업데이트 (${entry.version})`}
                    </button>
                  ) : (
                    <button type="button" className="btn small-btn" disabled>
                      <Check size={13} />
                      설치됨
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
