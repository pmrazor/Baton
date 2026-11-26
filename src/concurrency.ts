import { isTaskActive, type Session } from "./types";

/** Normalize a folder path for comparison: no trailing separators; case-insensitive for Windows paths. */
function folderKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:[\\/]/.test(path) ? trimmed.replace(/\\/g, "/").toLowerCase() : trimmed;
}

/** Answering now, or a lead whose tasks are still running. Results waiting
 *  for a merge decision don't count: merging is a three-way merge the user
 *  starts, and counting them would keep the warning up for hours. */
function isWorking(s: Session): boolean {
  if (s.busy) return true;
  return !!s.lead && (s.tasks ?? []).some((t) => isTaskActive(t.status));
}

/** Other top-level conversations that are working in the same folder as `current` (they could overwrite each other's edits). */
export function otherWorkInFolder(sessions: Session[], current: Session): Session[] {
  if (!current.cwd) return [];
  const folder = folderKey(current.cwd);
  return sessions.filter(
    (s) =>
      !s.parent && !s.draft && !s.archived && s.key !== current.key && !!s.cwd && folderKey(s.cwd) === folder && isWorking(s),
  );
}
