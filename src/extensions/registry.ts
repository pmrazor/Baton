import { extApi, type InstalledExtension } from "./api";

export type Disposer = () => void;

export type ContributionHandler<T = unknown> = (
  extension: InstalledExtension,
  entries: T,
) => Disposer | void;

const handlers = new Map<string, ContributionHandler>();
const changeListeners = new Set<() => void>();

let installedExtensions: InstalledExtension[] = [];
let activeDisposers: Disposer[] = [];
let loadSeq = 0;

function runHandlerForExtension(
  ext: InstalledExtension,
  kind: string,
  handler: ContributionHandler,
): void {
  const contributes = ext.manifest?.contributes;
  if (!contributes || typeof contributes !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(contributes, kind)) return;
  const entries = contributes[kind];
  if (entries === undefined || entries === null) return;
  try {
    const dispose = handler(ext, entries);
    if (typeof dispose === "function") {
      activeDisposers.push(dispose);
    }
  } catch (err) {
    console.warn(
      `[extensions] failed to apply contribution "${kind}" from "${ext.manifest.id}":`,
      err,
    );
  }
}

function disposeAll(): void {
  const toDispose = activeDisposers;
  activeDisposers = [];
  for (const dispose of toDispose) {
    try {
      dispose();
    } catch (err) {
      console.warn("[extensions] error while disposing contribution:", err);
    }
  }
}

function emitChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[extensions] error in onExtensionsChanged listener:", err);
    }
  }
}

function applyExtensions(list: InstalledExtension[]): void {
  disposeAll();
  installedExtensions = list;
  for (const ext of list) {
    if (!ext.enabled) continue;
    const contributes = ext.manifest?.contributes;
    if (!contributes || typeof contributes !== "object") continue;
    for (const [kind, entries] of Object.entries(contributes)) {
      if (entries === undefined || entries === null) continue;
      const handler = handlers.get(kind);
      // Unknown contribution kinds are ignored so newer extensions stay compatible.
      if (!handler) continue;
      try {
        const dispose = handler(ext, entries);
        if (typeof dispose === "function") {
          activeDisposers.push(dispose);
        }
      } catch (err) {
        console.warn(
          `[extensions] failed to apply contribution "${kind}" from "${ext.manifest.id}":`,
          err,
        );
      }
    }
  }
  emitChanged();
}

/**
 * Register a handler for a contribution kind (e.g. "languages").
 * The handler receives `(extension, entries)` for each enabled extension that
 * declares that kind and may return a disposer called on reload/unload.
 */
export function registerContributionKind<T = unknown>(
  kind: string,
  handler: ContributionHandler<T>,
): () => void {
  const wrapped = handler as ContributionHandler;
  handlers.set(kind, wrapped);

  // If extensions were already loaded before this kind was registered, apply now.
  if (installedExtensions.length > 0) {
    let applied = false;
    for (const ext of installedExtensions) {
      if (!ext.enabled) continue;
      const before = activeDisposers.length;
      runHandlerForExtension(ext, kind, wrapped);
      if (activeDisposers.length !== before) applied = true;
    }
    if (applied) emitChanged();
  }

  return () => {
    if (handlers.get(kind) === wrapped) {
      handlers.delete(kind);
    }
  };
}

/** Load installed extensions from the backend and activate all enabled contributions. */
export async function loadInstalledExtensions(): Promise<InstalledExtension[]> {
  const seq = ++loadSeq;
  const list = await extApi.listInstalled();
  if (seq !== loadSeq) return installedExtensions;
  applyExtensions(list);
  return installedExtensions;
}

/** Dispose active contributions and reload installed extensions from the backend. */
export async function reloadExtensions(): Promise<InstalledExtension[]> {
  const seq = ++loadSeq;
  const list = await extApi.listInstalled();
  if (seq !== loadSeq) return installedExtensions;
  applyExtensions(list);
  return installedExtensions;
}

/** Return the last loaded list of installed extensions. */
export function getInstalledExtensions(): readonly InstalledExtension[] {
  return installedExtensions;
}

/** Subscribe to extension load/reload changes. Returns an unsubscribe function. */
export function onExtensionsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** @internal Test helper to clear loaded state and disposers without touching registered kinds. */
export function resetLoadedExtensionsForTests(): void {
  loadSeq++;
  disposeAll();
  installedExtensions = [];
}
