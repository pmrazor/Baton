import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

/**
 * Minimize / maximize / close for Windows, where the app draws its own title
 * bar (the native one is turned off in tauri.windows.conf.json).
 */
export default function WindowControls() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized);
    const off = win.onResized(() => win.isMaximized().then(setMaximized));
    return () => {
      off.then((unlisten) => unlisten());
    };
  }, [win]);

  return (
    <div className="window-controls">
      <button title="최소화" aria-label="최소화" onClick={() => win.minimize()}>
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button
        title={maximized ? "이전 크기로" : "최대화"}
        aria-label={maximized ? "이전 크기로" : "최대화"}
        onClick={() => win.toggleMaximize()}
      >
        {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      <button className="close" title="닫기" aria-label="닫기" onClick={() => win.close()}>
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
