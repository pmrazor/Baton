import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toHubError } from "../../api";
import { extApi, type Registry, type RegistryEntry } from "../../extensions/api";
import {
  fetchRegistryOnceForHint,
  findSuggestedExtensionForPath,
  getCachedRegistry,
  loadRegistryUrl,
} from "../../extensions/catalog";
import {
  getInstalledExtensions,
  onExtensionsChanged,
  reloadExtensions,
} from "../../extensions/registry";
import { languageForPath } from "./codeHelpers";

const dismissedExtensionIds = new Set<string>();

/**
 * Small non-blocking editor hint when a file opens without syntax highlighting
 * and a registry extension matches its extension in `keywords`.
 */
export default function ExtensionHintBar({ path }: { path: string | null }) {
  const [, bump] = useState(0);
  const [registry, setRegistry] = useState<Registry | null>(() => getCachedRegistry());
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onExtensionsChanged(() => {
      setError(null);
      bump((n) => n + 1);
    });
  }, []);

  const currentLang = path ? languageForPath(path) : null;
  const needsLookup = !!path && currentLang === null;

  useEffect(() => {
    setError(null);
    if (!needsLookup) return;
    const cached = getCachedRegistry();
    if (cached) {
      setRegistry(cached);
      return;
    }
    let cancelled = false;
    void fetchRegistryOnceForHint().then((reg) => {
      if (!cancelled && reg) setRegistry(reg);
    });
    return () => {
      cancelled = true;
    };
  }, [needsLookup, path]);

  if (!path || currentLang !== null) return null;

  const suggestion: RegistryEntry | null = findSuggestedExtensionForPath(
    path,
    registry,
    getInstalledExtensions(),
  );
  if (!suggestion || dismissedExtensionIds.has(suggestion.id)) return null;

  const installing = installingId === suggestion.id;

  const handleInstall = async () => {
    setError(null);
    setInstallingId(suggestion.id);
    try {
      await extApi.install(loadRegistryUrl(), suggestion.id);
      await reloadExtensions();
    } catch (err) {
      setError(`설치하지 못했어요: ${toHubError(err).message}`);
    } finally {
      setInstallingId(null);
    }
  };

  const handleDismiss = () => {
    dismissedExtensionIds.add(suggestion.id);
    bump((n) => n + 1);
  };

  return (
    <div className="code-ext-hint-bar" role="status">
      <span className="code-ext-hint-text">
        {suggestion.name} 확장을 설치하면 색이 입혀져요
        {error && <span className="error-text"> · {error}</span>}
      </span>
      <div className="code-disk-bar-actions">
        <button
          type="button"
          className="code-bar-btn primary"
          disabled={installing}
          onClick={() => void handleInstall()}
        >
          {installing ? "설치 중…" : "설치"}
        </button>
        <button
          type="button"
          className="code-ext-hint-close"
          title="닫기"
          aria-label="닫기"
          onClick={handleDismiss}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
