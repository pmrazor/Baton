import { Lock } from "lucide-react";
import type { PermissionRequest } from "../types";

interface Props {
  request: PermissionRequest;
  agentName: string;
  compact?: boolean;
  onAnswer: (key: string, optionId: string | null) => void;
}

export default function PermissionCard({ request, agentName, compact, onAnswer }: Props) {
  const title = request.toolCall?.title ?? "도구 실행";
  return (
    <div className={`permission ${compact ? "compact" : ""}`}>
      <div className="permission-head">
        <Lock size={13} aria-hidden />
        <span>
          <b>{agentName}</b> 권한 요청
        </span>
      </div>
      <div className="permission-title">{title}</div>
      <div className="permission-actions">
        {request.options.map((o) => (
          <button
            key={o.optionId}
            className={o.kind.startsWith("allow") ? "btn btn-primary" : "btn"}
            onClick={() => onAnswer(request.key, o.optionId)}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
