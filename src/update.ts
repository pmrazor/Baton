import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** "0.1.0-alpha.1" → "Alpha 0.1"; release versions are shown as-is. */
export function formatVersion(v: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)-([a-z]+)/i.exec(v);
  if (!m) return v;
  const stage = m[4].charAt(0).toUpperCase() + m[4].slice(1);
  return `${stage} ${m[1]}.${m[2]}${m[3] !== "0" ? `.${m[3]}` : ""}`;
}

/** The newer release, or null when up to date. Throws if the check itself fails. */
export async function findUpdate(): Promise<Update | null> {
  return check();
}

/** Download, install and restart into the new version. */
export async function installUpdate(update: Update, onProgress: (percent: number | null) => void) {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength ?? 0;
    if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.round((received / total) * 100) : null);
    }
  });
  await relaunch();
}
