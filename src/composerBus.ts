// Lightweight event bus for attaching files and inserting code snippets into
// the chat composer.
//
// The composer isn't always mounted (pro mode's chat panel can be closed), so
// requests made meanwhile wait here and arrive when a composer next mounts.
// When multiple composers are mounted at once, deliveries go only to the most
// recently mounted one.

type AttachListener = (paths: string[]) => void;
type InsertListener = (text: string) => void;

let attachListeners: AttachListener[] = [];
let pendingAttach: string[] = [];

let insertListeners: InsertListener[] = [];
let pendingInsert: string[] = [];

/** Append `insertion` to an existing composer draft, separated by a blank line
 *  when the draft already has non-whitespace text. */
export function appendDraftText(current: string, insertion: string): string {
  if (!insertion) return current;
  if (current.trim().length === 0) return insertion;
  if (current.endsWith("\n\n")) return `${current}${insertion}`;
  if (current.endsWith("\n")) return `${current}\n${insertion}`;
  return `${current}\n\n${insertion}`;
}

export function attachToComposer(paths: string[]): void {
  if (paths.length === 0) return;
  const target = attachListeners[attachListeners.length - 1];
  if (!target) {
    pendingAttach = [...pendingAttach, ...paths.filter((p) => !pendingAttach.includes(p))];
    return;
  }
  target(paths);
}

export function onAttach(fn: AttachListener): () => void {
  attachListeners = [...attachListeners.filter((l) => l !== fn), fn];
  if (pendingAttach.length) {
    const waiting = pendingAttach;
    pendingAttach = [];
    fn(waiting);
  }
  return () => {
    attachListeners = attachListeners.filter((l) => l !== fn);
  };
}

export function insertIntoComposer(text: string): void {
  if (!text) return;
  const target = insertListeners[insertListeners.length - 1];
  if (!target) {
    pendingInsert = [...pendingInsert, text];
    return;
  }
  target(text);
}

export function onInsert(fn: InsertListener): () => void {
  insertListeners = [...insertListeners.filter((l) => l !== fn), fn];
  if (pendingInsert.length) {
    const waiting = pendingInsert;
    pendingInsert = [];
    for (const item of waiting) {
      fn(item);
    }
  }
  return () => {
    insertListeners = insertListeners.filter((l) => l !== fn);
  };
}

/** Clear all listeners and pending queues (intended for unit tests). */
export function resetComposerBus(): void {
  attachListeners = [];
  pendingAttach = [];
  insertListeners = [];
  pendingInsert = [];
}
