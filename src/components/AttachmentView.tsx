import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileText, Film, Image as ImageIcon, Play, X } from "lucide-react";
import { api } from "../api";
import type { Attachment } from "../types";

// Each media file is allowed for previews once per run.
const allowed = new Map<string, Promise<boolean>>();

function allowPreview(path: string) {
  let pending = allowed.get(path);
  if (!pending) {
    pending = api
      .allowPreviews([path])
      .then((ok) => ok.includes(path))
      .catch(() => false);
    allowed.set(path, pending);
  }
  return pending;
}

/** URL the webview can load for an image or video attachment, once allowed. */
function usePreview(a: Attachment) {
  const media = a.image || !!a.video;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!media) return;
    let live = true;
    allowPreview(a.path).then((ok) => live && setUrl(ok ? convertFileSrc(a.path) : null));
    return () => {
      live = false;
    };
  }, [a.path, media]);
  return url;
}

/**
 * One attachment: a thumbnail for images and videos, a name chip otherwise
 * (or when the file can't be shown). `onRemove` adds a remove button.
 */
export default function AttachmentView({
  a,
  large = false,
  onRemove,
}: {
  a: Attachment;
  large?: boolean;
  onRemove?: () => void;
}) {
  const url = usePreview(a);
  const [broken, setBroken] = useState(false);
  const open = () => api.openAttachment(a.path).catch(() => {});

  if (url && !broken) {
    return (
      <span className={`attach-thumb ${large ? "large" : ""}`} title={a.path}>
        <button className="thumb-open" onClick={open} aria-label={`${a.name} 열기`}>
          {a.video ? (
            <>
              {/* #t: show a frame, not a black box, before playback */}
              <video src={`${url}#t=0.1`} preload="metadata" muted playsInline onError={() => setBroken(true)} />
              <span className="thumb-play">
                <Play size={large ? 18 : 13} fill="currentColor" />
              </span>
            </>
          ) : (
            <img src={url} alt={a.name} loading="lazy" onError={() => setBroken(true)} />
          )}
        </button>
        {onRemove && (
          <button className="thumb-remove" aria-label={`${a.name} 빼기`} onClick={onRemove}>
            <X size={12} />
          </button>
        )}
      </span>
    );
  }

  const Icon = a.video ? Film : a.image ? ImageIcon : FileText;
  return (
    <span className="attach-chip" title={a.path}>
      <Icon size={13} />
      <span className="attach-name">{a.name}</span>
      {onRemove && (
        <button aria-label={`${a.name} 빼기`} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}
