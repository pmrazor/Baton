import { useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftRight,
  Atom,
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Trash2,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ChatItem, PlanEntry, ToolCallContent } from "../types";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const TOOL_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: ArrowLeftRight,
  search: Search,
  execute: Terminal,
  think: Atom,
  fetch: Globe,
  switch_mode: ArrowLeftRight,
};

const STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  in_progress: "실행 중",
  completed: "완료",
  failed: "실패",
};

export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Never navigate the app webview away; open links in the system browser.
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:/i.test(href)) openUrl(href);
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Fenced code block with a copy button in its top-right corner. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={ref}>{children}</pre>
      <CopyButton className="code-copy" text={() => ref.current?.innerText.replace(/\n$/, "") ?? ""} />
    </div>
  );
}

function CopyButton({ text, className = "" }: { text: string | (() => string); className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`icon-btn sm ${className}`}
      title="복사"
      onClick={() => {
        navigator.clipboard.writeText(typeof text === "function" ? text() : text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

export function ChatItemView({ item, isLast }: { item: ChatItem; isLast: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user-wrap">
          <div className="msg-user">{item.text}</div>
          <div className="msg-actions">
            <CopyButton text={item.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg-assistant">
          <Md text={item.text} />
          <div className={`msg-actions ${isLast ? "always" : ""}`}>
            <CopyButton text={item.text} />
          </div>
        </div>
      );
    case "thought":
      return <ThoughtRow text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanView entries={item.entries} />;
    case "notice":
      return <div className={`notice notice-${item.tone}`}>{item.text}</div>;
    case "brief":
      return (
        <div className="brief">
          <div className="brief-head">
            <Workflow size={14} />
            {item.label}
          </div>
          <Md text={item.text} />
        </div>
      );
  }
}

export function ThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().split("\n")[0];
  return (
    <div className={`trace ${open ? "open" : ""}`}>
      <button className="trace-head" onClick={() => setOpen(!open)}>
        <Atom size={15} className="trace-icon" />
        <span className="trace-label">Think</span>
        {!open && <span className="trace-preview">· {preview}</span>}
      </button>
      {open && <div className="trace-body thought-text">{text.trim()}</div>}
    </div>
  );
}

/** Some agents (dsh) report shell tools as kind "other"; recognise them by name. */
function toolIcon(item: ToolItem): LucideIcon {
  if (TOOL_ICON[item.toolKind] && item.toolKind !== "other") return TOOL_ICON[item.toolKind];
  if (/^(bash|sh|zsh|shell|pwsh|powershell|terminal|exec|run_command)\b/i.test(item.title)) return Terminal;
  return TOOL_ICON[item.toolKind] ?? Wrench;
}

export function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(item);
  const hasDetails = item.content.length > 0 || item.rawInput !== undefined;
  return (
    <div className={`trace tool-${item.status} ${open ? "open" : ""}`}>
      <button className="trace-head" onClick={() => hasDetails && setOpen(!open)}>
        <Icon size={15} className="trace-icon" />
        <span className="trace-title">{item.title}</span>
        <span className={`status status-${item.status}`}>
          {item.status === "in_progress" ? <span className="spinner" /> : STATUS_LABEL[item.status] ?? item.status}
        </span>
        {hasDetails && <ChevronRight size={14} className="trace-chev" />}
      </button>
      {open && (
        <div className="trace-body">
          {item.locations.length > 0 && (
            <div className="tool-locations">
              {item.locations.map((l, i) => (
                <code key={i}>
                  {l.path}
                  {l.line ? `:${l.line}` : ""}
                </code>
              ))}
            </div>
          )}
          {item.content.map((c, i) => (
            <ToolContent key={i} c={c} />
          ))}
          {item.content.length === 0 && item.rawInput !== undefined && (
            <pre className="code">{JSON.stringify(item.rawInput, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolContent({ c }: { c: ToolCallContent }) {
  if (c.type === "diff") return <DiffView path={c.path ?? ""} oldText={c.oldText ?? ""} newText={c.newText ?? ""} />;
  if (c.type === "content" && c.content?.type === "text") return <pre className="code">{c.content.text}</pre>;
  if (c.type === "terminal") return <div className="muted small">터미널 출력 ({c.terminalId})</div>;
  return <pre className="code">{JSON.stringify(c, null, 2)}</pre>;
}

/** Line-level diff: unchanged prefix/suffix trimmed, middle shown as -/+. */
function DiffView({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ctx = 2;
  const lines: { t: " " | "-" | "+"; s: string }[] = [
    ...a.slice(Math.max(0, start - ctx), start).map((s) => ({ t: " " as const, s })),
    ...a.slice(start, endA).map((s) => ({ t: "-" as const, s })),
    ...b.slice(start, endB).map((s) => ({ t: "+" as const, s })),
    ...b.slice(endB, endB + ctx).map((s) => ({ t: " " as const, s })),
  ];
  return (
    <div className="diff">
      <div className="diff-path">{path}</div>
      <pre className="code">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"}`}>
            {l.t} {l.s}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function PlanView({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-title">
        <ListChecks size={15} /> 계획 <span className="muted">{done}/{entries.length}</span>
      </div>
      <ul>
        {entries.map((e, i) => (
          <li key={i} className={`plan-${e.status}`}>
            <span className={`plan-box plan-box-${e.status}`} aria-hidden />
            {e.content}
          </li>
        ))}
      </ul>
    </div>
  );
}
