// Lazy-loaded CodeMirror 6 merge/diff runtime. Imported dynamically by
// CodeEditor.tsx so `@codemirror/merge` stays out of the main bundle (and out
// of the normal editor chunk) until a diff tab is opened.

import {
  Annotation,
  ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge";
import {
  batonHighlightStyle,
  batonTheme,
  editorCopy,
  editorCut,
  editorPaste,
  editorSelectAll,
  extractEditorSelection,
  koreanPhrases,
  lineSeparatorOf,
  loadLanguageExtension,
  placeCursorAtCoordsIfEmpty,
  type EditorSelectionInfo,
} from "./cmEngine";
import { languageForPath, parseDiffTabId } from "./codeHelpers";
import { onTabClosed, onTabRenamed } from "./editorStore";

export type DiffViewMode = "split" | "unified";

export interface DiffCallbacks {
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (key: string) => void;
  onChunksChange: (key: string, count: number) => void;
  onAddToChat?: (key: string, view: EditorView) => void;
  onContextMenu?: (key: string, view: EditorView, x: number, y: number) => void;
}

interface SplitViewHandle {
  kind: "split";
  mergeView: MergeView;
  dom: HTMLElement;
  langA: Compartment;
  langB: Compartment;
  lineSepA: Compartment;
  lineSepB: Compartment;
  editableB: Compartment;
}

interface UnifiedViewHandle {
  kind: "unified";
  editorView: EditorView;
  dom: HTMLElement;
  lang: Compartment;
  lineSep: Compartment;
  editable: Compartment;
}

type DiffViewHandle = SplitViewHandle | UnifiedViewHandle;

export interface DiffSession {
  key: string;
  path: string;
  staged: boolean;
  originalText: string;
  originalMissing: boolean;
  modifiedMissing: boolean;
  savedModifiedText: string;
  savedDoc: Text;
  currentModifiedText: string;
  editable: boolean;
  mode: DiffViewMode;
  chunkCount: number;
  scrollTop: number;
  scrollLeft: number;
  langLoaded: boolean;
  handle: DiffViewHandle;
  callbacks: DiffCallbacks;
}

const DiffExternalReload = Annotation.define<boolean>();

const diffSessions = new Map<string, DiffSession>();

function keyOf(root: string, id: string): string {
  return `${root}\0${id}`;
}

function destroyHandle(handle: DiffViewHandle): void {
  if (handle.kind === "split") {
    handle.mergeView.destroy();
  } else {
    handle.editorView.destroy();
  }
}

function getScrollElement(handle: DiffViewHandle): HTMLElement {
  return handle.kind === "split" ? handle.mergeView.dom : handle.editorView.scrollDOM;
}

function primaryEditorView(handle: DiffViewHandle): EditorView {
  return handle.kind === "split" ? handle.mergeView.b : handle.editorView;
}

function readChunkCount(handle: DiffViewHandle): number {
  const view = primaryEditorView(handle);
  return getChunks(view.state)?.chunks.length ?? 0;
}

const diffTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: "13px",
    lineHeight: "1.55",
  },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "var(--del-bg)",
  },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "var(--add-bg)",
  },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in srgb, var(--danger) 28%, transparent)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--ok) 28%, transparent)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-deletedText": {
    background: "color-mix(in srgb, var(--danger) 24%, transparent)",
    borderRadius: "2px",
  },
  ".cm-deletedChunk": {
    borderLeft: "2px solid var(--danger)",
    paddingLeft: "6px",
  },
  ".cm-changeGutter": {
    width: "3px",
    paddingLeft: "0",
  },
  "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": {
    background: "var(--danger)",
  },
  "&.cm-merge-b .cm-changedLineGutter": {
    background: "var(--ok)",
  },
  ".cm-inlineChangedLineGutter": {
    background: "var(--accent)",
  },
  ".cm-collapsedLines": {
    color: "var(--muted)",
    background: "var(--surface-2)",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    fontFamily: "var(--font)",
    fontSize: "12px",
  },
});

function readOnlyExtension(editable: boolean): Extension {
  return editable
    ? [EditorState.readOnly.of(false), EditorView.editable.of(true)]
    : [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: "0" }),
      ];
}

function commonDisplayExtensions(
  langCompartment: Compartment,
  lineSepCompartment: Compartment,
  sep: string,
  navKeymap: Extension,
  getSession: () => DiffSession | undefined,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    syntaxHighlighting(batonHighlightStyle, { fallback: true }),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    koreanPhrases,
    batonTheme,
    diffTheme,
    lineSepCompartment.of(EditorState.lineSeparator.of(sep)),
    langCompartment.of([]),
    navKeymap,
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".cm-panel") || target?.closest(".cm-gutters")) return false;
        const s = getSession();
        if (!s?.callbacks.onContextMenu) return false;
        event.preventDefault();
        event.stopPropagation();
        placeCursorAtCoordsIfEmpty(view, event.clientX, event.clientY);
        s.callbacks.onContextMenu(s.key, view, event.clientX, event.clientY);
        return true;
      },
    }),
  ];
}

function makeNavKeymap(getSession: () => DiffSession | undefined, allowSave: boolean): Extension {
  return keymap.of([
    ...(allowSave
      ? [
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              const s = getSession();
              if (s && s.editable) {
                s.callbacks.onSave(s.key);
              }
              return true;
            },
          },
        ]
      : []),
    {
      key: "Mod-l",
      preventDefault: true,
      run: (view) => {
        const s = getSession();
        if (s) s.callbacks.onAddToChat?.(s.key, view);
        return true;
      },
    },
    {
      key: "F7",
      preventDefault: true,
      run: () => {
        const s = getSession();
        if (s) navigateDiffChunk(s.key, 1);
        return true;
      },
    },
    {
      key: "Shift-F7",
      preventDefault: true,
      run: () => {
        const s = getSession();
        if (s) navigateDiffChunk(s.key, -1);
        return true;
      },
    },
    ...searchKeymap,
  ]);
}

function makeEditableExtensions(
  editableComp: Compartment,
  editable: boolean,
  getSession: () => DiffSession | undefined,
): Extension[] {
  return [
    history(),
    dropCursor(),
    indentOnInput(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    editableComp.of(readOnlyExtension(editable)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      const s = getSession();
      if (!s) return;

      const count = getChunks(update.state)?.chunks.length ?? 0;
      if (count !== s.chunkCount) {
        s.chunkCount = count;
        s.callbacks.onChunksChange(s.key, count);
      }

      if (!update.docChanged) return;
      s.currentModifiedText = update.state.doc.toString();
      if (update.transactions.some((tr) => tr.annotation(DiffExternalReload))) return;
      if (!s.editable) return;
      const dirty = !update.state.doc.eq(s.savedDoc);
      s.callbacks.onDirtyChange(s.key, dirty);
    }),
  ];
}

function buildHandle(
  sessionRef: { current: DiffSession | undefined },
  mode: DiffViewMode,
  originalText: string,
  modifiedText: string,
  editable: boolean,
): DiffViewHandle {
  const getSession = () => sessionRef.current;

  if (mode === "split") {
    const langA = new Compartment();
    const langB = new Compartment();
    const lineSepA = new Compartment();
    const lineSepB = new Compartment();
    const editableB = new Compartment();

    const mergeView = new MergeView({
      a: {
        doc: originalText,
        extensions: [
          ...commonDisplayExtensions(
            langA,
            lineSepA,
            lineSeparatorOf(originalText),
            makeNavKeymap(getSession, false),
            getSession,
          ),
          readOnlyExtension(false),
        ],
      },
      b: {
        doc: modifiedText,
        extensions: [
          ...commonDisplayExtensions(
            langB,
            lineSepB,
            lineSeparatorOf(modifiedText),
            makeNavKeymap(getSession, true),
            getSession,
          ),
          ...makeEditableExtensions(editableB, editable, getSession),
        ],
      },
      highlightChanges: true,
      gutter: true,
    });

    return {
      kind: "split",
      mergeView,
      dom: mergeView.dom,
      langA,
      langB,
      lineSepA,
      lineSepB,
      editableB,
    };
  }

  const lang = new Compartment();
  const lineSep = new Compartment();
  const editableComp = new Compartment();

  const editorView = new EditorView({
    state: EditorState.create({
      doc: modifiedText,
      extensions: [
        ...commonDisplayExtensions(
          lang,
          lineSep,
          lineSeparatorOf(modifiedText),
          makeNavKeymap(getSession, true),
          getSession,
        ),
        ...makeEditableExtensions(editableComp, editable, getSession),
        unifiedMergeView({
          original: originalText,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
        }),
      ],
    }),
  });

  return {
    kind: "unified",
    editorView,
    dom: editorView.dom,
    lang,
    lineSep,
    editable: editableComp,
  };
}

async function attachDiffLanguage(session: DiffSession): Promise<void> {
  if (session.langLoaded) return;
  const lang = languageForPath(session.path);
  if (!lang) {
    session.langLoaded = true;
    return;
  }
  try {
    const ext = await loadLanguageExtension(lang);
    const current = diffSessions.get(session.key);
    if (!current || current !== session || current.langLoaded) return;
    current.langLoaded = true;
    applyLanguageExtension(current.handle, ext);
  } catch {
    // Plain text fallback if language chunk fails to load.
  }
}

function applyLanguageExtension(handle: DiffViewHandle, ext: Extension): void {
  if (handle.kind === "split") {
    handle.mergeView.a.dispatch({ effects: handle.langA.reconfigure(ext) });
    handle.mergeView.b.dispatch({ effects: handle.langB.reconfigure(ext) });
  } else {
    handle.editorView.dispatch({ effects: handle.lang.reconfigure(ext) });
  }
}

onTabClosed((root, id) => {
  const k = keyOf(root, id);
  const session = diffSessions.get(k);
  if (session) {
    destroyHandle(session.handle);
    diffSessions.delete(k);
  }
});

onTabRenamed((root, fromId, toId) => {
  const oldKey = keyOf(root, fromId);
  const newKey = keyOf(root, toId);
  if (oldKey === newKey) return;
  const session = diffSessions.get(oldKey);
  if (!session) return;

  const parsed = parseDiffTabId(toId);
  const nextPath = parsed ? parsed.path : toId;
  const prevLang = languageForPath(session.path);
  const nextLang = languageForPath(nextPath);

  diffSessions.delete(oldKey);
  session.key = newKey;
  session.path = nextPath;
  diffSessions.set(newKey, session);

  if (prevLang !== nextLang) {
    session.langLoaded = false;
    if (nextLang === null) {
      applyLanguageExtension(session.handle, []);
      session.langLoaded = true;
    } else {
      void attachDiffLanguage(session);
    }
  }
});

export function getDiffSession(key: string): DiffSession | undefined {
  return diffSessions.get(key);
}

/** Create or update a diff session for `(key, path, staged)` with fresh texts. */
export function ensureDiffSession(
  key: string,
  path: string,
  staged: boolean,
  original: string | null,
  modified: string | null,
  mode: DiffViewMode,
  callbacks: DiffCallbacks,
): DiffSession {
  const originalText = original ?? "";
  const modifiedText = modified ?? "";
  const originalMissing = original === null;
  const modifiedMissing = modified === null;
  const editable = !staged && !modifiedMissing;

  const existing = diffSessions.get(key);
  if (existing) {
    existing.callbacks = callbacks;
    reloadDiffSessionTexts(key, original, modified);
    if (existing.mode !== mode) {
      setDiffSessionMode(key, mode);
    }
    return existing;
  }

  const sessionRef: { current: DiffSession | undefined } = { current: undefined };
  const handle = buildHandle(sessionRef, mode, originalText, modifiedText, editable);
  const view = primaryEditorView(handle);
  const chunkCount = readChunkCount(handle);

  const session: DiffSession = {
    key,
    path,
    staged,
    originalText,
    originalMissing,
    modifiedMissing,
    savedModifiedText: modifiedText,
    savedDoc: view.state.doc,
    currentModifiedText: modifiedText,
    editable,
    mode,
    chunkCount,
    scrollTop: 0,
    scrollLeft: 0,
    langLoaded: false,
    handle,
    callbacks,
  };
  sessionRef.current = session;
  diffSessions.set(key, session);
  void attachDiffLanguage(session);
  return session;
}

/** Replace both original and modified documents in place while keeping scroll & cursor. */
export function reloadDiffSessionTexts(
  key: string,
  original: string | null,
  modified: string | null,
): void {
  const session = diffSessions.get(key);
  if (!session) return;

  const originalText = original ?? "";
  const modifiedText = modified ?? "";
  const originalMissing = original === null;
  const modifiedMissing = modified === null;
  const editable = !session.staged && !modifiedMissing;

  const scrollEl = getScrollElement(session.handle);
  const scrollTop = scrollEl.scrollTop;
  const scrollLeft = scrollEl.scrollLeft;

  session.originalText = originalText;
  session.originalMissing = originalMissing;
  session.modifiedMissing = modifiedMissing;
  session.savedModifiedText = modifiedText;
  session.currentModifiedText = modifiedText;
  session.editable = editable;

  if (session.handle.kind === "split") {
    const { mergeView, lineSepA, lineSepB, editableB } = session.handle;
    const stateA = mergeView.a.state;
    const stateB = mergeView.b.state;

    if (stateA.doc.toString() !== originalText) {
      mergeView.a.dispatch({
        changes: { from: 0, to: stateA.doc.length, insert: originalText },
        effects: lineSepA.reconfigure(EditorState.lineSeparator.of(lineSeparatorOf(originalText))),
        annotations: DiffExternalReload.of(true),
      });
    }

    const sel = stateB.selection.main;
    const normLen = modifiedText.replace(/\r\n/g, "\n").length;
    const anchor = Math.max(0, Math.min(sel.anchor, normLen));
    const head = Math.max(0, Math.min(sel.head, normLen));

    mergeView.b.dispatch({
      changes:
        stateB.doc.toString() !== modifiedText
          ? { from: 0, to: stateB.doc.length, insert: modifiedText }
          : undefined,
      selection: { anchor, head },
      effects: [
        lineSepB.reconfigure(EditorState.lineSeparator.of(lineSeparatorOf(modifiedText))),
        editableB.reconfigure(readOnlyExtension(editable)),
      ],
      annotations: DiffExternalReload.of(true),
    });
    session.savedDoc = mergeView.b.state.doc;
  } else {
    const { editorView, lineSep, editable: editableComp } = session.handle;
    const state = editorView.state;
    const origDoc = getOriginalDoc(state);
    const sel = state.selection.main;
    const normLen = modifiedText.replace(/\r\n/g, "\n").length;
    const anchor = Math.max(0, Math.min(sel.anchor, normLen));
    const head = Math.max(0, Math.min(sel.head, normLen));

    const effects = [
      lineSep.reconfigure(EditorState.lineSeparator.of(lineSeparatorOf(modifiedText))),
      editableComp.reconfigure(readOnlyExtension(editable)),
    ];
    if (origDoc.toString() !== originalText) {
      const origChanges = ChangeSet.of(
        { from: 0, to: origDoc.length, insert: originalText },
        origDoc.length,
      );
      effects.push(originalDocChangeEffect(state, origChanges));
    }

    editorView.dispatch({
      changes:
        state.doc.toString() !== modifiedText
          ? { from: 0, to: state.doc.length, insert: modifiedText }
          : undefined,
      selection: { anchor, head },
      effects,
      annotations: DiffExternalReload.of(true),
    });
    session.savedDoc = editorView.state.doc;
  }

  session.chunkCount = readChunkCount(session.handle);
  session.callbacks.onChunksChange(session.key, session.chunkCount);

  requestAnimationFrame(() => {
    scrollEl.scrollTop = scrollTop;
    scrollEl.scrollLeft = scrollLeft;
  });
}

/** Switch a diff session between side-by-side (`split`) and inline (`unified`) while keeping edits and scroll. */
export function setDiffSessionMode(key: string, nextMode: DiffViewMode): void {
  const session = diffSessions.get(key);
  if (!session || session.mode === nextMode) return;

  const oldScroll = getScrollElement(session.handle);
  const scrollTop = oldScroll.scrollTop;
  const scrollLeft = oldScroll.scrollLeft;
  const oldPrimary = primaryEditorView(session.handle);
  const currentText = oldPrimary.state.doc.toString();
  const sel = oldPrimary.state.selection.main;
  const parent = session.handle.dom.parentElement;

  destroyHandle(session.handle);

  const sessionRef: { current: DiffSession | undefined } = { current: session };
  const nextHandle = buildHandle(
    sessionRef,
    nextMode,
    session.originalText,
    currentText,
    session.editable,
  );
  session.handle = nextHandle;
  session.mode = nextMode;
  session.currentModifiedText = currentText;
  session.savedDoc = EditorState.create({
    doc: session.savedModifiedText,
    extensions: [EditorState.lineSeparator.of(lineSeparatorOf(session.savedModifiedText))],
  }).doc;
  session.langLoaded = false;

  const nextPrimary = primaryEditorView(nextHandle);
  const maxPos = nextPrimary.state.doc.length;
  nextPrimary.dispatch({
    selection: {
      anchor: Math.max(0, Math.min(sel.anchor, maxPos)),
      head: Math.max(0, Math.min(sel.head, maxPos)),
    },
    annotations: DiffExternalReload.of(true),
  });

  if (parent) {
    parent.replaceChildren(nextHandle.dom);
  }

  void attachDiffLanguage(session);

  session.chunkCount = readChunkCount(nextHandle);
  session.callbacks.onChunksChange(session.key, session.chunkCount);

  requestAnimationFrame(() => {
    if (nextHandle.kind === "split") {
      nextHandle.mergeView.a.requestMeasure();
      nextHandle.mergeView.b.requestMeasure();
    } else {
      nextHandle.editorView.requestMeasure();
    }
    const el = getScrollElement(nextHandle);
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
  });
}

/** Attach a diff session's live DOM into `host`, re-measuring and restoring its scroll position. */
export function mountDiffSession(
  host: HTMLElement,
  session: DiffSession,
  mode: DiffViewMode,
  callbacks: DiffCallbacks,
): void {
  session.callbacks = callbacks;
  if (session.mode !== mode) {
    setDiffSessionMode(session.key, mode);
  }
  if (session.handle.dom.parentElement !== host) {
    host.replaceChildren(session.handle.dom);
  }
  if (!session.langLoaded) {
    void attachDiffLanguage(session);
  }

  const { scrollTop, scrollLeft, handle } = session;
  requestAnimationFrame(() => {
    if (handle.dom.parentElement !== host) return;
    if (handle.kind === "split") {
      handle.mergeView.a.requestMeasure();
      handle.mergeView.b.requestMeasure();
    } else {
      handle.editorView.requestMeasure();
    }
    const el = getScrollElement(handle);
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
  });
}

/** Snapshot scroll position and detach a diff session's DOM without destroying its state. */
export function detachDiffSession(key: string): void {
  const session = diffSessions.get(key);
  if (!session) return;
  const scrollEl = getScrollElement(session.handle);
  session.scrollTop = scrollEl.scrollTop;
  session.scrollLeft = scrollEl.scrollLeft;
  if (session.handle.dom.parentElement) {
    session.handle.dom.parentElement.removeChild(session.handle.dom);
  }
}

/** Return the current modified buffer text of a diff session. */
export function getDiffModifiedText(key: string): string | null {
  const session = diffSessions.get(key);
  if (!session) return null;
  return primaryEditorView(session.handle).state.doc.toString();
}

/** Mark the current modified buffer of an unstaged diff session as cleanly saved. */
export function markDiffSessionSaved(key: string): void {
  const session = diffSessions.get(key);
  if (!session) return;
  const doc = primaryEditorView(session.handle).state.doc;
  session.savedDoc = doc;
  session.savedModifiedText = doc.toString();
  session.currentModifiedText = session.savedModifiedText;
}

/** Jump to the next (`dir = 1`) or previous (`dir = -1`) changed chunk. */
export function navigateDiffChunk(key: string, dir: 1 | -1): void {
  const session = diffSessions.get(key);
  if (!session) return;

  let targetView: EditorView;
  if (session.handle.kind === "split") {
    const { a, b } = session.handle.mergeView;
    targetView = b.state.doc.length === 0 && a.state.doc.length > 0 ? a : b;
  } else {
    targetView = session.handle.editorView;
  }

  const info = getChunks(targetView.state);
  if (!info || info.chunks.length === 0) return;

  const moved = dir > 0 ? goToNextChunk(targetView) : goToPreviousChunk(targetView);
  if (!moved) {
    // When there is a single chunk and the cursor is already inside it, scroll it into view anyway.
    const chunk = info.chunks[0];
    const pos = info.side === "a" ? chunk.fromA : chunk.fromB;
    const clamped = Math.max(0, Math.min(pos, targetView.state.doc.length));
    targetView.dispatch({
      selection: { anchor: clamped },
      effects: EditorView.scrollIntoView(clamped, { y: "center" }),
    });
  }
  targetView.focus();
}

/** Return the currently focused (or primary) `EditorView` of a mounted diff session. */
export function getActiveDiffEditorView(key: string): EditorView | null {
  const session = diffSessions.get(key);
  if (!session) return null;
  if (session.handle.kind === "unified") {
    return session.handle.editorView;
  }
  const { a, b } = session.handle.mergeView;
  if (a.hasFocus) return a;
  if (b.hasFocus) return b;
  const activeEl = typeof document !== "undefined" ? document.activeElement : null;
  if (activeEl instanceof Node) {
    if (a.dom.contains(activeEl)) return a;
    if (b.dom.contains(activeEl)) return b;
  }
  return b.state.doc.length === 0 && a.state.doc.length > 0 ? a : b;
}

export {
  editorCopy,
  editorCut,
  editorPaste,
  editorSelectAll,
  extractEditorSelection,
  type EditorSelectionInfo,
};
