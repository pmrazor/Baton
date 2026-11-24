import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Users,
} from "lucide-react";
import AttachmentView from "./AttachmentView";
import { api, toHubError } from "../api";
import {
  attachmentOf,
  DEFAULT_PROFILE,
  usableTeams,
  type Attachment,
  type AccountUsage,
  type AgentInfo,
  type AuthStatus,
  type ConfigOption,
  type LaunchOption,
  type Profile,
  type SelectOption,
  type Session,
  type Team,
} from "../types";
import { MenuItem, MenuSection, Popover } from "./Popover";
import UsageButton from "./UsagePanel";

interface Props {
  session: Session | null;
  agents: AgentInfo[];
  agentId: string | null;
  profileId: string;
  profiles: Profile[];
  identities: Record<string, AuthStatus>;
  /** Agent name, plus the account name for non-default accounts. */
  accountName: string;
  accountUsage: AccountUsage | null;
  /** Session is being created; input is held until it is ready. */
  connecting: boolean;
  onSwitchAgent: (agentId: string, profileId: string) => void;
  /** Open settings to install or manage agents. */
  onAddAgent: () => void;
  /** Restart the draft with a different launch option (only before the first message). */
  onSetLaunch: (optionId: string, value: string) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  onSetConfig: (configId: string, value: unknown) => void;
  onSetMode: (modeId: string) => void;
  /** Agent mode: this chat is (or the next draft will be) a lead. */
  agentMode: boolean;
  teamId: string;
  teams: Team[];
  /** This chat is a task delegated by a lead. */
  isTask: boolean;
  onChangeMode: (opts: { lead?: boolean; team?: string }) => void;
}

type Group = { group?: string; name: string; options: SelectOption[] };

function groups(opt: ConfigOption): Group[] {
  const out: Group[] = [];
  for (const o of opt.options ?? []) {
    if ("options" in o) out.push({ group: o.group, name: o.name, options: o.options });
    else if (out.length && !out.at(-1)!.group) out.at(-1)!.options.push(o);
    else out.push({ name: "", options: [o] });
  }
  return out;
}

const flat = (opt: ConfigOption) => groups(opt).flatMap((g) => g.options);
const currentName = (opt: ConfigOption) =>
  flat(opt).find((o) => o.value === String(opt.currentValue))?.name ?? String(opt.currentValue);

/** Sort an agent's config options into the slots the composer renders. */
function classify(options: ConfigOption[]) {
  const pick = (test: (o: ConfigOption) => boolean) => options.find(test);
  const mode = pick((o) => o.category === "mode" || o.id === "mode");
  const model = pick((o) => o.category === "model" || o.id === "model");
  const effort = pick((o) => o.category === "thought_level" || /effort|reasoning|thought/i.test(o.id));
  const rest = options.filter((o) => o !== mode && o !== model && o !== effort);
  return { mode, model, effort, rest };
}

/** Read a pasted file as base64 (without the data: prefix). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function Composer(p: Props) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const addPaths = (paths: string[]) => {
    setAttachError(null);
    setAttachments((list) => [...list, ...paths.filter((path) => !list.some((a) => a.path === path)).map(attachmentOf)]);
  };
  // Slash-command menu: open while the draft is "/word" with no space yet.
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const commands = p.session?.commands ?? [];
  const slash = /^\/(\S*)$/.exec(draft);
  const matches =
    slash && !cmdDismissed
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 8)
      : [];
  const pickCommand = (name: string) => {
    setDraft(`/${name} `);
    setCmdDismissed(true);
    textRef.current?.focus();
  };
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busy = p.session?.busy ?? false;
  const ready = !!p.session && !p.connecting && !p.session.attachError && !p.session.archived;
  const { mode, model, effort, rest } = classify(p.session?.configOptions ?? []);
  const agent = p.agents.find((a) => a.id === p.agentId);
  const sessionModes = !mode && p.session?.modes && p.session.modes.availableModes.length > 1 ? p.session.modes : null;

  // Grow with content up to the CSS max-height.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Files dropped anywhere on the window are attached to this message.
  const canAttach = ready && !busy;
  const canAttachRef = useRef(canAttach);
  canAttachRef.current = canAttach;
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "over" || type === "enter") setDragging(canAttachRef.current);
      else setDragging(false);
      if (type === "drop" && canAttachRef.current && event.payload.paths.length) addPaths(event.payload.paths);
    });
    return () => {
      off.then((unlisten) => unlisten());
    };
  }, []);

  const pickFiles = async () => {
    const picked = await openDialog({ multiple: true, directory: false, title: "첨부할 파일" });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
    textRef.current?.focus();
  };

  // A pasted screenshot has no file yet: keep it in the workspace's .baton first.
  const pasteImages = async (files: File[]) => {
    const workspace = p.session?.cwd;
    if (!workspace) return;
    try {
      for (const file of files) {
        const ext = file.type.split("/")[1] ?? "png";
        const name = file.name && file.name !== "image.png" ? file.name : `pasted.${ext}`;
        addPaths([await api.saveAttachment(workspace, name, await readBase64(file))]);
      }
    } catch (e) {
      setAttachError(`붙여넣은 이미지를 저장하지 못했어요: ${toHubError(e).message}`);
    }
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy || !ready) return;
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    p.onSend(text, attachments);
  };

  return (
    <div className="composer-wrap">
      {!p.isTask && (
        <div className="mode-switch" role="group" aria-label="모드">
          {(
            [
              [false, "채팅"],
              [true, "에이전트"],
            ] as const
          ).map(([lead, label]) => (
            <button
              key={label}
              aria-pressed={p.agentMode === lead}
              className={lead ? "agent" : ""}
              disabled={!!p.session && !p.session.draft && (p.session.busy || !p.session.attached) && p.agentMode !== lead}
              title={p.session?.busy ? "응답이 끝난 뒤 바꿀 수 있어요" : undefined}
              onClick={() => p.agentMode !== lead && p.onChangeMode({ lead })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className={`composer ${dragging ? "dragging" : ""}`}>
        {(attachments.length > 0 || attachError) && (
          <div className="attach-list">
            {attachments.map((a) => (
              <AttachmentView
                key={a.path}
                a={a}
                onRemove={() => setAttachments((list) => list.filter((x) => x.path !== a.path))}
              />
            ))}
            {attachError && <span className="error-text small">{attachError}</span>}
          </div>
        )}
        <button className="attach-btn" title="파일·이미지 첨부" aria-label="첨부" disabled={!canAttach} onClick={pickFiles}>
          <Plus size={18} />
        </button>
        {matches.length > 0 && (
          <div className="command-menu" role="listbox" aria-label="명령">
            {matches.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === Math.min(cmdIndex, matches.length - 1)}
                className={i === Math.min(cmdIndex, matches.length - 1) ? "selected" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c.name);
                }}
                onMouseEnter={() => setCmdIndex(i)}
              >
                <span className="command-name">/{c.name}</span>
                {c.hint && <span className="command-hint">{c.hint}</span>}
                <span className="command-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textRef}
          value={draft}
          rows={1}
          placeholder={
            p.connecting
              ? `${agent?.name ?? "에이전트"} 연결 중…`
              : p.session?.archived
                ? "끝난 작업은 이어서 대화할 수 없어요"
              : p.session?.attachError
                ? "연결되지 않은 대화예요 · 위의 [다시 시도]를 눌러 주세요"
              : p.isTask
                ? "이 작업에 직접 지시하기 (총괄도 내용을 받아요)"
                : p.agentMode
                  ? "총괄에게 지시하기"
                  : "에이전트에게 메시지 보내기"
          }
          onPaste={(e) => {
            const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            // Copied text that comes with pictures (e.g. from a web page) pastes as text.
            if (images.length === 0 || e.clipboardData.getData("text/plain")) return;
            e.preventDefault();
            if (canAttach) pasteImages(images);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setCmdDismissed(false);
            setCmdIndex(0);
          }}
          onKeyDown={(e) => {
            if (matches.length > 0 && !e.nativeEvent.isComposing) {
              const at = Math.min(cmdIndex, matches.length - 1);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : matches.length - 1;
                setCmdIndex((at + step) % matches.length);
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                pickCommand(matches[at].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setCmdDismissed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button className="send stop" title="중단" onClick={p.onCancel}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send"
            title="전송 (Enter)"
            disabled={(!draft.trim() && attachments.length === 0) || !ready}
            onClick={submit}
          >
            {p.connecting ? <span className="spinner light" /> : <ArrowUp size={17} />}
          </button>
        )}
      </div>
      <div className="composer-meta">
        <Popover
          button={({ toggle }) => (
            <button
              className="chip"
              onClick={toggle}
              disabled={!p.session?.draft && !!p.session}
              title={p.session && !p.session.draft ? "대화 중에는 에이전트를 바꿀 수 없어요" : "에이전트 선택"}
            >
              <Bot size={15} />
              {p.agentMode && !p.isTask ? `총괄 · ${p.accountName}` : p.accountName}
              {(!p.session || p.session.draft) && <ChevronDown size={14} />}
            </button>
          )}
        >
          {(close) =>
            p.agents.map((a) => {
              const accounts = a.multiAccount ? p.profiles.filter((pr) => pr.agentId === a.id) : [];
              const pick = (profileId: string) => {
                close();
                if (a.id !== p.agentId || profileId !== p.profileId) p.onSwitchAgent(a.id, profileId);
              };
              if (accounts.length === 0) {
                return (
                  <MenuSection key={a.id}>
                    <MenuItem
                      label={a.name}
                      description={a.description}
                      selected={a.id === p.agentId}
                      onClick={() => pick(DEFAULT_PROFILE)}
                    />
                  </MenuSection>
                );
              }
              // Several accounts: one row per account under the agent's name.
              const rows = [{ id: DEFAULT_PROFILE, name: "기본" }, ...accounts];
              return (
                <MenuSection key={a.id} title={a.name}>
                  {rows.map((r) => (
                    <MenuItem
                      key={r.id}
                      label={r.name}
                      description={p.identities[`${a.id}/${r.id}`]?.account?.email}
                      selected={a.id === p.agentId && r.id === p.profileId}
                      onClick={() => pick(r.id)}
                    />
                  ))}
                </MenuSection>
              );
            }).concat(
              <MenuSection key="__add">
                <MenuItem
                  label="에이전트 추가…"
                  description="다른 에이전트 설치와 관리"
                  onClick={() => {
                    close();
                    p.onAddAgent();
                  }}
                />
              </MenuSection>,
            )
          }
        </Popover>

        {p.agentMode && !p.isTask && (
          <Popover
            button={({ toggle }) => (
              <button
                className="chip team-chip"
                onClick={toggle}
                title="총괄이 일을 맡길 팀 (대화 중에도 바꿀 수 있어요)"
              >
                <Users size={15} />
                {p.teams.find((t) => t.id === p.teamId)?.name ?? "자동"}
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuSection title="팀">
                {usableTeams(p.teams, p.agents).map((t) => (
                  <MenuItem
                    key={t.id}
                    label={t.name}
                    description={t.members.map((m) => m.name).join(", ")}
                    selected={t.id === p.teamId}
                    onClick={() => {
                      close();
                      if (t.id !== p.teamId) p.onChangeMode({ team: t.id });
                    }}
                  />
                ))}
              </MenuSection>
            )}
          </Popover>
        )}
        {agent?.launchOptions.map((opt) => (
          <LaunchChip
            key={opt.id}
            opt={opt}
            value={p.session?.launch[opt.id] ?? opt.default}
            locked={!!p.session && !p.session.draft}
            agentName={agent.name}
            onChange={(v) => p.onSetLaunch(opt.id, v)}
          />
        ))}
        {mode && (
          <OptionChip
            icon={<ShieldCheck size={15} />}
            opt={mode}
            onChange={(v) => p.onSetConfig(mode.id, v)}
          />
        )}
        {sessionModes && (
          <Popover
            button={({ toggle }) => (
              <button className="chip" onClick={toggle}>
                <ShieldCheck size={15} />
                {sessionModes.availableModes.find((m) => m.id === sessionModes.currentModeId)?.name ??
                  sessionModes.currentModeId}
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuSection title="모드">
                {sessionModes.availableModes.map((m) => (
                  <MenuItem
                    key={m.id}
                    label={m.name}
                    description={m.description}
                    selected={m.id === sessionModes.currentModeId}
                    onClick={() => {
                      close();
                      p.onSetMode(m.id);
                    }}
                  />
                ))}
              </MenuSection>
            )}
          </Popover>
        )}
        {rest.length > 0 && (
          <Popover
            button={({ toggle }) => (
              <button className="chip icon-only" onClick={toggle} title="세부 설정">
                <SlidersHorizontal size={15} />
              </button>
            )}
          >
            {() =>
              rest.map((opt) =>
                opt.type === "boolean" ? (
                  <MenuSection key={opt.id}>
                    <MenuItem
                      label={opt.name}
                      description={opt.description}
                      selected={!!opt.currentValue}
                      onClick={() => p.onSetConfig(opt.id, !opt.currentValue)}
                    />
                  </MenuSection>
                ) : (
                  <MenuSection key={opt.id} title={opt.name}>
                    {flat(opt).map((o) => (
                      <MenuItem
                        key={o.value}
                        label={o.name}
                        description={o.description}
                        selected={o.value === String(opt.currentValue)}
                        onClick={() => p.onSetConfig(opt.id, o.value)}
                      />
                    ))}
                  </MenuSection>
                ),
              )
            }
          </Popover>
        )}

        <div className="spacer" />

        {(model || effort) && (
          <Popover
            align="right"
            button={({ toggle }) => (
              <button className="chip model-chip" onClick={toggle}>
                {model && <span>{currentName(model)}</span>}
                {model && effort && <span className="muted">·</span>}
                {effort && <span className="muted">{currentName(effort)}</span>}
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <>
                {effort && (
                  <MenuSection title={effort.name}>
                    <div className="segmented">
                      {flat(effort).map((o) => (
                        <button
                          key={o.value}
                          className={o.value === String(effort.currentValue) ? "active" : ""}
                          onClick={() => p.onSetConfig(effort.id, o.value)}
                        >
                          {o.name}
                        </button>
                      ))}
                    </div>
                  </MenuSection>
                )}
                {model &&
                  groups(model).map((g, i) => (
                    <MenuSection key={g.group ?? i} title={g.name || (i === 0 ? model.name : undefined)}>
                      {g.options.map((o) => (
                        <MenuItem
                          key={o.value}
                          label={o.name}
                          description={o.description}
                          selected={o.value === String(model.currentValue)}
                          onClick={() => {
                            close();
                            p.onSetConfig(model.id, o.value);
                          }}
                        />
                      ))}
                    </MenuSection>
                  ))}
              </>
            )}
          </Popover>
        )}
        <UsageButton
          commands={commands}
          session={p.session}
          agentName={p.accountName}
          account={p.accountUsage}
          identity={p.agentId ? p.identities[`${p.agentId}/${p.profileId}`] : undefined}
        />
      </div>
    </div>
  );
}

function LaunchChip(p: {
  opt: LaunchOption;
  value: string;
  locked: boolean;
  agentName: string;
  onChange: (v: string) => void;
}) {
  const current = p.opt.choices.find((c) => c.value === p.value);
  const icon = p.opt.category === "mode" ? <ShieldCheck size={15} /> : <SlidersHorizontal size={15} />;
  return (
    <Popover
      button={({ toggle }) => (
        <button
          className="chip"
          onClick={toggle}
          disabled={p.locked}
          title={
            p.locked
              ? `${p.agentName}는 대화를 시작한 뒤에는 ${p.opt.name}을 바꿀 수 없어요. 새 대화에서 골라 주세요.`
              : p.opt.name
          }
        >
          {icon}
          {current?.name ?? p.value}
          {!p.locked && <ChevronDown size={14} />}
        </button>
      )}
    >
      {(close) => (
        <MenuSection title={p.opt.name}>
          {p.opt.choices.map((c) => (
            <MenuItem
              key={c.value}
              label={c.name}
              description={c.description}
              selected={c.value === p.value}
              onClick={() => {
                close();
                if (c.value !== p.value) p.onChange(c.value);
              }}
            />
          ))}
        </MenuSection>
      )}
    </Popover>
  );
}

function OptionChip({ icon, opt, onChange }: { icon: ReactNode; opt: ConfigOption; onChange: (v: string) => void }) {
  return (
    <Popover
      button={({ toggle }) => (
        <button className="chip" onClick={toggle} title={opt.description ?? opt.name}>
          {icon}
          {currentName(opt)}
          <ChevronDown size={14} />
        </button>
      )}
    >
      {(close) => (
        <MenuSection title={opt.name}>
          {flat(opt).map((o) => (
            <MenuItem
              key={o.value}
              label={o.name}
              description={o.description}
              selected={o.value === String(opt.currentValue)}
              onClick={() => {
                close();
                onChange(o.value);
              }}
            />
          ))}
        </MenuSection>
      )}
    </Popover>
  );
}
