import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  getGitBase,
  gitChangeGutter,
  gitGutterField,
  lineChanges,
  MAX_DIFF_LINES,
  setGitBase,
} from "./gitGutter";

describe("lineChanges", () => {
  it("returns empty changes for identical documents", () => {
    expect(lineChanges("", "")).toEqual({ added: [], modified: [], deletedAfter: [] });
    expect(lineChanges("hello", "hello")).toEqual({ added: [], modified: [], deletedAfter: [] });
    expect(lineChanges("a\nb\nc\n", "a\nb\nc\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [],
    });
  });

  it("handles pure additions at top, middle, bottom, and empty base (untracked)", () => {
    // Empty base (untracked file): all lines added
    expect(lineChanges("", "a\nb\nc\n")).toEqual({
      added: [1, 2, 3],
      modified: [],
      deletedAfter: [],
    });
    expect(lineChanges("", "only-one")).toEqual({
      added: [1],
      modified: [],
      deletedAfter: [],
    });

    // Add at top
    expect(lineChanges("b\nc\n", "a\nb\nc\n")).toEqual({
      added: [1],
      modified: [],
      deletedAfter: [],
    });

    // Add in middle
    expect(lineChanges("a\nd\n", "a\nb\nc\nd\n")).toEqual({
      added: [2, 3],
      modified: [],
      deletedAfter: [],
    });

    // Add at bottom (with and without trailing newline)
    expect(lineChanges("a\nb\n", "a\nb\nc\nd\n")).toEqual({
      added: [3, 4],
      modified: [],
      deletedAfter: [],
    });
    expect(lineChanges("a\nb", "a\nb\nc")).toEqual({
      added: [3],
      modified: [],
      deletedAfter: [],
    });
    expect(lineChanges("a\nb\n", "a\nb\nc")).toEqual({
      added: [3],
      modified: [],
      deletedAfter: [],
    });

    // Add blank line
    expect(lineChanges("a\nb\n", "a\nb\n\n")).toEqual({
      added: [3],
      modified: [],
      deletedAfter: [],
    });
  });

  it("handles pure deletions at top, middle, end, and full deletion", () => {
    // Delete at top -> deletedAfter: [0]
    expect(lineChanges("a\nb\nc\n", "b\nc\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [0],
    });
    expect(lineChanges("a\nb\nc\n", "c\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [0],
    });

    // Delete in middle -> line before the removed block
    expect(lineChanges("a\nb\nc\nd\n", "a\nd\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [1],
    });

    // Delete at end (with and without trailing newline)
    expect(lineChanges("a\nb\nc\n", "a\nb\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [2],
    });
    expect(lineChanges("a\nb\nc", "a\nb")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [2],
    });

    // Delete everything -> deletedAfter: [0]
    expect(lineChanges("a\nb\n", "")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [0],
    });

    // Delete both before and after a single surviving line
    expect(lineChanges("a\nb\nc\n", "b\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [0, 1],
    });
  });

  it("handles single-line and multi-line modifications", () => {
    // Single line modified
    expect(lineChanges("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      added: [],
      modified: [2],
      deletedAfter: [],
    });

    // Multi-line block modified (same length)
    expect(lineChanges("a\nb\nc\nd\n", "a\nB\nC\nd\n")).toEqual({
      added: [],
      modified: [2, 3],
      deletedAfter: [],
    });

    // 1 line replaced by 3 lines -> all 3 lines marked modified
    expect(lineChanges("a\nold\nz\n", "a\nnew1\nnew2\nnew3\nz\n")).toEqual({
      added: [],
      modified: [2, 3, 4],
      deletedAfter: [],
    });

    // 3 lines replaced by 1 line -> surviving line marked modified
    expect(lineChanges("a\nold1\nold2\nold3\nz\n", "a\nnew\nz\n")).toEqual({
      added: [],
      modified: [2],
      deletedAfter: [],
    });
  });

  it("handles mixed additions, modifications, and deletions in one file", () => {
    const base = [
      "removed-top",
      "keep-1",
      "old-line",
      "keep-2",
      "removed-mid-1",
      "removed-mid-2",
      "keep-3",
      "keep-4",
      "removed-end",
    ].join("\n");

    const current = [
      "keep-1",
      "new-line",
      "keep-2",
      "keep-3",
      "added-1",
      "added-2",
      "keep-4",
    ].join("\n");

    expect(lineChanges(base, current)).toEqual({
      added: [5, 6],
      modified: [2],
      deletedAfter: [0, 3, 7],
    });
  });

  it("normalizes CRLF and CR line endings so CRLF base vs LF doc does not mark everything changed", () => {
    const crlfBase = "line 1\r\nline 2\r\nline 3\r\n";
    const lfDoc = "line 1\nline 2\nline 3\n";
    expect(lineChanges(crlfBase, lfDoc)).toEqual({
      added: [],
      modified: [],
      deletedAfter: [],
    });

    const lfEdited = "line 1\nLINE 2\nline 3\nline 4\n";
    expect(lineChanges(crlfBase, lfEdited)).toEqual({
      added: [4],
      modified: [2],
      deletedAfter: [],
    });

    // Legacy CR-only line endings
    expect(lineChanges("a\rb\rc\r", "a\nb\nc\n")).toEqual({
      added: [],
      modified: [],
      deletedAfter: [],
    });
  });
});

describe("gitChangeGutter EditorState field", () => {
  function markerLines(state: EditorState): number[] {
    const field = state.field(gitGutterField);
    const lines: number[] = [];
    const iter = field.markers.iter();
    while (iter.value) {
      lines.push(state.doc.lineAt(iter.from).number);
      iter.next();
    }
    return lines;
  }

  it("tracks setGitBase, live edits, clearing with null, and untracked empty base", () => {
    let state = EditorState.create({
      doc: "a\nb\nc\n",
      extensions: [gitChangeGutter()],
    });

    // Initially no base -> no markers
    expect(getGitBase(state)).toBeNull();
    expect(markerLines(state)).toEqual([]);

    // Set base matching doc -> still no markers
    state = state.update({ effects: setGitBase.of("a\r\nb\r\nc\r\n") }).state;
    expect(getGitBase(state)).toBe("a\nb\nc\n");
    expect(markerLines(state)).toEqual([]);

    // Live edit on line 2 -> marker appears on line 2
    state = state.update({ changes: { from: 2, to: 3, insert: "B" } }).state;
    expect(markerLines(state)).toEqual([2]);

    // Clearing base (e.g. non-repo / binary) removes all markers
    state = state.update({ effects: setGitBase.of(null) }).state;
    expect(getGitBase(state)).toBeNull();
    expect(markerLines(state)).toEqual([]);

    // Untracked file (base === "") marks all logical lines as added
    state = state.update({ effects: setGitBase.of("") }).state;
    expect(markerLines(state)).toEqual([1, 2, 3]);
  });

  it("skips markers for files exceeding MAX_DIFF_LINES", () => {
    const lines = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `line ${i}`);
    const base = lines.join("\n");
    lines[10] = "changed";
    const doc = lines.join("\n");

    let state = EditorState.create({
      doc,
      extensions: [gitChangeGutter()],
    });
    state = state.update({ effects: setGitBase.of(base) }).state;
    expect(markerLines(state)).toEqual([]);
  });
});
