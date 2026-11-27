export interface FuzzyMatch {
  score: number;
  /** Sorted character indices inside the target text that matched the query. */
  indices: number[];
}

export interface RankedItem<T> {
  item: T;
  score: number;
  indices: number[];
}

export interface RankOptions<T> {
  /** Maximum number of items returned (defaults to 50). */
  limit?: number;
  /** Optional fallback text (e.g. category + keywords) searched when primary text does not match. */
  getSecondaryText?: (item: T) => string | undefined;
  /** Tie-breaker when two items have the same score (or when query is empty). */
  tieBreaker?: (a: T, b: T) => number;
}

export interface HighlightRun {
  text: string;
  match: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_DP_TEXT_LEN = 512;
const NEG_INF = -1e9;

const BONUS_CONSECUTIVE = 16;
const BONUS_START = 14;
const BONUS_PATH_SEP = 15;
const BONUS_WORD_BOUNDARY = 12;
const BONUS_CAMEL = 10;
const BONUS_BASENAME = 12;
const BONUS_EXACT_BASENAME = 40;
const BONUS_PREFIX_BASENAME = 20;
const BONUS_PREFIX_TEXT = 10;
const PENALTY_GAP = 1;
const PENALTY_LENGTH = 0.05;
const PENALTY_SECONDARY = 25;

function isWordBoundaryChar(ch: string): boolean {
  return ch === "-" || ch === "_" || ch === "." || ch === " " || ch === ":" || ch === "(" || ch === "[";
}

function isUpperAscii(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLowerAscii(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function charBonus(text: string, index: number, hasSlash: boolean, baseStart: number): number {
  let bonus = 0;
  if (index === 0) {
    bonus += BONUS_START;
  } else {
    const prev = text[index - 1];
    if (prev === "/" || prev === "\\") {
      bonus += BONUS_PATH_SEP;
    } else if (isWordBoundaryChar(prev)) {
      bonus += BONUS_WORD_BOUNDARY;
    } else if (isUpperAscii(text[index]) && isLowerAscii(prev)) {
      bonus += BONUS_CAMEL;
    }
  }
  if (hasSlash && index >= baseStart) {
    bonus += BONUS_BASENAME;
  }
  return bonus;
}

/**
 * Case-insensitive subsequence fuzzy match.
 * Prefers basename matches, consecutive runs, and word/path-segment starts.
 * Returns `null` when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (text.length === 0 || query.length > text.length) return null;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const qLen = q.length;
  const tLen = t.length;

  // Fast linear rejection before running DP.
  let qi = 0;
  for (let ti = 0; ti < tLen && qi < qLen; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi < qLen) return null;

  const lastSlash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const hasSlash = lastSlash >= 0;
  const baseStart = lastSlash + 1;

  let indices: number[];
  let rawScore: number;

  if (tLen > MAX_DP_TEXT_LEN) {
    // Greedy fallback for unusually long strings so memory stays bounded.
    indices = [];
    rawScore = 0;
    let prevIdx = -1;
    let pos = 0;
    for (let i = 0; i < qLen; i++) {
      const idx = t.indexOf(q[i], pos);
      indices.push(idx);
      rawScore += charBonus(text, idx, hasSlash, baseStart);
      if (prevIdx >= 0) {
        rawScore += idx === prevIdx + 1 ? BONUS_CONSECUTIVE : -PENALTY_GAP * (idx - prevIdx - 1);
      }
      prevIdx = idx;
      pos = idx + 1;
    }
  } else {
    const bonuses = new Float64Array(tLen);
    for (let j = 0; j < tLen; j++) {
      bonuses[j] = charBonus(text, j, hasSlash, baseStart);
    }

    let prevMatch = new Float64Array(tLen);
    let curMatch = new Float64Array(tLen);
    const parent = new Int32Array(qLen * tLen);
    parent.fill(-1);

    // Row 0: align q[0] with any matching position j.
    for (let j = 0; j < tLen; j++) {
      if (t[j] === q[0]) {
        const offsetFromAnchor = hasSlash && j >= baseStart ? j - baseStart : j;
        prevMatch[j] = bonuses[j] - offsetFromAnchor * 0.1;
      } else {
        prevMatch[j] = NEG_INF;
      }
    }

    for (let i = 1; i < qLen; i++) {
      curMatch.fill(NEG_INF);
      let bestGap = NEG_INF;
      let bestGapIdx = -1;
      const rowOffset = i * tLen;
      const qCh = q[i];

      for (let j = i; j < tLen; j++) {
        // Decay prior non-consecutive candidates by one gap step, then admit k = j - 2.
        if (bestGap > NEG_INF / 2) {
          bestGap -= PENALTY_GAP;
        }
        if (j >= 2) {
          const prevNonConsec = prevMatch[j - 2];
          if (prevNonConsec > NEG_INF / 2) {
            const cand = prevNonConsec - PENALTY_GAP;
            if (cand > bestGap) {
              bestGap = cand;
              bestGapIdx = j - 2;
            }
          }
        }

        if (t[j] !== qCh) continue;

        let bestPrev = bestGap;
        let bestPrevIdx = bestGapIdx;
        const prevConsec = prevMatch[j - 1];
        if (prevConsec > NEG_INF / 2) {
          const consecScore = prevConsec + BONUS_CONSECUTIVE;
          if (consecScore >= bestPrev) {
            bestPrev = consecScore;
            bestPrevIdx = j - 1;
          }
        }

        if (bestPrev > NEG_INF / 2) {
          curMatch[j] = bestPrev + bonuses[j];
          parent[rowOffset + j] = bestPrevIdx;
        }
      }

      const tmp = prevMatch;
      prevMatch = curMatch;
      curMatch = tmp;
    }

    let bestEnd = -1;
    rawScore = NEG_INF;
    for (let j = qLen - 1; j < tLen; j++) {
      if (prevMatch[j] > rawScore) {
        rawScore = prevMatch[j];
        bestEnd = j;
      }
    }

    indices = new Array<number>(qLen);
    let cur = bestEnd;
    for (let i = qLen - 1; i >= 0; i--) {
      indices[i] = cur;
      cur = parent[i * tLen + cur];
    }
  }

  // Tie-breaking bonuses for exact/prefix matches and shorter targets.
  const baseLower = t.slice(baseStart);
  if (baseLower === q) {
    rawScore += BONUS_EXACT_BASENAME;
  } else if (baseLower.startsWith(q)) {
    rawScore += BONUS_PREFIX_BASENAME;
  }
  if (t.startsWith(q)) {
    rawScore += BONUS_PREFIX_TEXT;
  }
  rawScore -= tLen * PENALTY_LENGTH;

  return { score: rawScore, indices };
}

/**
 * Filter and rank `items` against `query` using `fuzzyScore`, returning up to `limit` results (default 50).
 */
export function rankItems<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  options?: RankOptions<T>,
): RankedItem<T>[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];
  const trimmed = query.trim();
  const tieBreaker = options?.tieBreaker;

  if (trimmed.length === 0) {
    const ordered = tieBreaker ? [...items].sort(tieBreaker) : items;
    return ordered.slice(0, limit).map((item) => ({ item, score: 0, indices: [] }));
  }

  const getSecondaryText = options?.getSecondaryText;
  const scored: { item: T; score: number; indices: number[]; order: number }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const primary = fuzzyScore(trimmed, getText(item));
    if (primary) {
      scored.push({ item, score: primary.score, indices: primary.indices, order: i });
      continue;
    }
    if (getSecondaryText) {
      const extra = getSecondaryText(item);
      if (extra) {
        const secondary = fuzzyScore(trimmed, extra);
        if (secondary) {
          scored.push({ item, score: secondary.score - PENALTY_SECONDARY, indices: [], order: i });
        }
      }
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (tieBreaker) {
      const tb = tieBreaker(a.item, b.item);
      if (tb !== 0) return tb;
    }
    return a.order - b.order;
  });

  return scored.slice(0, limit).map(({ item, score, indices }) => ({ item, score, indices }));
}

/** Split `text` into contiguous plain and matched runs for highlighting. */
export function highlightIndices(text: string, indices: readonly number[]): HighlightRun[] {
  if (!text) return [];
  if (indices.length === 0) return [{ text, match: false }];

  const runs: HighlightRun[] = [];
  const matched = new Set(indices);
  let start = 0;
  let curMatch = matched.has(0);

  for (let i = 1; i < text.length; i++) {
    const m = matched.has(i);
    if (m !== curMatch) {
      runs.push({ text: text.slice(start, i), match: curMatch });
      start = i;
      curMatch = m;
    }
  }
  runs.push({ text: text.slice(start), match: curMatch });
  return runs;
}

/** Split a `/`-separated relative path and its full-path match indices into basename and directory parts. */
export function splitPathMatch(
  path: string,
  indices: readonly number[],
): { name: string; nameIndices: number[]; dir: string; dirIndices: number[] } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) {
    return { name: path, nameIndices: [...indices], dir: "", dirIndices: [] };
  }
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const dirIndices: number[] = [];
  const nameIndices: number[] = [];
  for (const idx of indices) {
    if (idx < slash) dirIndices.push(idx);
    else if (idx > slash) nameIndices.push(idx - slash - 1);
  }
  return { name, nameIndices, dir, dirIndices };
}
