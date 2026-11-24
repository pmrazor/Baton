// Pure bookkeeping for the 터미널 tab's sub-tabs, kept apart from xterm so it can be tested.

/** The backend id of a folder's terminal number `n`. */
export const terminalId = (cwd: string, n: number) => `${cwd}#${n}`;

/** The number in an id made by `terminalId` for `cwd`, or null if it isn't one. */
export function terminalNumber(id: string, cwd: string): number | null {
  const prefix = `${cwd}#`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return /^[1-9]\d*$/.test(rest) ? Number(rest) : null;
}

/** The number for a new tab. `last` is the highest handed out since the folder
 *  last had no tabs, so a closed number comes back only once all are closed. */
export function nextTabNumber(last: number, open: number[]): number {
  if (open.length === 0) return 1;
  return Math.max(last, ...open) + 1;
}

/** The tab to select after closing `closing`: the active one if it stays,
 *  otherwise its right neighbour, or the left one at the end. */
export function tabAfterClose(ids: string[], active: string | null, closing: string): string | null {
  const rest = ids.filter((id) => id !== closing);
  if (active !== closing && active !== null && rest.includes(active)) return active;
  const at = ids.indexOf(closing);
  if (rest.length === 0) return null;
  if (at < 0) return rest[0];
  return rest[Math.min(at, rest.length - 1)];
}
