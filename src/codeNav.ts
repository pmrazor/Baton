import type { ProViewId } from "./components/proLayoutState";

/** Lets deep components (chat messages, command palette) ask the app shell to show the code editor. */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onOpenRequest(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function requestOpenCode(): void {
  for (const fn of [...listeners]) fn();
}

type ProViewListener = (id: ProViewId, mode: "toggle" | "open") => void;

const proViewListeners = new Set<ProViewListener>();
let pendingProView: ProViewId | null = null;

export function onProViewRequest(fn: ProViewListener): () => void {
  proViewListeners.add(fn);
  if (pendingProView) {
    const view = pendingProView;
    pendingProView = null;
    fn(view, "open");
  }
  return () => {
    proViewListeners.delete(fn);
  };
}

export function requestToggleProView(id: ProViewId): void {
  if (proViewListeners.size === 0) {
    pendingProView = id;
    return;
  }
  for (const fn of [...proViewListeners]) fn(id, "toggle");
}
