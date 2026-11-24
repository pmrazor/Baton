import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { api, toHubError } from "../api";
import type { State } from "../store";
import {
  AUTO_TEAM,
  DEFAULT_PROFILE,
  installedAgents,
  usableTeams,
  type AgentInfo,
  type ConfigOption,
  type SelectOption,
  type Team,
  type TeamMember,
} from "../types";

type Options = Record<string, ConfigOption[]>;

/** Flatten an ACP select option (grouped or not) into labelled choices. */
function choices(opt: ConfigOption | undefined): (SelectOption & { group?: string })[] {
  if (!opt || opt.type !== "select" || !opt.options) return [];
  return opt.options.flatMap((o) =>
    "options" in o ? o.options.map((c) => ({ ...c, group: o.name })) : [o as SelectOption],
  );
}

const findOpt = (opts: ConfigOption[] | undefined, test: (o: ConfigOption) => boolean) => opts?.find(test);
const modelOpt = (o?: ConfigOption[]) => findOpt(o, (x) => x.category === "model" || x.id === "model");
const effortOpt = (o?: ConfigOption[]) =>
  findOpt(o, (x) => x.category === "thought_level" || /effort|reasoning|thought/i.test(x.id));
const modeOpt = (o?: ConfigOption[]) => findOpt(o, (x) => x.category === "mode" || x.id === "mode");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Name and id are derived from the choices so the lead sees meaningful ids. */
function describe(m: TeamMember, state: State, options: Options) {
  const agent = state.agents.find((a) => a.id === m.agentId);
  const model = choices(modelOpt(options[m.agentId])).find((c) => c.value === m.config.model);
  const profile = state.profiles.find((p) => p.id === m.profileId)?.name;
  const name = `${agent?.name ?? m.agentId} · ${model?.name ?? "기본 모델"}${profile ? ` (${profile})` : ""}`;
  const id = [m.agentId, slug(model?.name ?? "default"), profile ? slug(m.profileId) : ""].filter(Boolean).join("-");
  return { name, id };
}

function withNames(team: Team, state: State, options: Options): Team {
  const used = new Map<string, number>();
  const members = team.members.map((m) => {
    const { name, id } = describe(m, state, options);
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    return { ...m, name, id: n > 1 ? `${id}-${n}` : id };
  });
  return { ...team, members };
}

export default function TeamsPanel({ state, onChanged }: { state: State; onChanged: () => void }) {
  const [options, setOptions] = useState<Options>({});
  const [editing, setEditing] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agentOptions().then(setOptions);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(toHubError(e).message);
    }
  };

  if (editing) {
    return (
      <TeamEditor
        team={editing}
        state={state}
        options={options}
        error={error}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={(team) =>
          run(async () => {
            if (!team.name.trim()) throw new Error("팀 이름을 입력해 주세요");
            if (team.members.length === 0) throw new Error("멤버를 한 명 이상 추가해 주세요");
            await api.saveTeam(withNames(team, state, options));
            setEditing(null);
            onChanged();
          })
        }
      />
    );
  }

  const copyOf = (t: Team): Team => ({
    ...t,
    id: `team-${Date.now()}`,
    name: t.id === AUTO_TEAM ? "내 팀" : `${t.name} 복사본`,
    builtin: false,
  });

  return (
    <div className="teams">
      <div className="panel-head">
        <p className="muted small">총괄이 일을 맡길 수 있는 멤버 명단이에요. 에이전트 모드의 입력창에서 팀을 고를 수 있어요.</p>
        <button
          className="btn small-btn"
          onClick={() =>
            setEditing({ id: `team-${Date.now()}`, name: "", members: [], maxParallel: 3, isolation: "worktree" })
          }
        >
          <Plus size={14} /> 새 팀
        </button>
      </div>
      <ul className="team-list">
        {usableTeams(state.teams, state.agents).map((t) => (
          <li key={t.id}>
            <div className="grow">
              <div className="team-name">
                {t.name}
                {t.builtin && <span className="pill subtle">기본 제공</span>}
                <span className="muted small">
                  동시 {t.maxParallel}개 · {t.isolation === "shared" ? "같은 폴더" : "작업별 분리"}
                </span>
              </div>
              <div className="muted small ellipsis">{t.members.map((m) => m.name).join(" · ")}</div>
            </div>
            {t.builtin ? (
              <button className="btn small-btn" onClick={() => setEditing(copyOf(t))}>
                <Copy size={14} /> 복제해서 새 팀으로
              </button>
            ) : (
              <>
                <button className="icon-btn" title="편집" onClick={() => setEditing(t)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn" title="복제" onClick={() => setEditing(copyOf(t))}>
                  <Copy size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="삭제"
                  onClick={() =>
                    run(async () => {
                      const ok = await ask(`'${t.name}' 팀을 삭제할까요?`, { title: "팀 삭제", kind: "warning" });
                      if (!ok) return;
                      await api.deleteTeam(t.id);
                      onChanged();
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

function TeamEditor(p: {
  team: Team;
  state: State;
  options: Options;
  error: string | null;
  onCancel: () => void;
  onSave: (team: Team) => void;
}) {
  const [team, setTeam] = useState<Team>(p.team);
  const setMember = (i: number, m: TeamMember) =>
    setTeam((t) => ({ ...t, members: t.members.map((x, n) => (n === i ? m : x)) }));
  const firstAgent = installedAgents(p.state.agents)[0]?.id ?? p.state.agents[0]?.id ?? "claude";

  return (
    <div className="team-editor">
      <button className="link-btn" onClick={p.onCancel}>
        <ArrowLeft size={14} /> 팀 목록
      </button>
      <div className="team-fields">
        <label className="field grow">
          <span>팀 이름</span>
          <input
            id="team-name"
            value={team.name}
            placeholder="예: 빠르게"
            onChange={(e) => setTeam({ ...team, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>파일 수정 작업</span>
          <select
            id="team-isolation"
            value={team.isolation ?? "worktree"}
            onChange={(e) => setTeam({ ...team, isolation: e.target.value as Team["isolation"] })}
          >
            <option value="worktree">작업별 분리 후 병합 (git worktree)</option>
            <option value="shared">같은 폴더에서 한 번에 하나</option>
          </select>
        </label>
        <label className="field">
          <span>동시 작업</span>
          <select
            id="team-parallel"
            value={team.maxParallel}
            onChange={(e) => setTeam({ ...team, maxParallel: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}개
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="section-label">멤버</div>
      <ul className="member-list">
        {team.members.map((m, i) => (
          <MemberRow
            key={i}
            index={i}
            member={m}
            state={p.state}
            options={p.options}
            onChange={(next) => setMember(i, next)}
            onRemove={() => setTeam((t) => ({ ...t, members: t.members.filter((_, n) => n !== i) }))}
          />
        ))}
      </ul>
      <button
        className="btn small-btn"
        onClick={() =>
          setTeam((t) => ({
            ...t,
            members: [
              ...t.members,
              {
                id: "",
                name: "",
                agentId: firstAgent,
                profileId: DEFAULT_PROFILE,
                launch: {},
                config: {},
                role: "",
              },
            ],
          }))
        }
      >
        <Plus size={14} /> 멤버 추가
      </button>

      {p.error && <p className="error-text small">{p.error}</p>}
      <div className="editor-actions">
        <button className="btn" onClick={p.onCancel}>
          취소
        </button>
        <button className="btn btn-primary" onClick={() => p.onSave(team)}>
          저장
        </button>
      </div>
    </div>
  );
}

function MemberRow(p: {
  index: number;
  member: TeamMember;
  state: State;
  options: Options;
  onChange: (m: TeamMember) => void;
  onRemove: () => void;
}) {
  const m = p.member;
  const agent: AgentInfo | undefined = p.state.agents.find((a) => a.id === m.agentId);
  const opts = p.options[m.agentId];
  const model = modelOpt(opts);
  const effort = effortOpt(opts);
  // Permission lives in a launch option for some agents (dsh) and a config option for others (Claude).
  const launchMode = agent?.launchOptions.find((o) => o.category === "mode");
  const configMode = launchMode ? undefined : modeOpt(opts);
  const accounts = agent?.multiAccount ? p.state.profiles.filter((pr) => pr.agentId === m.agentId) : [];
  const setConfig = (key: string, value: string) => {
    const config = { ...m.config };
    if (value) config[key] = value;
    else delete config[key];
    p.onChange({ ...m, config });
  };
  const id = (field: string) => `member-${p.index}-${field}`;

  return (
    <li className="member">
      <div className="member-selects">
        <select
          id={id("agent")}
          aria-label="에이전트"
          value={m.agentId}
          onChange={(e) => p.onChange({ ...m, agentId: e.target.value, profileId: DEFAULT_PROFILE, launch: {}, config: {} })}
        >
          {p.state.agents
            .filter((a) => a.installed || a.id === m.agentId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.installed ? a.name : `${a.name} (설치 안 됨)`}
              </option>
            ))}
        </select>
        {accounts.length > 0 && (
          <select
            id={id("account")}
            aria-label="계정"
            value={m.profileId}
            onChange={(e) => p.onChange({ ...m, profileId: e.target.value })}
          >
            <option value={DEFAULT_PROFILE}>기본 계정</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <OptionSelect id={id("model")} label="모델" opt={model} value={m.config.model} onChange={(v) => setConfig(model!.id, v)} />
        <OptionSelect
          id={id("effort")}
          label="추론 강도"
          opt={effort}
          value={effort ? m.config[effort.id] : undefined}
          onChange={(v) => setConfig(effort!.id, v)}
        />
        {launchMode ? (
          <select
            id={id("permission")}
            aria-label={launchMode.name}
            value={m.launch[launchMode.id] ?? launchMode.default}
            onChange={(e) => p.onChange({ ...m, launch: { ...m.launch, [launchMode.id]: e.target.value } })}
          >
            {launchMode.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <OptionSelect
            id={id("permission")}
            label="권한"
            opt={configMode}
            value={configMode ? m.config[configMode.id] : undefined}
            onChange={(v) => setConfig(configMode!.id, v)}
          />
        )}
        <button className="icon-btn" title="멤버 삭제" onClick={p.onRemove}>
          <Trash2 size={15} />
        </button>
      </div>
      {!opts && (
        <p className="muted small">
          {agent?.name ?? m.agentId}로 대화를 한 번 시작하면 모델과 권한 목록이 보여요.
        </p>
      )}
      <input
        id={id("role")}
        className="member-role"
        value={m.role}
        placeholder="역할: 이 멤버에게 맡길 일 (예: 테스트 작성, 반복 작업)"
        onChange={(e) => p.onChange({ ...m, role: e.target.value })}
      />
    </li>
  );
}

/** A select over an agent's config option; the empty choice keeps the agent's default. */
function OptionSelect(p: {
  id: string;
  label: string;
  opt: ConfigOption | undefined;
  value: unknown;
  onChange: (v: string) => void;
}) {
  if (!p.opt) return null;
  const list = choices(p.opt);
  const groups = [...new Set(list.map((c) => c.group ?? ""))];
  return (
    <select id={p.id} aria-label={p.label} value={typeof p.value === "string" ? p.value : ""} onChange={(e) => p.onChange(e.target.value)}>
      <option value="">{p.label}: 기본값</option>
      {groups.map((g) =>
        g ? (
          <optgroup key={g} label={g}>
            {list
              .filter((c) => c.group === g)
              .map((c) => (
                <option key={c.value} value={c.value}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        ) : (
          list
            .filter((c) => !c.group)
            .map((c) => (
              <option key={c.value} value={c.value}>
                {c.name}
              </option>
            ))
        ),
      )}
    </select>
  );
}
