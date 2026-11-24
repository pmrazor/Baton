import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, subscribe, toHubError } from "./api";
import { initialState, reducer, type State } from "./store";
import { AUTO_TEAM, installedAgents, isTaskActive, profileOf, sessionKey, type Launch, type Session } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView, { TitleBar, type Tab } from "./components/ChatView";
import SettingsModal, { type SettingsTab } from "./components/SettingsModal";
import ImportModal, { type Imported } from "./components/ImportModal";
import UpdateBanner from "./components/UpdateBanner";
import WindowControls from "./components/WindowControls";
import { findUpdate } from "./update";
import type { Update } from "@tauri-apps/plugin-updater";
import { quotasFromUsageReport } from "./usage";

// Per-user conveniences only; losing them just resets the sidebar.
const STORE = {
  workspaces: "baton.workspaces",
  workspace: "baton.workspace",
  agent: "baton.lastAgent",
  rail: "baton.sidebarRail",
  active: "baton.activeSession",
  launch: "baton.launch",
  agentMode: "baton.agentMode",
  team: "baton.team",
};

/** What goes to disk: everything except live-process state. */
function toSaved({
  busy: _busy,
  attached: _attached,
  draft: _draft,
  attachError: _attachError,
  archived: _archived,
  ...rest
}: Session) {
  return rest;
}

function fromSaved(v: any): Session | null {
  if (!v || typeof v !== "object" || !v.key || !v.agentId || !v.sessionId || !v.cwd) return null;
  return {
    title: "대화",
    items: [],
    configOptions: [],
    modes: null,
    usage: null,
    lastTurn: null,
    createdAt: Date.now(),
    launch: {},
    ...v,
    // Tasks can't outlive the app: anything unfinished was interrupted.
    tasks: Array.isArray(v.tasks)
      ? v.tasks.map((t: any) =>
          isTaskActive(t.status)
            ? { ...t, status: "cancelled" }
            : t.mergeState === "pending"
              ? // The worktree outlives the app but the app no longer tracks it.
                { ...t, status: "failed", mergeState: null, error: "앱을 다시 시작해서 이 작업은 병합할 수 없어요" }
              : t,
        )
      : v.tasks,
    updatedAt: v.updatedAt ?? v.createdAt ?? Date.now(),
    busy: false,
    draft: false,
    attached: false,
  };
}

/**
 * The workspace whose `.baton` holds a conversation: its own folder, or for a
 * delegated task (which runs in a temporary worktree) its lead's folder.
 */
function homeOf(s: Session, sessions: Session[]): string | null {
  if (!s.parent) return s.cwd;
  return sessions.find((l) => l.key === s.parent!.key)?.cwd ?? null;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore: storage may be unavailable.
  }
}

function init(): State {
  const workspaces = read<string[]>(STORE.workspaces, []);
  const workspace = read<string | null>(STORE.workspace, null);
  return { ...initialState, workspaces, workspace: workspace && workspaces.includes(workspace) ? workspace : workspaces[0] ?? null };
}

if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac");
// Windows has no native title bar (tauri.windows.conf.json); the app draws its own controls.
const isWindows = navigator.userAgent.includes("Windows");
if (isWindows) document.documentElement.classList.add("windows");

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [rail, setRail] = useState(() => read<boolean>(STORE.rail, false));
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [importCwd, setImportCwd] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);

  // Look for a newer release shortly after launch; failures (offline, no release yet) stay quiet.
  useEffect(() => {
    const timer = setTimeout(() => {
      findUpdate()
        .then(setUpdate)
        .catch((e) => console.info("업데이트 확인 건너뜀:", e));
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
  const [tab, setTab] = useState<Tab>("chat");
  const [agentMode, setAgentMode] = useState(() => read<boolean>(STORE.agentMode, false));
  const [teamId, setTeamId] = useState(() => read<string>(STORE.team, AUTO_TEAM));
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const creating = useRef(false);
  const attaching = useRef<string | null>(null);
  const saved = useRef(new Map<string, Session>());

  useEffect(() => {
    api.listAgents().then((agents) => dispatch({ type: "agents", agents }));
    api.listProfiles().then((profiles) => dispatch({ type: "profiles", profiles }));
    api.listTeams().then((teams) => dispatch({ type: "teams", teams }));

    api
      .loadSessions(init().workspaces)
      .then((raw) => {
        const sessions = raw.map(fromSaved).filter((s): s is Session => s !== null);
        sessions.sort((a, b) => a.updatedAt - b.updatedAt);
        sessions.forEach((s) => saved.current.set(s.key, s));
        dispatch({ type: "restore", sessions, activeKey: read<string | null>(STORE.active, null) });
      })
      .catch((e) => console.error("대화 기록을 불러오지 못했어요", e))
      .finally(() => setHistoryLoaded(true));

    let unlisten: (() => void) | null = null;
    let disposed = false;
    subscribe({
      onUpdate: (agentId, profileId, sessionId, update) =>
        dispatch({ type: "update", agentId, profileId, sessionId, update }),
      onAuth: (agentId, profileId, status) => dispatch({ type: "auth", agentId, profileId, status }),
      onPermission: (request) => dispatch({ type: "permissionAdd", request }),
      onStatus: (agentId, status, message) => {
        dispatch({ type: "agentStatus", agentId, status, message });
        api.listAgents().then((agents) => dispatch({ type: "agents", agents }));
      },
      onLog: (agentId, line) => dispatch({ type: "log", agentId, line }),
      onTask: (task) => dispatch({ type: "taskUpdate", task }),
      onTaskSession: (event) => dispatch({ type: "taskSession", event }),
      onTaskBrief: (task, text) => dispatch({ type: "taskBrief", task, text }),
      onAccountUsage: (agentId, profileId, usage) =>
        dispatch({ type: "accountUsage", agentId, profileId, quotas: quotasFromUsageReport(usage) }),
    }).then((off) => (disposed ? off() : (unlisten = off)));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => write(STORE.workspaces, state.workspaces), [state.workspaces]);
  useEffect(() => write(STORE.workspace, state.workspace), [state.workspace]);
  useEffect(() => write(STORE.rail, rail), [rail]);
  useEffect(() => write(STORE.agentMode, agentMode), [agentMode]);
  useEffect(() => write(STORE.team, teamId), [teamId]);
  useEffect(() => {
    if (historyLoaded) write(STORE.active, state.activeKey);
  }, [state.activeKey, historyLoaded]);

  // Persist changed conversations, debounced so streaming doesn't hammer the disk.
  useEffect(() => {
    if (!historyLoaded) return;
    const timer = setTimeout(() => {
      for (const s of state.sessions) {
        if (s.draft || saved.current.get(s.key) === s) continue;
        const home = homeOf(s, state.sessions);
        // No folder to write into (deleted project, or a task whose lead is gone).
        if (!home || state.missing.includes(home)) continue;
        saved.current.set(s.key, s);
        api.saveSession(home, s.key, toSaved(s)).catch((e) => console.error("대화 저장 실패", e));
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [state.sessions, state.missing, historyLoaded]);

  const addWorkspace = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: "워크스페이스 폴더 선택" });
    if (typeof dir !== "string") return;
    dispatch({ type: "workspaceAdd", path: dir });
    // Bring in the history this folder already carries in its .baton.
    const raw = await api.loadSessions([dir]).catch(() => [] as unknown[]);
    const sessions = raw.map(fromSaved).filter((s): s is Session => s !== null);
    sessions.forEach((s) => saved.current.set(s.key, s));
    if (sessions.length) dispatch({ type: "restore", sessions, activeKey: null });
  }, []);

  /**
   * Open a draft chat right away so the model can be picked before the first message.
   * In agent mode the draft is a lead session wired to the chosen team.
   */
  const newChat = useCallback(
    async (workspace?: string, agentId?: string, launchOverride?: Launch, opts?: { lead?: boolean; team?: string }) => {
      const lead = opts?.lead ?? agentMode;
      const team = opts?.team ?? teamId;
      const ws = workspace ?? state.workspace;
      if (!ws) return addWorkspace();
      if (state.missing.includes(ws)) {
        const agentForPrompt = agentId ?? installedAgents(state.agents)[0]?.id ?? "";
        dispatch({
          type: "authPrompt",
          prompt: { agentId: agentForPrompt, profileId: "default", message: `작업 폴더를 찾을 수 없어요: ${ws}`, methods: [] },
        });
        return;
      }
      // The last used agent, unless it has since been uninstalled.
      const usable = installedAgents(state.agents);
      const remembered = read<string | null>(STORE.agent, null);
      const agent = agentId ?? usable.find((a) => a.id === remembered)?.id ?? usable[0]?.id;
      if (!agent) {
        if (state.agents.length > 0) setSettingsTab("agents");
        return;
      }
      if (creating.current) return;
      // Launch choices (permission, account, …) are remembered per agent for the next new chat.
      const launch = { ...read<Launch>(`${STORE.launch}.${agent}`, {}), ...launchOverride };

      creating.current = true;
      setConnecting(agent);
      dispatch({ type: "dropDrafts" });
      dispatch({ type: "workspaceSelect", path: ws });
      try {
        const res = lead ? await api.newLeadSession(agent, ws, launch, team) : await api.newSession(agent, ws, launch);
        write(STORE.agent, agent);
        write(`${STORE.launch}.${agent}`, launch);
        dispatch({
          type: "sessionCreated",
          agentId: agent,
          sessionId: res.sessionId,
          cwd: ws,
          title: "새 대화",
          launch,
          configOptions: res.configOptions ?? [],
          modes: res.modes ?? null,
          lead: lead ? { teamId: team } : undefined,
        });
      } catch (e) {
        const err = toHubError(e);
        dispatch({
          type: "authPrompt",
          prompt: {
            agentId: agent,
            profileId: profileOf(launch),
            message: err.authRequired ? "로그인이 필요합니다." : err.message,
            methods: err.authRequired ? (err.authMethods ?? []) : [],
          },
        });
      } finally {
        creating.current = false;
        setConnecting(null);
      }
    },
    [state.workspace, state.agents, state.missing, addWorkspace, agentMode, teamId],
  );

  /** Switch chat/agent mode or team; an unused draft is recreated to match. */
  const changeMode = useCallback(
    (opts: { lead?: boolean; team?: string }) => {
      if (opts.lead !== undefined) setAgentMode(opts.lead);
      if (opts.team !== undefined) setTeamId(opts.team);
      const current = state.sessions.find((s) => s.key === state.activeKey);
      // A running conversation is reattached with or without Baton's tools; the agent keeps its context.
      if (current && !current.draft && opts.lead !== undefined && opts.lead !== !!current.lead) {
        const team = opts.lead ? (opts.team ?? teamId) : null;
        const teamName = state.teams.find((t) => t.id === team)?.name ?? "자동";
        dispatch({ type: "busy", key: current.key, busy: true });
        api
          .switchMode(current.agentId, current.sessionId, current.cwd, team)
          .then((res) =>
            dispatch({
              type: "modeSwitched",
              key: current.key,
              lead: team ? { teamId: team } : undefined,
              configOptions: res.configOptions,
              note: team ? `에이전트 모드로 전환했어요 · 팀: ${teamName}` : "채팅 모드로 전환했어요",
            }),
          )
          .catch((e) => dispatch({ type: "notice", key: current.key, text: toHubError(e).message, tone: "error" }))
          .finally(() => dispatch({ type: "busy", key: current.key, busy: false }));
        return;
      }
      // A running lead switches team in place; its next delegations use the new roster.
      if (current && !current.draft && current.lead && opts.team !== undefined) {
        dispatch({ type: "leadTeam", key: current.key, teamId: opts.team });
        api.setLeadTeam(current.agentId, current.sessionId, opts.team).catch(() => {});
        return;
      }
      if (current?.draft) newChat(current.cwd, current.agentId, current.launch, opts);
    },
    [state.sessions, state.activeKey, state.teams, teamId, newChat],
  );

  const onImported = useCallback((items: Imported[]) => {
    for (const it of items) {
      dispatch({
        type: "importSession",
        agentId: it.info.agentId,
        sessionId: it.info.sessionId,
        cwd: it.info.cwd,
        launch: { profile: it.info.profileId },
        title: it.title,
        updatedAt: it.updatedAt,
        updates: it.result.updates,
        replayed: it.result.replayed,
        configOptions: it.result.configOptions ?? [],
        modes: it.result.modes ?? null,
        lead: it.teamId ? { teamId: it.teamId } : undefined,
      });
    }
    const first = items[0];
    if (first) dispatch({ type: "activate", key: sessionKey(first.info.agentId, first.info.sessionId) });
  }, []);

  const setConfig = useCallback(async (session: Session, configId: string, value: unknown) => {
    try {
      const res = await api.setConfigOption(session.agentId, session.sessionId, configId, value);
      if (res?.configOptions) dispatch({ type: "configOptions", key: session.key, configOptions: res.configOptions });
    } catch (e) {
      dispatch({ type: "notice", key: session.key, text: toHubError(e).message, tone: "error" });
    }
  }, []);

  const active = state.sessions.find((s) => s.key === state.activeKey) ?? null;

  useEffect(() => setTab("chat"), [state.activeKey]);

  // Find folders that disappeared since last time, before anything tries to use them.
  const [foldersChecked, setFoldersChecked] = useState(false);
  useEffect(() => {
    if (!historyLoaded) return;
    const paths = [...new Set([...state.workspaces, ...state.sessions.map((s) => s.cwd)])];
    api
      .missingPaths(paths)
      .then((missing) => dispatch({ type: "missing", paths: missing }))
      .finally(() => setFoldersChecked(true));
    // Re-check when the folder list changes (e.g. a folder was re-added).
  }, [historyLoaded, state.workspaces]);

  // With a workspace open there is always a chat ready to type into.
  const workspaceMissing = !!state.workspace && state.missing.includes(state.workspace);
  const hasAgent = installedAgents(state.agents).length > 0;
  useEffect(() => {
    if (
      foldersChecked &&
      state.workspace &&
      !workspaceMissing &&
      !active &&
      !connecting &&
      hasAgent &&
      !state.authPrompt
    ) {
      newChat();
    }
  }, [foldersChecked, state.workspace, workspaceMissing, active, connecting, hasAgent, state.authPrompt, newChat]);

  // A conversation restored from disk reconnects to its agent session when opened.
  // One attempt per opening: a failure is recorded and waits for the user's retry.
  useEffect(() => {
    if (!foldersChecked || !active || active.attached || active.draft || active.attachError || active.archived) return;
    if (attaching.current === active.key) return;
    const s = active;
    // A delegated task ran in a worktree that's gone after merge/discard; its chat is a record now.
    if (s.parent && state.missing.includes(s.cwd)) {
      dispatch({ type: "archived", key: s.key });
      return;
    }
    if (state.missing.includes(s.cwd)) {
      dispatch({ type: "attachFailed", key: s.key, error: `작업 폴더를 찾을 수 없어요: ${s.cwd}` });
      return;
    }
    attaching.current = s.key;
    (async () => {
      try {
        const res = s.lead
          ? await api.resumeLeadSession(s.agentId, s.sessionId, s.cwd, s.launch, s.lead.teamId)
          : await api.resumeSession(s.agentId, s.sessionId, s.cwd, s.launch);
        const live = res.configOptions ?? [];
        dispatch({ type: "attached", key: s.key, configOptions: live, modes: res.modes ?? null });
        // Re-apply the model/effort/mode the user had picked.
        for (const prev of s.configOptions) {
          const now = live.find((o) => o.id === prev.id);
          if (now && now.currentValue !== prev.currentValue) await setConfig(s, prev.id, prev.currentValue);
        }
      } catch (e) {
        try {
          const res = await api.newSession(s.agentId, s.cwd, s.launch);
          dispatch({
            type: "rekey",
            key: s.key,
            sessionId: res.sessionId,
            configOptions: res.configOptions ?? [],
            modes: res.modes ?? null,
          });
          saved.current.delete(s.key);
          const home = homeOf(s, state.sessions);
          if (home) api.deleteSession(home, s.key).catch(() => {});
          dispatch({
            type: "notice",
            key: sessionKey(s.agentId, res.sessionId),
            text: `이전 세션을 이어 붙이지 못해 새 세션으로 이어가요. 에이전트는 위 대화를 기억하지 못해요. (${toHubError(e).message})`,
            tone: "info",
          });
        } catch (e2) {
          dispatch({ type: "attachFailed", key: s.key, error: toHubError(e2).message });
        }
      } finally {
        attaching.current = null;
      }
    })();
  }, [active, setConfig, foldersChecked, state.missing]);

  const deleteSession = useCallback(
    async (key: string) => {
      // A lead's task chats go with it.
      const target = state.sessions.find((s) => s.key === key);
      if (!target) return;
      const children = state.sessions.filter((s) => s.parent?.key === key);
      const message =
        (children.length
          ? `이 대화와 하위 작업 ${children.length}개를 삭제할까요?`
          : "이 대화를 삭제할까요?") + " Baton과 에이전트 쪽 기록이 모두 지워지고 되돌릴 수 없어요.";
      const ok = await ask(message, { title: "대화 삭제", kind: "warning" });
      if (!ok) return;
      // Resolve folders before the lead leaves the state.
      const doomed = [target, ...children].map((s) => ({ s, home: homeOf(s, state.sessions) }));
      for (const { s, home } of doomed) {
        dispatch({ type: "closeSession", key: s.key });
        saved.current.delete(s.key);
        if (home) api.deleteSession(home, s.key).catch((e) => console.error("대화 삭제 실패", e));
        // Otherwise "import previous chats" would bring it right back.
        api.deleteAgentSession(s.agentId, s.sessionId, s.cwd, s.launch).catch(() => {});
      }
    },
    [state.sessions],
  );

  const sendPrompt = useCallback(async (session: Session, text: string) => {
    const { key, agentId, sessionId } = session;
    const profileId = profileOf(session.launch);
    // A message typed into a delegated task also reaches its lead.
    if (session.parent) api.taskNote(session.parent.taskId, text).catch(() => {});
    dispatch({ type: "userMessage", key, text });
    dispatch({ type: "busy", key, busy: true });
    const started = performance.now();
    try {
      const res = await api.sendPrompt(agentId, sessionId, text);
      dispatch({
        type: "turnDone",
        key,
        stats: {
          durationMs: performance.now() - started,
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          cachedReadTokens: res.usage?.cachedReadTokens,
        },
      });
      if (res.stopReason === "cancelled") dispatch({ type: "notice", key, text: "중단됨", tone: "info" });
      else if (res.stopReason === "refusal") dispatch({ type: "notice", key, text: "에이전트가 요청을 거절했습니다", tone: "error" });
      else if (res.stopReason !== "end_turn") dispatch({ type: "notice", key, text: `종료: ${res.stopReason}`, tone: "info" });
    } catch (e) {
      const err = toHubError(e);
      dispatch({ type: "notice", key, text: err.message, tone: "error" });
      if (err.authRequired) {
        dispatch({
          type: "authPrompt",
          prompt: { agentId, profileId, message: "로그인이 필요합니다.", methods: err.authMethods ?? [] },
        });
      }
    } finally {
      dispatch({ type: "busy", key, busy: false });
    }
  }, []);

  const cancel = useCallback(
    async (session: Session) => {
      state.permissions
        .filter((p) => sessionKey(p.agentId, p.sessionId) === session.key)
        .forEach((p) => dispatch({ type: "permissionRemove", key: p.key }));
      await api.cancelPrompt(session.agentId, session.sessionId);
    },
    [state.permissions],
  );

  const answerPermission = useCallback(async (key: string, optionId: string | null) => {
    dispatch({ type: "permissionRemove", key });
    try {
      await api.respondPermission(key, optionId);
    } catch {
      // Already resolved (e.g. cancelled); nothing to do.
    }
  }, []);


  const setMode = useCallback(async (session: Session, modeId: string) => {
    try {
      await api.setMode(session.agentId, session.sessionId, modeId);
      dispatch({ type: "mode", key: session.key, modeId });
    } catch (e) {
      dispatch({ type: "notice", key: session.key, text: toHubError(e).message, tone: "error" });
    }
  }, []);

  return (
    <div className={`app ${rail ? "rail-mode" : ""}`}>
      {rail && (
        <TitleBar
          className="full"
          state={state}
          session={active}
          onOpenSession={(key) => dispatch({ type: "activate", key })}
        />
      )}
      <Sidebar
        agents={state.agents}
        workspaces={state.workspaces}
        workspace={state.workspace}
        sessions={state.sessions}
        activeKey={state.activeKey}
        permissions={state.permissions}
        onNewChat={(ws) => newChat(ws)}
        onAddWorkspace={addWorkspace}
        onSelectWorkspace={(path) => dispatch({ type: "workspaceSelect", path })}
        onRemoveWorkspace={(path) => dispatch({ type: "workspaceRemove", path })}
        onImport={setImportCwd}
        missing={state.missing}
        onActivate={(key) => dispatch({ type: "activate", key })}
        onCloseSession={deleteSession}
        rail={rail}
        onToggleRail={() => setRail((r) => !r)}
        onOpenSettings={() => setSettingsTab("accounts")}
      />
      <ChatView
        state={state}
        session={active}
        connecting={
          connecting ?? (active && !active.attached && !active.attachError && !active.archived ? active.agentId : null)
        }
        onRetryAttach={(key) => {
          // Re-check the folder first: it may have been restored.
          const cwd = state.sessions.find((s) => s.key === key)?.cwd;
          api
            .missingPaths(cwd ? [cwd] : [])
            .then((gone) => {
              dispatch({ type: "missing", paths: [...state.missing.filter((m) => m !== cwd), ...gone] });
              dispatch({ type: "attachRetry", key });
            });
        }}
        tab={tab}
        showTitle={!rail}
        onTab={setTab}
        onAddWorkspace={addWorkspace}
        onNewChat={newChat}
        onSend={sendPrompt}
        onCancel={cancel}
        onPermission={answerPermission}
        onSetConfig={setConfig}
        onSetMode={setMode}
        onDismissAuth={() => dispatch({ type: "authPrompt", prompt: null })}
        onOpenAgents={() => setSettingsTab("agents")}
        agentMode={agentMode}
        teamId={teamId}
        onChangeMode={changeMode}
        onOpenSession={(key) => dispatch({ type: "activate", key })}
        banner={update && <UpdateBanner update={update} onDismiss={() => setUpdate(null)} />}
        onMergeTask={(session, taskId) =>
          api
            .mergeTask(taskId)
            .then((r) =>
              dispatch({
                type: "notice",
                key: session.key,
                tone: r.conflicts.length ? "error" : "info",
                text: r.conflicts.length
                  ? `병합했지만 충돌이 있어요: ${r.conflicts.join(", ")}`
                  : `${r.merged_files.length}개 파일을 워크스페이스에 병합했어요`,
              }),
            )
            .catch((e) => dispatch({ type: "notice", key: session.key, text: toHubError(e).message, tone: "error" }))
        }
        onDiscardTask={(session, taskId) =>
          api
            .discardTask(taskId)
            .catch((e) => dispatch({ type: "notice", key: session.key, text: toHubError(e).message, tone: "error" }))
        }
      />
      {isWindows && <WindowControls />}
      {importCwd && (
        <ImportModal
          state={state}
          cwd={importCwd}
          defaultTeam={teamId}
          onImported={onImported}
          onClose={() => setImportCwd(null)}
        />
      )}
      {settingsTab && (
        <SettingsModal
          state={state}
          initialTab={settingsTab}
          onAgentsChanged={(agents) => dispatch({ type: "agents", agents })}
          onProfilesChanged={() => api.listProfiles().then((profiles) => dispatch({ type: "profiles", profiles }))}
          onTeamsChanged={() => api.listTeams().then((teams) => dispatch({ type: "teams", teams }))}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
  );
}
