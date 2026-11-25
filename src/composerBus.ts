// Lightweight event bus for attaching workspace files to the chat composer.
//
// The composer isn't always mounted (pro mode's chat panel can be closed), so
// files attached meanwhile wait here and arrive when it next appears.

type AttachListener = (paths: string[]) => void;

const listeners = new Set<AttachListener>();
let pending: string[] = [];

export function attachToComposer(paths: string[]): void {
  if (paths.length === 0) return;
  if (listeners.size === 0) {
    pending = [...pending, ...paths.filter((p) => !pending.includes(p))];
    return;
  }
  for (const fn of listeners) {
    fn(paths);
  }
}

export function onAttach(fn: AttachListener): () => void {
  listeners.add(fn);
  if (pending.length) {
    const waiting = pending;
    pending = [];
    fn(waiting);
  }
  return () => {
    listeners.delete(fn);
  };
}
