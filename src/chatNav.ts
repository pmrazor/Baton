/** Lets components (e.g. command center) ask ConversationView to scroll to and flash a specific message. */
export interface RevealMessageRequest {
  sessionKey: string;
  itemId: string;
  /** Monotonic sequence so revealing the same message twice in a row still triggers. */
  seq: number;
}

type RevealListener = (req: RevealMessageRequest) => void;

const listeners = new Set<RevealListener>();
let pending: RevealMessageRequest | null = null;
let seq = 0;

export function requestRevealMessage(sessionKey: string, itemId: string): void {
  const req: RevealMessageRequest = { sessionKey, itemId, seq: ++seq };
  pending = req;
  for (const fn of [...listeners]) fn(req);
}

export function getPendingReveal(): RevealMessageRequest | null {
  return pending;
}

export function consumePendingReveal(expectedSeq: number): void {
  if (pending?.seq === expectedSeq) pending = null;
}

export function onRevealMessage(fn: RevealListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
