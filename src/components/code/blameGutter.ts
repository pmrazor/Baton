// Git blame gutter for the CodeMirror editor ("GitLens-lite"). The blame data
// lives in each tab's EditorState (a StateField), so it survives tab switches
// and follows unsaved edits: markers sit on the first line of each hunk and are
// mapped through every change.

import {
  Compartment,
  MapMode,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { BlameHunk } from "../../api";
import { openCommitDiff } from "./editorStore";

// ---- pure helpers -------------------------------------------------------

/** Korean relative time: 방금, N분 전, N시간 전, N일 전, N개월 전, N년 전. */
export function formatRelativeTime(unixSecs: number, nowMs: number = Date.now()): string {
  const diff = Math.floor(nowMs / 1000 - unixSecs);
  if (diff < 60) return "방금";
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

/** Local `YYYY-MM-DD HH:mm`. */
export function formatBlameDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const UNCOMMITTED_LABEL = "아직 커밋 안 됨";

export function blameLabel(hunk: BlameHunk, nowMs: number = Date.now()): string {
  if (hunk.isUncommitted) return UNCOMMITTED_LABEL;
  return `${hunk.author} · ${formatRelativeTime(hunk.authorTime, nowMs)}`;
}

export function blameTooltip(hunk: BlameHunk): string {
  if (hunk.isUncommitted) return UNCOMMITTED_LABEL;
  return `${hunk.hash.slice(0, 7)} · ${hunk.author} · ${formatBlameDate(hunk.authorTime)}\n${hunk.summary}`;
}

const BLAME_STORAGE_KEY = "baton.blame";

export function readBlamePref(): boolean {
  try {
    return localStorage.getItem(BLAME_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBlamePref(on: boolean): void {
  try {
    localStorage.setItem(BLAME_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable: the toggle just won't persist.
  }
}

// ---- editor state -------------------------------------------------------

class BlameMarker extends GutterMarker {
  constructor(readonly hunk: BlameHunk) {
    super();
    // Insertions at the line start push the marker along with its own text.
    this.startSide = this.endSide = 1;
    // Never drop a marker because text around it was deleted; collapsed ones are deduped in mapMarkers.
    this.mapMode = MapMode.Simple;
    this.elementClass = hunk.isUncommitted ? "cm-blame-first cm-blame-uncommitted" : "cm-blame-first";
  }

  eq(other: GutterMarker): boolean {
    return other instanceof BlameMarker && other.hunk === this.hunk;
  }

  toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-blame-text";
    el.textContent = blameLabel(this.hunk);
    el.title = blameTooltip(this.hunk);
    if (!this.hunk.isUncommitted) {
      el.dataset.hash = this.hunk.hash;
      el.classList.add("cm-blame-clickable");
    }
    return el;
  }
}

interface BlameConfig {
  enabled: boolean;
  root: string;
  path: string;
}

interface BlameHunksPayload {
  hunks: BlameHunk[];
  /** Tab mtime the blame was fetched for. */
  stamp: number;
  /** Document the hunks' line numbers refer to. */
  doc: Text;
}

const setConfigEffect = StateEffect.define<BlameConfig>();
const setHunksEffect = StateEffect.define<BlameHunksPayload>();

interface BlameState extends BlameConfig {
  stamp: number | null;
  markers: RangeSet<BlameMarker>;
}

function buildMarkers(hunks: BlameHunk[], doc: Text): RangeSet<BlameMarker> {
  const ranges = [];
  for (const h of hunks) {
    if (h.startLine < 1 || h.startLine > doc.lines) continue;
    ranges.push(new BlameMarker(h).range(doc.line(h.startLine).from));
  }
  return RangeSet.of(ranges, true);
}

/** After mapping, markers whose lines were deleted pile onto one line: keep the last (the surviving line's own hunk). */
function mapMarkers(markers: RangeSet<BlameMarker>, changes: Parameters<RangeSet<BlameMarker>["map"]>[0]): RangeSet<BlameMarker> {
  const mapped = markers.map(changes);
  const kept: { from: number; value: BlameMarker }[] = [];
  for (const cursor = mapped.iter(); cursor.value; cursor.next()) {
    const last = kept[kept.length - 1];
    if (last && last.from === cursor.from) kept.pop();
    kept.push({ from: cursor.from, value: cursor.value });
  }
  return kept.length === mapped.size ? mapped : RangeSet.of(kept.map((k) => k.value.range(k.from)), true);
}

export const blameField = StateField.define<BlameState>({
  create: () => ({ enabled: false, root: "", path: "", stamp: null, markers: RangeSet.empty }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.markers.size > 0) {
      next = { ...next, markers: mapMarkers(value.markers, tr.changes) };
    }
    for (const effect of tr.effects) {
      if (effect.is(setConfigEffect)) {
        next = { ...next, ...effect.value };
      } else if (effect.is(setHunksEffect)) {
        const { hunks, stamp, doc } = effect.value;
        next = { ...next, stamp, markers: buildMarkers(hunks, doc) };
      }
    }
    return next;
  },
});

const blameGutterExtension: Extension = gutter({
  class: "cm-blame-gutter",
  markers: (view) => view.state.field(blameField).markers,
  domEventHandlers: {
    mousedown(view, _line, event) {
      const target = event.target as HTMLElement | null;
      const hash = target?.closest<HTMLElement>("[data-hash]")?.dataset.hash;
      if (!hash) return false;
      const { root, path } = view.state.field(blameField);
      event.preventDefault();
      openCommitDiff(root, hash, path);
      return true;
    },
  },
});

const blameCompartment = new Compartment();

/** Put before `lineNumbers()` so the blame gutter sits to its left. */
export function blameExtension(): Extension {
  return [blameField, blameCompartment.of([])];
}

/** Show/hide the gutter and tell it which file it describes. Cheap when nothing changed. */
export function configureBlame(view: EditorView, config: BlameConfig): void {
  const cur = view.state.field(blameField, false);
  if (!cur) return;
  const unchanged = cur.enabled === config.enabled && cur.root === config.root && cur.path === config.path;
  if (unchanged) return;
  view.dispatch({
    effects: [
      setConfigEffect.of(config),
      ...(cur.enabled !== config.enabled
        ? [blameCompartment.reconfigure(config.enabled ? blameGutterExtension : [])]
        : []),
    ],
  });
}

/** `mtime` the loaded blame belongs to, or null when none was loaded. */
export function blameStamp(state: EditorState): number | null {
  return state.field(blameField, false)?.stamp ?? null;
}

/** Install hunks that were computed for `doc` (the text on disk) into the view's current state. */
export function applyBlameHunks(view: EditorView, hunks: BlameHunk[], stamp: number): void {
  view.dispatch({ effects: setHunksEffect.of({ hunks, stamp, doc: view.state.doc }) });
}

/** Effect form of `applyBlameHunks`, for dispatching without a view. */
export function blameHunksEffect(hunks: BlameHunk[], stamp: number, doc: Text): StateEffect<unknown> {
  return setHunksEffect.of({ hunks, stamp, doc });
}

/** 1-based lines that currently carry a blame label. */
export function blameLines(state: EditorState): number[] {
  const lines: number[] = [];
  for (const cursor = state.field(blameField).markers.iter(); cursor.value; cursor.next()) {
    lines.push(state.doc.lineAt(cursor.from).number);
  }
  return lines;
}
