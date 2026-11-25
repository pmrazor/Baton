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

/** Display label for a terminal sub-tab: custom name when non-empty, otherwise "터미널 N". */
export function terminalLabel(n: number, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : `터미널 ${n}`;
}

export type TerminalBulkCloseAction = "others" | "left" | "right" | "all";

/** Pick the ordered terminal sub-tab ids to close for a bulk-close action. */
export function terminalTabsToClose(
  orderedIds: readonly string[],
  targetId: string,
  action: TerminalBulkCloseAction,
): string[] {
  switch (action) {
    case "all":
      return [...orderedIds];
    case "others":
      return orderedIds.includes(targetId)
        ? orderedIds.filter((id) => id !== targetId)
        : [];
    case "left": {
      const idx = orderedIds.indexOf(targetId);
      return idx > 0 ? orderedIds.slice(0, idx) : [];
    }
    case "right": {
      const idx = orderedIds.indexOf(targetId);
      return idx >= 0 && idx < orderedIds.length - 1 ? orderedIds.slice(idx + 1) : [];
    }
  }
}

/** Pick the next active terminal sub-tab after closing several tabs at once, reusing `tabAfterClose`. */
export function tabAfterBulkClose(
  ids: readonly string[],
  active: string | null,
  closing: Iterable<string>,
): string | null {
  const closingSet = new Set(closing);
  let remaining = [...ids];
  let current = active;
  for (const id of ids) {
    if (!closingSet.has(id)) continue;
    current = tabAfterClose(remaining, current, id);
    remaining = remaining.filter((item) => item !== id);
  }
  return current;
}

export type TerminalTabMenuActionId =
  | "close"
  | "closeOthers"
  | "closeLeft"
  | "closeRight"
  | "closeAll"
  | "rename"
  | "clear";

export interface TerminalTabMenuItem {
  id: TerminalTabMenuActionId;
  label: string;
  disabled?: boolean;
}

export interface TerminalTabMenuSection {
  id: string;
  items: TerminalTabMenuItem[];
}

/** Build the VS Code-style context menu sections for a terminal sub-tab. */
export function buildTerminalTabMenuSections(
  orderedIds: readonly string[],
  targetId: string,
): TerminalTabMenuSection[] {
  const hasOthers = terminalTabsToClose(orderedIds, targetId, "others").length > 0;
  const hasLeft = terminalTabsToClose(orderedIds, targetId, "left").length > 0;
  const hasRight = terminalTabsToClose(orderedIds, targetId, "right").length > 0;

  return [
    {
      id: "close",
      items: [
        { id: "close", label: "닫기" },
        { id: "closeOthers", label: "다른 터미널 모두 닫기", disabled: !hasOthers },
        { id: "closeLeft", label: "왼쪽 닫기", disabled: !hasLeft },
        { id: "closeRight", label: "오른쪽 닫기", disabled: !hasRight },
        { id: "closeAll", label: "모두 닫기", disabled: orderedIds.length === 0 },
      ],
    },
    {
      id: "terminal",
      items: [
        { id: "rename", label: "이름 바꾸기…" },
        { id: "clear", label: "지우기" },
      ],
    },
  ];
}
