export type Platform = "mac" | "windows" | "linux";

/** Detect the desktop platform from a user-agent (or navigator.platform) string. */
export function detectPlatform(ua: string): Platform {
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "mac";
  if (/Windows|Win32|Win64|WOW64|WinCE/i.test(ua)) return "windows";
  return "linux";
}
