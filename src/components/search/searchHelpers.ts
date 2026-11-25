import type { SearchFileMatches, SearchOptions, SearchResult } from "../../api";

/** Typing searches automatically once the query is at least this long. */
export const AUTO_SEARCH_MIN_CHARS = 2;

/** Delay between the last keystroke and the automatic search. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Split a comma-separated glob list, keeping commas inside `{a,b}` groups. */
export function parseGlobList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((g) => g.trim()).filter((g) => g.length > 0);
}

/** Canonical form of a glob list, so `a,b` and ` a , b ` count as the same search. */
export function normalizeGlobList(raw: string): string {
  return parseGlobList(raw).join(", ");
}

export function shouldAutoSearch(query: string): boolean {
  return query.length >= AUTO_SEARCH_MIN_CHARS;
}

/** Identifies a search, so the same query and options aren't sent twice. */
export function searchKey(query: string, opts: SearchOptions): string {
  return JSON.stringify([
    query,
    opts.caseSensitive,
    opts.wholeWord,
    opts.regex,
    normalizeGlobList(opts.include),
    normalizeGlobList(opts.exclude),
  ]);
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Split preview text into plain and highlighted runs. Ranges may be unsorted or overlapping. */
export function highlightSegments(text: string, ranges: readonly (readonly [number, number])[]): HighlightSegment[] {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.min(s, text.length)), Math.max(0, Math.min(e, text.length))] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const segments: HighlightSegment[] = [];
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue;
    const start = Math.max(s, pos);
    const last = segments[segments.length - 1];
    if (start > pos) segments.push({ text: text.slice(pos, start), match: false });
    else if (last?.match) {
      // Overlapping or touching ranges join one highlighted run.
      last.text += text.slice(start, e);
      pos = e;
      continue;
    }
    segments.push({ text: text.slice(start, e), match: true });
    pos = e;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), match: false });
  return segments;
}

export function fileMatchCount(file: SearchFileMatches): number {
  return file.matches.reduce((n, m) => n + m.ranges.length, 0);
}

export function totalMatchCount(result: SearchResult): number {
  return result.files.reduce((n, f) => n + fileMatchCount(f), 0);
}

/** The summary line under the inputs. */
export function summaryText(result: SearchResult): string {
  if (result.truncated) return "결과가 많아 일부만 보여요";
  const total = totalMatchCount(result);
  if (total === 0) return "결과가 없어요";
  return `파일 ${result.files.length}개에서 ${total}개 찾음`;
}

/** Split a relative path into its file name and parent folder (`""` at the root). */
export function splitResultPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** ⌘⇧F on macOS, Ctrl+Shift+F elsewhere. */
export function isSearchShortcut(
  e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): boolean {
  if (!e.shiftKey || e.altKey) return false;
  const isF = e.key.toLowerCase() === "f" || e.code === "KeyF";
  if (!isF) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
