import type { HighlightRun } from "./fuzzy";
import type { Session } from "../types";

export interface MatchRange {
  start: number;
  end: number;
}

export interface ConversationHit {
  sessionKey: string;
  /** `null` when the hit matched the conversation title rather than a message item. */
  itemId: string | null;
  title: string;
  /** Basename of `session.cwd`. */
  workspace: string;
  updatedAt: number;
  /** True for delegated-task conversations (`session.parent` set). */
  isTask: boolean;
  snippet: string;
  /** Sorted, non-overlapping `[start, end)` highlight ranges within `snippet`. */
  matchRanges: MatchRange[];
}

export interface ConversationSearchGroup {
  sessionKey: string;
  title: string;
  workspace: string;
  updatedAt: number;
  isTask: boolean;
  /** Visible hits for this conversation (capped at `perSessionLimit`). */
  hits: ConversationHit[];
  /** Remaining hits in this conversation beyond `perSessionLimit`. */
  overflow: ConversationHit[];
  /** Number of additional hits hidden behind "N개 더" (`overflow.length`). */
  moreCount: number;
}

export interface ConversationSearchOptions {
  /** Maximum total visible hits returned across all conversations (default 200). */
  limit?: number;
  /** Maximum visible hits per conversation before collapsing into `moreCount` (default 5). */
  perSessionLimit?: number;
}

export interface ConversationSearchResult {
  /** Flat list of visible hits across matching conversations (capped at `limit`). */
  hits: ConversationHit[];
  /** Matching conversations ordered by `updatedAt` desc. */
  groups: ConversationSearchGroup[];
}

const DEFAULT_LIMIT = 200;
const DEFAULT_PER_SESSION_LIMIT = 5;
const SNIPPET_CONTEXT = 60;

function workspaceBasename(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractSnippetAndRanges(
  rawText: string,
  terms: readonly string[],
): { snippet: string; matchRanges: MatchRange[] } | null {
  const normalized = collapseWhitespace(rawText);
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  let firstMatchIdx = Infinity;
  let firstMatchEnd = 0;

  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx === -1) return null;
    if (idx < firstMatchIdx || (idx === firstMatchIdx && idx + term.length > firstMatchEnd)) {
      firstMatchIdx = idx;
      firstMatchEnd = idx + term.length;
    }
  }

  let start = Math.max(0, firstMatchIdx - SNIPPET_CONTEXT);
  let end = Math.min(normalized.length, firstMatchEnd + SNIPPET_CONTEXT);

  // Trim start to a word boundary without cutting into the first match.
  if (start > 0) {
    if (normalized[start - 1] !== " " && normalized[start] !== " ") {
      const nextSpace = normalized.indexOf(" ", start);
      if (nextSpace !== -1 && nextSpace < firstMatchIdx) {
        start = nextSpace + 1;
      }
    }
    while (start < firstMatchIdx && normalized[start] === " ") {
      start++;
    }
  }

  // Trim end to a word boundary without cutting into the first match.
  if (end < normalized.length) {
    if (normalized[end] !== " " && normalized[end - 1] !== " ") {
      const prevSpace = normalized.lastIndexOf(" ", end);
      if (prevSpace > firstMatchEnd) {
        end = prevSpace;
      }
    }
    while (end > firstMatchEnd && normalized[end - 1] === " ") {
      end--;
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  const body = normalized.slice(start, end);
  const snippet = `${prefix}${body}${suffix}`;

  const bodyLower = body.toLowerCase();
  const offset = prefix.length;
  const rawRanges: MatchRange[] = [];

  for (const term of terms) {
    let pos = 0;
    while (pos < bodyLower.length) {
      const found = bodyLower.indexOf(term, pos);
      if (found === -1) break;
      const rangeStart = Math.min(snippet.length, offset + found);
      const rangeEnd = Math.min(snippet.length, offset + found + term.length);
      if (rangeEnd > rangeStart) {
        rawRanges.push({ start: rangeStart, end: rangeEnd });
      }
      pos = found + Math.max(1, term.length);
    }
  }

  rawRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  const matchRanges: MatchRange[] = [];
  for (const range of rawRanges) {
    const prev = matchRanges[matchRanges.length - 1];
    if (prev && range.start <= prev.end) {
      prev.end = Math.max(prev.end, range.end);
    } else {
      matchRanges.push({ start: range.start, end: range.end });
    }
  }

  return { snippet, matchRanges };
}

/**
 * Search saved conversations by content (user, assistant, brief items) and title.
 *
 * Splits `query` on whitespace and requires ALL terms (case-insensitive) to appear
 * within the same message item (or within the title when no item matches).
 * Draft sessions are skipped. Results are ordered by `session.updatedAt` desc,
 * and within each session by item order.
 */
export function searchConversations(
  sessions: readonly Session[],
  query: string,
  options?: ConversationSearchOptions,
): ConversationSearchResult {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const perSessionLimit = options?.perSessionLimit ?? DEFAULT_PER_SESSION_LIMIT;
  if (limit <= 0 || perSessionLimit <= 0) return { hits: [], groups: [] };

  const rawTerms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (rawTerms.length === 0) return { hits: [], groups: [] };

  const terms = Array.from(new Set(rawTerms));

  const ordered = sessions.filter((s) => !s.draft).sort((a, b) => b.updatedAt - a.updatedAt);

  const hits: ConversationHit[] = [];
  const groups: ConversationSearchGroup[] = [];

  for (const session of ordered) {
    if (hits.length >= limit) break;

    const workspace = workspaceBasename(session.cwd);
    const isTask = Boolean(session.parent);
    const sessionHits: ConversationHit[] = [];

    for (const item of session.items) {
      if (item.kind !== "user" && item.kind !== "assistant" && item.kind !== "brief") continue;
      const match = extractSnippetAndRanges(item.text, terms);
      if (!match) continue;
      sessionHits.push({
        sessionKey: session.key,
        itemId: item.id,
        title: session.title,
        workspace,
        updatedAt: session.updatedAt,
        isTask,
        snippet: match.snippet,
        matchRanges: match.matchRanges,
      });
    }

    // Fall back to a title-only hit when no message item matched all words.
    if (sessionHits.length === 0) {
      const titleMatch = extractSnippetAndRanges(session.title, terms);
      if (titleMatch) {
        sessionHits.push({
          sessionKey: session.key,
          itemId: null,
          title: session.title,
          workspace,
          updatedAt: session.updatedAt,
          isTask,
          snippet: titleMatch.snippet,
          matchRanges: titleMatch.matchRanges,
        });
      }
    }

    if (sessionHits.length === 0) continue;

    const remaining = limit - hits.length;
    const visibleCap = Math.min(perSessionLimit, remaining);
    const visible = sessionHits.slice(0, visibleCap);
    const overflow = sessionHits.slice(visibleCap);

    hits.push(...visible);
    groups.push({
      sessionKey: session.key,
      title: session.title,
      workspace,
      updatedAt: session.updatedAt,
      isTask,
      hits: visible,
      overflow,
      moreCount: overflow.length,
    });
  }

  return { hits, groups };
}

/** Split `text` into contiguous plain and matched runs for highlighting `MatchRange[]`. */
export function highlightRanges(text: string, ranges: readonly MatchRange[]): HighlightRun[] {
  if (!text) return [];
  if (ranges.length === 0) return [{ text, match: false }];

  const runs: HighlightRun[] = [];
  let cursor = 0;
  for (const r of ranges) {
    const start = Math.max(cursor, Math.min(text.length, r.start));
    const end = Math.max(start, Math.min(text.length, r.end));
    if (start > cursor) {
      runs.push({ text: text.slice(cursor, start), match: false });
    }
    if (end > start) {
      runs.push({ text: text.slice(start, end), match: true });
      cursor = end;
    }
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor), match: false });
  }
  return runs;
}
