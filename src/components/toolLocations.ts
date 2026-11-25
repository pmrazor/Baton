import { relativeToRoot } from "./code/codeHelpers";

/** `path:line` label for a tool-call location. */
export function locationLabel(path: string, line?: number | null): string {
  return line ? `${path}:${line}` : path;
}

/** Split an absolute location into its root and root-relative path, or null if outside `root`. */
export function resolveLocation(
  root: string | null | undefined,
  absPath: string,
): { root: string; rel: string } | null {
  if (!root) return null;
  const rel = relativeToRoot(root, absPath);
  return rel ? { root, rel } : null;
}

/** Whether a tool call changed files, so a working-tree diff is worth offering. */
export function isEditCall(toolKind: string, content: readonly { type: string }[]): boolean {
  return toolKind === "edit" || content.some((c) => c.type === "diff");
}
