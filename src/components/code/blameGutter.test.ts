import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  blameExtension,
  blameHunksEffect,
  blameLines,
  blameLabel,
  blameTooltip,
  formatBlameDate,
  formatRelativeTime,
} from "./blameGutter";
import type { BlameHunk } from "../../api";

const NOW = 1_800_000_000_000;
const ago = (secs: number) => NOW / 1000 - secs;

describe("formatRelativeTime", () => {
  it("uses Korean units", () => {
    expect(formatRelativeTime(ago(5), NOW)).toBe("방금");
    expect(formatRelativeTime(ago(-30), NOW)).toBe("방금");
    expect(formatRelativeTime(ago(60), NOW)).toBe("1분 전");
    expect(formatRelativeTime(ago(59 * 60), NOW)).toBe("59분 전");
    expect(formatRelativeTime(ago(3600), NOW)).toBe("1시간 전");
    expect(formatRelativeTime(ago(23 * 3600), NOW)).toBe("23시간 전");
    expect(formatRelativeTime(ago(3 * 86400), NOW)).toBe("3일 전");
    expect(formatRelativeTime(ago(29 * 86400), NOW)).toBe("29일 전");
    expect(formatRelativeTime(ago(30 * 86400), NOW)).toBe("1개월 전");
    expect(formatRelativeTime(ago(364 * 86400), NOW)).toBe("12개월 전");
    expect(formatRelativeTime(ago(365 * 86400), NOW)).toBe("1년 전");
    expect(formatRelativeTime(ago(800 * 86400), NOW)).toBe("2년 전");
  });
});

describe("formatBlameDate", () => {
  it("formats local YYYY-MM-DD HH:mm", () => {
    expect(formatBlameDate(Date.UTC(2025, 0, 2, 3, 4) / 1000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const local = new Date(2025, 0, 2, 3, 4).getTime() / 1000;
    expect(formatBlameDate(local)).toBe("2025-01-02 03:04");
  });
});

const hunk = (over: Partial<BlameHunk>): BlameHunk => ({
  startLine: 1,
  lineCount: 1,
  hash: "abcdef1234567890abcdef1234567890abcdef12",
  author: "PM.RAZOR",
  authorTime: ago(3 * 86400),
  summary: "fix thing",
  isUncommitted: false,
  ...over,
});

describe("labels", () => {
  it("shows author and relative time, or the uncommitted label", () => {
    expect(blameLabel(hunk({}), NOW)).toBe("PM.RAZOR · 3일 전");
    expect(blameLabel(hunk({ isUncommitted: true }), NOW)).toBe("아직 커밋 안 됨");
  });
  it("tooltip has short hash, author, date and summary", () => {
    const tip = blameTooltip(hunk({}));
    expect(tip).toContain("abcdef1 · PM.RAZOR · ");
    expect(tip.endsWith("\nfix thing")).toBe(true);
  });
});

describe("marker mapping through edits", () => {
  const base = () => {
    const state = EditorState.create({ doc: "a\nb\nc\nd\ne\n", extensions: [blameExtension()] });
    const hunks = [hunk({ startLine: 1, lineCount: 2 }), hunk({ startLine: 3, lineCount: 1, hash: "b".repeat(40) }), hunk({ startLine: 4, lineCount: 2, hash: "c".repeat(40) })];
    return state.update({ effects: blameHunksEffect(hunks, 1, state.doc) }).state;
  };

  it("puts a marker on each hunk's first line", () => {
    expect(blameLines(base())).toEqual([1, 3, 4]);
  });

  it("shifts markers when lines are inserted above", () => {
    const s = base();
    expect(blameLines(s.update({ changes: { from: 0, insert: "new\n" } }).state)).toEqual([2, 4, 5]);
  });

  it("keeps a line's marker when a new line is inserted at its start", () => {
    const s = base();
    const at = s.doc.line(3).from;
    expect(blameLines(s.update({ changes: { from: at, insert: "x\n" } }).state)).toEqual([1, 4, 5]);
  });

  it("collapses markers of deleted lines onto the surviving line's own marker", () => {
    const s = base();
    // delete lines 2-3 ("b\nc\n"): hunk 2's first line is gone; line "d" still belongs to hunk 3
    const from = s.doc.line(2).from;
    const to = s.doc.line(4).from;
    expect(blameLines(s.update({ changes: { from, to } }).state)).toEqual([1, 2]);
  });
});
