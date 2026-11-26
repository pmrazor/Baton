// VS Code-style git change gutter for normal CodeMirror 6 file tabs.
// Diffs a tab's git base text (`:path` / `HEAD:path`) against the live editor
// document and renders added (green), modified (accent), and deleted (red
// wedge) markers next to line numbers.

import { diff } from "@codemirror/merge";
import {
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";

/** Skip gutter diffing above this many lines to keep editing responsive on huge files. */
export const MAX_DIFF_LINES = 5000;

export interface LineChanges {
  /** 1-based line numbers in `current` that were added. */
  added: number[];
  /** 1-based line numbers in `current` that were modified. */
  modified: number[];
  /** 1-based line numbers in `current` after which lines were removed (`0` = top of file). */
  deletedAfter: number[];
}

export interface GitChangeGutterOptions {
  /** Called when the user clicks on a git change marker (1-based line number). */
  onMarkerClick?: (view: EditorView, line: number) => void;
}

/** Update the git base text for an editor state (`null` disables markers, `""` marks all lines added). */
export const setGitBase = StateEffect.define<string | null>();

function normalizeNewlines(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : text;
}

/** Split normalized text into logical lines (ignoring a single POSIX trailing newline). */
function toLogicalLines(normalized: string): string[] {
  if (normalized.length === 0) return [];
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.split("\n");
}

function countLines(normalized: string): number {
  if (normalized.length === 0) return 0;
  let count = 1;
  const end = normalized.endsWith("\n") ? normalized.length - 1 : normalized.length;
  for (let i = 0; i < end; i++) {
    if (normalized.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Compute 1-based added, modified, and deleted-after line positions between `base` and `current`.
 * Line endings (`\r\n`, `\r`, `\n`) are normalized before comparison.
 */
export function lineChanges(base: string, current: string): LineChanges {
  const normBase = normalizeNewlines(base);
  const normCurrent = normalizeNewlines(current);
  if (normBase === normCurrent) {
    return { added: [], modified: [], deletedAfter: [] };
  }

  const baseLines = toLogicalLines(normBase);
  const curLines = toLogicalLines(normCurrent);

  const added: number[] = [];
  const modified: number[] = [];
  const deletedAfter: number[] = [];

  if (baseLines.length === 0) {
    for (let i = 1; i <= curLines.length; i++) added.push(i);
    return { added, modified, deletedAfter };
  }
  if (curLines.length === 0) {
    return { added, modified, deletedAfter: [0] };
  }

  // Strip common prefix and suffix lines first so small edits in large files
  // only encode and diff the changed window.
  let prefix = 0;
  const minLen = Math.min(baseLines.length, curLines.length);
  while (prefix < minLen && baseLines[prefix] === curLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    baseLines[baseLines.length - 1 - suffix] === curLines[curLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const baseStart = prefix;
  const baseEnd = baseLines.length - suffix;
  const curStart = prefix;
  const curEnd = curLines.length - suffix;

  if (baseStart === baseEnd && curStart === curEnd) {
    return { added, modified, deletedAfter };
  }
  if (baseStart === baseEnd) {
    for (let i = curStart + 1; i <= curEnd; i++) added.push(i);
    return { added, modified, deletedAfter };
  }
  if (curStart === curEnd) {
    return { added, modified, deletedAfter: [curStart] };
  }

  // Encode each unique line in the changed window to a single non-surrogate
  // UTF-16 code unit so `@codemirror/merge`'s Myers `diff` runs directly on lines.
  const lineToCode = new Map<string, number>();
  let nextCode = 0;
  let overflow = false;

  const encodeSlice = (lines: string[], start: number, end: number): string => {
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const line = lines[i];
      let code = lineToCode.get(line);
      if (code === undefined) {
        if (nextCode === 0xd800) nextCode = 0xe000;
        if (nextCode > 0xffff) {
          overflow = true;
          return "";
        }
        code = nextCode++;
        lineToCode.set(line, code);
      }
      codes[i - start] = code;
    }
    // Build string in chunks to avoid call-stack limits with `String.fromCharCode(...codes)`.
    let out = "";
    const CHUNK = 8192;
    for (let i = 0; i < codes.length; i += CHUNK) {
      out += String.fromCharCode(...codes.slice(i, i + CHUNK));
    }
    return out;
  };

  const encodedA = encodeSlice(baseLines, baseStart, baseEnd);
  const encodedB = overflow ? "" : encodeSlice(curLines, curStart, curEnd);

  if (overflow) {
    for (let i = curStart + 1; i <= curEnd; i++) modified.push(i);
    return { added, modified, deletedAfter };
  }

  const changes = diff(encodedA, encodedB, { scanLimit: 500 });

  for (const ch of changes) {
    let fromA = baseStart + ch.fromA;
    let toA = baseStart + ch.toA;
    let fromB = curStart + ch.fromB;
    let toB = curStart + ch.toB;

    while (fromA < toA && fromB < toB && baseLines[fromA] === curLines[fromB]) {
      fromA++;
      fromB++;
    }
    while (fromA < toA && fromB < toB && baseLines[toA - 1] === curLines[toB - 1]) {
      toA--;
      toB--;
    }

    const lenA = toA - fromA;
    const lenB = toB - fromB;
    if (lenA === 0 && lenB === 0) continue;

    if (lenA === 0) {
      for (let line = fromB + 1; line <= toB; line++) {
        added.push(line);
      }
    } else if (lenB === 0) {
      if (deletedAfter[deletedAfter.length - 1] !== fromB) {
        deletedAfter.push(fromB);
      }
    } else {
      for (let line = fromB + 1; line <= toB; line++) {
        modified.push(line);
      }
    }
  }

  return { added, modified, deletedAfter };
}

type BarKind = "added" | "modified" | null;

class GitGutterMarker extends GutterMarker {
  readonly bar: BarKind;
  readonly deletedTop: boolean;
  readonly deletedBottom: boolean;

  constructor(bar: BarKind, deletedTop: boolean, deletedBottom: boolean) {
    super();
    this.bar = bar;
    this.deletedTop = deletedTop;
    this.deletedBottom = deletedBottom;
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof GitGutterMarker &&
      other.bar === this.bar &&
      other.deletedTop === this.deletedTop &&
      other.deletedBottom === this.deletedBottom
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-git-marker";
    wrap.title = markerTitle(this.bar, this.deletedTop || this.deletedBottom);

    if (this.bar === "added") {
      const bar = document.createElement("span");
      bar.className = "cm-git-bar cm-git-bar-added";
      wrap.appendChild(bar);
    } else if (this.bar === "modified") {
      const bar = document.createElement("span");
      bar.className = "cm-git-bar cm-git-bar-modified";
      wrap.appendChild(bar);
    }

    if (this.deletedTop) {
      const wedge = document.createElement("span");
      wedge.className = "cm-git-wedge cm-git-wedge-top";
      wrap.appendChild(wedge);
    }

    if (this.deletedBottom) {
      const wedge = document.createElement("span");
      wedge.className = "cm-git-wedge cm-git-wedge-bottom";
      wrap.appendChild(wedge);
    }

    return wrap;
  }
}

function markerTitle(bar: BarKind, hasDelete: boolean): string {
  if (bar === "added" && !hasDelete) return "추가된 줄 · 클릭해서 비교 보기";
  if (bar === "modified" && !hasDelete) return "수정된 줄 · 클릭해서 비교 보기";
  if (bar === null && hasDelete) return "삭제된 줄 · 클릭해서 비교 보기";
  return "변경된 줄 · 클릭해서 비교 보기";
}

const markerPool = new Map<string, GitGutterMarker>();

function getMarker(bar: BarKind, deletedTop: boolean, deletedBottom: boolean): GitGutterMarker {
  const key = `${bar ?? "n"}-${deletedTop ? 1 : 0}-${deletedBottom ? 1 : 0}`;
  let marker = markerPool.get(key);
  if (!marker) {
    marker = new GitGutterMarker(bar, deletedTop, deletedBottom);
    markerPool.set(key, marker);
  }
  return marker;
}

interface LineFlags {
  bar: BarKind;
  deletedTop: boolean;
  deletedBottom: boolean;
}

function buildMarkers(doc: Text, base: string | null, baseLines: number): RangeSet<GutterMarker> {
  if (base === null) return RangeSet.empty;
  if (doc.lines > MAX_DIFF_LINES || baseLines > MAX_DIFF_LINES) return RangeSet.empty;

  const { added, modified, deletedAfter } = lineChanges(base, doc.toString());
  if (added.length === 0 && modified.length === 0 && deletedAfter.length === 0) {
    return RangeSet.empty;
  }

  const byLine = new Map<number, LineFlags>();
  const ensure = (lineNo: number): LineFlags => {
    let flags = byLine.get(lineNo);
    if (!flags) {
      flags = { bar: null, deletedTop: false, deletedBottom: false };
      byLine.set(lineNo, flags);
    }
    return flags;
  };

  const maxLine = doc.lines;
  for (const lineNo of added) {
    if (lineNo >= 1 && lineNo <= maxLine) {
      ensure(lineNo).bar = "added";
    }
  }
  for (const lineNo of modified) {
    if (lineNo >= 1 && lineNo <= maxLine) {
      ensure(lineNo).bar = "modified";
    }
  }
  for (const afterLine of deletedAfter) {
    if (afterLine <= 0) {
      ensure(1).deletedTop = true;
    } else {
      ensure(Math.min(afterLine, maxLine)).deletedBottom = true;
    }
  }

  const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const lineNo of sortedLines) {
    const flags = byLine.get(lineNo)!;
    const pos = doc.line(lineNo).from;
    builder.add(pos, pos, getMarker(flags.bar, flags.deletedTop, flags.deletedBottom));
  }
  return builder.finish();
}

interface GitGutterState {
  base: string | null;
  baseLines: number;
  markers: RangeSet<GutterMarker>;
}

const EMPTY_GUTTER_STATE: GitGutterState = {
  base: null,
  baseLines: 0,
  markers: RangeSet.empty,
};

export const gitGutterField = StateField.define<GitGutterState>({
  create(): GitGutterState {
    return EMPTY_GUTTER_STATE;
  },
  update(value, tr): GitGutterState {
    let nextBase = value.base;
    let nextBaseLines = value.baseLines;
    let baseChanged = false;

    for (const effect of tr.effects) {
      if (effect.is(setGitBase)) {
        const normalized = effect.value === null ? null : normalizeNewlines(effect.value);
        if (normalized !== nextBase) {
          nextBase = normalized;
          nextBaseLines = normalized === null ? 0 : countLines(normalized);
          baseChanged = true;
        }
      }
    }

    if (!baseChanged && !tr.docChanged) {
      return value;
    }
    if (nextBase === null) {
      return value.base === null && value.markers.size === 0 ? value : EMPTY_GUTTER_STATE;
    }

    return {
      base: nextBase,
      baseLines: nextBaseLines,
      markers: buildMarkers(tr.state.doc, nextBase, nextBaseLines),
    };
  },
});

/** Read the normalized git base text currently stored in an `EditorState`. */
export function getGitBase(state: EditorState): string | null {
  return state.field(gitGutterField, false)?.base ?? null;
}

/** CodeMirror 6 extension displaying VS Code-style git change markers in the gutter. */
export function gitChangeGutter(options?: GitChangeGutterOptions): Extension {
  const onMarkerClick = options?.onMarkerClick;
  return [
    gitGutterField,
    Prec.low(
      gutter({
        class: "cm-gitGutter",
        markers: (view) => view.state.field(gitGutterField, false)?.markers ?? RangeSet.empty,
        domEventHandlers: onMarkerClick
          ? {
              click(view, line, event) {
                const target = event.target as HTMLElement | null;
                if (!target?.closest(".cm-git-marker")) return false;
                const lineNo = view.state.doc.lineAt(line.from).number;
                onMarkerClick(view, lineNo);
                return true;
              },
            }
          : undefined,
      }),
    ),
  ];
}
