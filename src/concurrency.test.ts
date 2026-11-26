import { describe, expect, it } from "vitest";
import { otherWorkInFolder } from "./concurrency";
import type { Session, TaskInfo } from "./types";

const sess = (key: string, extra: Partial<Session> = {}): Session =>
  ({ key, cwd: "/work/app", title: key, busy: false, draft: false, ...extra }) as Session;
const task = (extra: Partial<TaskInfo> = {}): TaskInfo =>
  ({ id: "t", status: "done", isolated: true, changes: [], mergeState: null, conflicts: [], ...extra }) as TaskInfo;
const keys = (l: Session[]) => l.map((s) => s.key);

describe("otherWorkInFolder", () => {
  const cur = sess("cur");
  it("finds a busy chat in the same folder", () => {
    expect(keys(otherWorkInFolder([cur, sess("a", { busy: true })], cur))).toEqual(["a"]);
  });
  it("finds a busy lead", () => {
    const lead = sess("l", { busy: true, lead: {} as Session["lead"] });
    expect(keys(otherWorkInFolder([lead], cur))).toEqual(["l"]);
  });
  it("finds an idle lead with an active task", () => {
    const lead = sess("l", { lead: {} as Session["lead"], tasks: [task({ status: "running" })] });
    expect(keys(otherWorkInFolder([lead], cur))).toEqual(["l"]);
  });
  it("ignores an idle lead whose results only await a merge decision", () => {
    const lead = sess("l", { lead: {} as Session["lead"], tasks: [task({ changes: ["M a"], mergeState: "pending" })] });
    expect(otherWorkInFolder([lead], cur)).toEqual([]);
  });
  it("ignores idle chats and finished leads", () => {
    const lead = sess("l", { lead: {} as Session["lead"], tasks: [task()] });
    expect(otherWorkInFolder([sess("a"), lead], cur)).toEqual([]);
  });
  it("ignores other folders", () => {
    expect(otherWorkInFolder([sess("a", { busy: true, cwd: "/work/other" })], cur)).toEqual([]);
  });
  it("ignores task chats, drafts and archived", () => {
    const list = [
      sess("t", { busy: true, parent: { key: "p", taskId: "1" } }),
      sess("d", { busy: true, draft: true }),
      sess("z", { busy: true, archived: true }),
    ];
    expect(otherWorkInFolder(list, cur)).toEqual([]);
  });
  it("normalizes trailing slashes and Windows case", () => {
    expect(keys(otherWorkInFolder([sess("a", { busy: true, cwd: "/work/app/" })], cur))).toEqual(["a"]);
    const win = sess("w", { cwd: "C:\\Work\\App" });
    expect(keys(otherWorkInFolder([sess("a", { busy: true, cwd: "c:/work/app\\" })], win))).toEqual(["a"]);
    expect(otherWorkInFolder([sess("a", { busy: true, cwd: "/WORK/app" })], cur)).toEqual([]);
  });
  it("excludes the current session", () => {
    expect(otherWorkInFolder([{ ...cur, busy: true }], cur)).toEqual([]);
  });
});
