import {
  DEFAULT_REGISTRY_URL,
  extApi,
  type InstalledExtension,
  type Registry,
  type RegistryEntry,
} from "./api";

export const REGISTRY_URL_STORAGE_KEY = "baton.extensionRegistry";

let cachedUrl: string | null = null;
let cachedRegistry: Registry | null = null;
let inFlight: { url: string; promise: Promise<Registry> } | null = null;
const hintAttemptedUrls = new Set<string>();

/** Read the saved extension registry URL from localStorage, falling back to `DEFAULT_REGISTRY_URL`. */
export function loadRegistryUrl(): string {
  try {
    const raw = localStorage.getItem(REGISTRY_URL_STORAGE_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : DEFAULT_REGISTRY_URL;
  } catch {
    return DEFAULT_REGISTRY_URL;
  }
}

/** Save the extension registry URL to localStorage (empty string restores default). */
export function saveRegistryUrl(url: string): string {
  const normalized = url.trim() || DEFAULT_REGISTRY_URL;
  try {
    localStorage.setItem(REGISTRY_URL_STORAGE_KEY, normalized);
  } catch {
    // Storage may be unavailable.
  }
  return normalized;
}

/** Return the in-memory cached registry for `url` (if fetched this session). */
export function getCachedRegistry(url = loadRegistryUrl()): Registry | null {
  const target = url.trim() || DEFAULT_REGISTRY_URL;
  return cachedUrl === target ? cachedRegistry : null;
}

/**
 * Fetch the extension registry, caching the result for the session so we never
 * fetch more than once per app run unless `force: true` (e.g. 새로고침).
 */
export async function fetchRegistryCached(
  url = loadRegistryUrl(),
  opts: { force?: boolean } = {},
): Promise<Registry> {
  const target = url.trim() || DEFAULT_REGISTRY_URL;
  if (!opts.force && cachedRegistry && cachedUrl === target) {
    return cachedRegistry;
  }
  if (!opts.force && inFlight && inFlight.url === target) {
    return inFlight.promise;
  }

  if (opts.force) {
    hintAttemptedUrls.delete(target);
  }

  const promise = extApi
    .fetchRegistry(target)
    .then((reg) => {
      cachedUrl = target;
      cachedRegistry = reg;
      hintAttemptedUrls.add(target);
      return reg;
    })
    .finally(() => {
      if (inFlight?.promise === promise) {
        inFlight = null;
      }
    });

  inFlight = { url: target, promise };
  return promise;
}

/**
 * Fetch the registry at most once per app run for non-blocking editor hints.
 * Returns `null` silently on failure and will not retry until the user refreshes.
 */
export async function fetchRegistryOnceForHint(
  url = loadRegistryUrl(),
): Promise<Registry | null> {
  const target = url.trim() || DEFAULT_REGISTRY_URL;
  if (cachedRegistry && cachedUrl === target) return cachedRegistry;
  if (hintAttemptedUrls.has(target)) return null;
  hintAttemptedUrls.add(target);
  try {
    return await fetchRegistryCached(target);
  } catch {
    return null;
  }
}

/** Parse a `x.y.z` semver string into numeric `[major, minor, patch]` or `null` if invalid. */
export function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two `x.y.z` semver strings.
 * Returns `1` if `a > b`, `-1` if `a < b`, or `0` if equal (or unparseable).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** True when `registryVersion` is strictly newer than `installedVersion`. */
export function isUpdateAvailable(
  installedVersion: string,
  registryVersion: string,
): boolean {
  return compareSemver(registryVersion, installedVersion) > 0;
}

/** Filter registry entries by a free-text query across name, id, description, publisher, keywords. */
export function filterRegistryEntries(
  entries: readonly RegistryEntry[],
  query: string,
): RegistryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((entry) => {
    if (entry.name.toLowerCase().includes(q)) return true;
    if (entry.id.toLowerCase().includes(q)) return true;
    if (entry.description?.toLowerCase().includes(q)) return true;
    if (entry.publisher?.toLowerCase().includes(q)) return true;
    if (entry.keywords?.some((kw) => kw.toLowerCase().includes(q))) return true;
    return false;
  });
}

function baseNameOf(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/**
 * Find an uninstalled language extension in `registry` whose `keywords` match
 * the file's extension (e.g. `".go"`) or basename. Picks the longest extension match.
 */
export function findSuggestedExtensionForPath(
  path: string,
  registry: Registry | null,
  installed: readonly InstalledExtension[],
): RegistryEntry | null {
  if (!registry || !registry.extensions.length) return null;
  const base = baseNameOf(path).toLowerCase();
  if (!base) return null;

  const installedIds = new Set(installed.map((ext) => ext.manifest.id));
  let best: { entry: RegistryEntry; score: number } | null = null;

  for (const entry of registry.extensions) {
    if (installedIds.has(entry.id)) continue;
    if (!entry.keywords?.length) continue;

    for (const rawKw of entry.keywords) {
      const kw = rawKw.trim().toLowerCase();
      if (!kw) continue;
      if (kw === base) {
        const score = 10_000 + kw.length;
        if (!best || score > best.score) best = { entry, score };
      } else if (kw.startsWith(".") && base.length > kw.length && base.endsWith(kw)) {
        const score = kw.length;
        if (!best || score > best.score) best = { entry, score };
      }
    }
  }

  return best?.entry ?? null;
}

/** @internal Reset module-level session cache in tests. */
export function resetRegistryCacheForTests(): void {
  cachedUrl = null;
  cachedRegistry = null;
  inFlight = null;
  hintAttemptedUrls.clear();
}
