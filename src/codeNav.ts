/** Lets deep components (chat messages) ask the app shell to show the code editor. */
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
