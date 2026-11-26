// Lazy-loaded CodeMirror 6 runtime. Imported dynamically by CodeEditor.tsx so
// CodeMirror stays out of the main bundle until a text file is opened.

import {
  Annotation,
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
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { languageForPath, type LanguageId } from "./codeHelpers";
import { isExtensionLanguageId, loadExtensionLanguage } from "../../extensions/languages";
import { onExtensionsChanged } from "../../extensions/registry";
import { onTabClosed, onTabRenamed } from "./editorStore";
import { gitChangeGutter, setGitBase } from "./gitGutter";
import { applyBlameHunks, blameExtension, blameStamp, configureBlame } from "./blameGutter";

export { applyBlameHunks, blameStamp, configureBlame };

export interface EngineCallbacks {
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (key: string) => void;
  onAddToChat?: (key: string, view: EditorView) => void;
  onContextMenu?: (key: string, view: EditorView, x: number, y: number) => void;
  onGitMarkerClick?: (key: string, line: number) => void;
}

export interface EditorSelectionInfo {
  hasSelection: boolean;
  startLine: number;
  endLine: number;
  text: string;
  readOnly: boolean;
}

export interface TabSession {
  key: string;
  path: string;
  state: EditorState;
  savedDoc: Text;
  scrollTop: number;
  scrollLeft: number;
  langCompartment: Compartment;
  lineSepCompartment: Compartment;
  langLoaded: boolean;
  langId: LanguageId;
  langVersion: number;
}

const ExternalReload = Annotation.define<boolean>();

const sessions = new Map<string, TabSession>();
const langCache = new Map<Exclude<LanguageId, null>, Promise<Extension>>();
const viewMeta = new WeakMap<EditorView, { key: string; callbacks: EngineCallbacks }>();
const activeViews = new Map<string, EditorView>();

onTabClosed((root, path) => {
  const k = tabKey(root, path);
  sessions.delete(k);
  activeViews.delete(k);
});

onTabRenamed((root, from, to) => {
  const oldKey = tabKey(root, from);
  const newKey = tabKey(root, to);
  if (oldKey === newKey) return;
  const session = sessions.get(oldKey);
  if (!session) return;

  const prevLang = languageForPath(session.path);
  const nextLang = languageForPath(to);
  const view = activeViews.get(oldKey) ?? null;
  if (view) {
    saveViewSnapshot(view);
    activeViews.delete(oldKey);
    activeViews.set(newKey, view);
    const meta = viewMeta.get(view);
    if (meta) viewMeta.set(view, { ...meta, key: newKey });
  }

  sessions.delete(oldKey);
  session.key = newKey;
  session.path = to;
  sessions.set(newKey, session);

  if (prevLang !== nextLang) {
    session.langVersion++;
    session.langLoaded = false;
    if (nextLang === null) {
      const effect = session.langCompartment.reconfigure([]);
      if (view && viewMeta.get(view)?.key === newKey) {
        view.dispatch({ effects: effect });
        session.state = view.state;
      } else {
        session.state = session.state.update({ effects: effect }).state;
      }
      session.langId = null;
      session.langLoaded = true;
    } else {
      void attachLanguage(session, view);
    }
  }
});

onExtensionsChanged(() => {
  for (const key of [...langCache.keys()]) {
    if (isExtensionLanguageId(key)) langCache.delete(key);
  }
  for (const session of sessions.values()) {
    const nextLang = languageForPath(session.path);
    if (session.langId === nextLang && !isExtensionLanguageId(nextLang)) continue;
    session.langVersion++;
    session.langLoaded = false;
    const view = activeViews.get(session.key) ?? null;
    if (nextLang === null) {
      const effect = session.langCompartment.reconfigure([]);
      if (view && viewMeta.get(view)?.key === session.key) {
        view.dispatch({ effects: effect });
        session.state = view.state;
      } else {
        session.state = session.state.update({ effects: effect }).state;
      }
      session.langId = null;
      session.langLoaded = true;
    } else {
      void attachLanguage(session, view);
    }
  }
});

export function tabKey(root: string, path: string): string {
  return `${root}\0${path}`;
}

export function getSession(key: string): TabSession | undefined {
  return sessions.get(key);
}

export function deleteSession(key: string): void {
  sessions.delete(key);
}

export const koreanPhrases = EditorState.phrases.of({
  Find: "찾기",
  Replace: "바꾸기",
  next: "다음",
  previous: "이전",
  all: "모두",
  "match case": "대소문자",
  "by word": "단어",
  regexp: "정규식",
  replace: "바꾸기",
  "replace all": "모두 바꾸기",
  close: "닫기",
  "current match": "현재 일치",
  "replaced $ matches": "$건 바꿨어요",
  "replaced match on line $": "$번 줄에서 바꿨어요",
  "on line": "줄",
  "$ unchanged lines": "변경 없는 $줄 펼치기",
});

export const batonHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "var(--cm-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--cm-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--cm-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.macroName], color: "var(--cm-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--cm-func)" },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: "var(--cm-var)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--cm-prop)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--cm-op)" },
  { tag: [tags.tagName], color: "var(--cm-tag)" },
  { tag: [tags.heading], color: "var(--cm-heading)", fontWeight: "600" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [tags.invalid], color: "var(--danger)" },
]);

export const batonTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: "13px",
    lineHeight: "1.55",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--mono)",
  },
  ".cm-content": {
    caretColor: "var(--text)",
    padding: "8px 0 40px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text)",
    borderLeftWidth: "1.5px",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--hover)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 10px 0 12px",
    minWidth: "40px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--hover)",
    color: "var(--text-2)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--border)",
    borderRadius: "2px",
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--warn) 28%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--warn) 55%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    borderColor: "var(--border)",
    fontFamily: "var(--font)",
    fontSize: "12.5px",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    padding: "6px 10px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 6px",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontFamily: "var(--font)",
    fontSize: "12px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    backgroundColor: "var(--surface-2)",
    color: "var(--text)",
    padding: "3px 7px",
    margin: "0",
  },
  ".cm-panel.cm-search input:focus": {
    outline: "none",
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search button": {
    backgroundImage: "none",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button:hover": {
    backgroundColor: "var(--surface-3)",
  },
  ".cm-panel.cm-search button[name=close]": {
    border: "0",
    backgroundColor: "transparent",
    color: "var(--muted)",
    fontSize: "16px",
    padding: "0 4px",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    color: "var(--text-2)",
  },
});

export async function loadLanguageExtension(lang: Exclude<LanguageId, null>): Promise<Extension> {
  let promise = langCache.get(lang);
  if (!promise) {
    promise = (async (): Promise<Extension> => {
      if (isExtensionLanguageId(lang)) {
        return loadExtensionLanguage(lang);
      }
      switch (lang) {
        case "typescript": {
          const { javascript } = await import("@codemirror/lang-javascript");
          return javascript({ typescript: true });
        }
        case "tsx": {
          const { javascript } = await import("@codemirror/lang-javascript");
          return javascript({ typescript: true, jsx: true });
        }
        case "javascript": {
          const { javascript } = await import("@codemirror/lang-javascript");
          return javascript();
        }
        case "jsx": {
          const { javascript } = await import("@codemirror/lang-javascript");
          return javascript({ jsx: true });
        }
        case "rust": {
          const { rust } = await import("@codemirror/lang-rust");
          return rust();
        }
        case "python": {
          const { python } = await import("@codemirror/lang-python");
          return python();
        }
        case "json": {
          const { json } = await import("@codemirror/lang-json");
          return json();
        }
        case "css": {
          const { css } = await import("@codemirror/lang-css");
          return css();
        }
        case "html": {
          const { html } = await import("@codemirror/lang-html");
          return html();
        }
        case "markdown": {
          const { markdown } = await import("@codemirror/lang-markdown");
          return markdown();
        }
        case "yaml": {
          const { yaml } = await import("@codemirror/lang-yaml");
          return yaml();
        }
        case "toml": {
          const { toml } = await import("@codemirror/legacy-modes/mode/toml");
          return StreamLanguage.define(toml);
        }
      }
    })();
    langCache.set(lang, promise);
  }
  return promise;
}

export function lineSeparatorOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function baseExtensions(langCompartment: Compartment, lineSepCompartment: Compartment, sep: string): Extension[] {
  return [
    blameExtension(),
    lineNumbers(),
    gitChangeGutter({
      onMarkerClick: (view, line) => {
        const meta = viewMeta.get(view);
        if (meta) meta.callbacks.onGitMarkerClick?.(meta.key, line);
      },
    }),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(batonHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    koreanPhrases,
    batonTheme,
    lineSepCompartment.of(EditorState.lineSeparator.of(sep)),
    langCompartment.of([]),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: (view) => {
          const meta = viewMeta.get(view);
          if (meta) meta.callbacks.onSave(meta.key);
          return true;
        },
      },
      {
        key: "Mod-l",
        preventDefault: true,
        run: (view) => {
          const meta = viewMeta.get(view);
          if (meta) meta.callbacks.onAddToChat?.(meta.key, view);
          return true;
        },
      },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".cm-panel") || target?.closest(".cm-gutters")) return false;
        const meta = viewMeta.get(view);
        if (!meta?.callbacks.onContextMenu) return false;
        event.preventDefault();
        event.stopPropagation();
        placeCursorAtCoordsIfEmpty(view, event.clientX, event.clientY);
        meta.callbacks.onContextMenu(meta.key, view, event.clientX, event.clientY);
        return true;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.some((tr) => tr.annotation(ExternalReload))) return;
      const meta = viewMeta.get(update.view);
      if (!meta) return;
      const session = sessions.get(meta.key);
      if (!session) return;
      session.state = update.state;
      const dirty = !update.state.doc.eq(session.savedDoc);
      meta.callbacks.onDirtyChange(meta.key, dirty);
    }),
  ];
}

/** Create or return a tab's cached `EditorState` session, loading its language lazily. */
export function ensureTabSession(
  key: string,
  path: string,
  text: string,
  activeView: EditorView | null,
): TabSession {
  const existing = sessions.get(key);
  if (existing) return existing;

  const langCompartment = new Compartment();
  const lineSepCompartment = new Compartment();
  const sep = lineSeparatorOf(text);
  const state = EditorState.create({
    doc: text,
    extensions: baseExtensions(langCompartment, lineSepCompartment, sep),
  });
  const session: TabSession = {
    key,
    path,
    state,
    savedDoc: state.doc,
    scrollTop: 0,
    scrollLeft: 0,
    langCompartment,
    lineSepCompartment,
    langLoaded: false,
    langId: null,
    langVersion: 0,
  };
  sessions.set(key, session);
  void attachLanguage(session, activeView);
  return session;
}

async function attachLanguage(session: TabSession, maybeView: EditorView | null): Promise<void> {
  if (session.langLoaded) return;
  const ver = session.langVersion;
  const lang = languageForPath(session.path);
  if (!lang) {
    session.langId = null;
    session.langLoaded = true;
    return;
  }
  try {
    const ext = await loadLanguageExtension(lang);
    const current = sessions.get(session.key);
    if (!current || current !== session || current.langVersion !== ver || current.langLoaded) return;
    current.langId = lang;
    current.langLoaded = true;
    const effect = current.langCompartment.reconfigure(ext);
    const targetView =
      activeViews.get(session.key) ??
      (maybeView && viewMeta.get(maybeView)?.key === session.key ? maybeView : null);
    if (targetView && viewMeta.get(targetView)?.key === session.key) {
      targetView.dispatch({ effects: effect });
      current.state = targetView.state;
    } else {
      current.state = current.state.update({ effects: effect }).state;
    }
  } catch {
    // Plain text fallback if a language chunk fails to load.
  }
}

export function createEditorView(
  parent: HTMLElement,
  session: TabSession,
  callbacks: EngineCallbacks,
): EditorView {
  const view = new EditorView({ state: session.state, parent });
  viewMeta.set(view, { key: session.key, callbacks });
  activeViews.set(session.key, view);
  if (!session.langLoaded) {
    void attachLanguage(session, view);
  }
  requestAnimationFrame(() => {
    if (viewMeta.get(view)?.key === session.key) {
      view.scrollDOM.scrollTop = session.scrollTop;
      view.scrollDOM.scrollLeft = session.scrollLeft;
    }
  });
  return view;
}

/** Forget an `EditorView` from active-view tracking before destroying it. */
export function releaseView(view: EditorView): void {
  const meta = viewMeta.get(view);
  if (meta && activeViews.get(meta.key) === view) {
    activeViews.delete(meta.key);
  }
}

/** Snapshot scroll & EditorState of the outgoing tab before switching or unmounting. */
export function saveViewSnapshot(view: EditorView): void {
  const meta = viewMeta.get(view);
  if (!meta) return;
  const session = sessions.get(meta.key);
  if (!session) return;
  session.state = view.state;
  session.scrollTop = view.scrollDOM.scrollTop;
  session.scrollLeft = view.scrollDOM.scrollLeft;
}

/** Switch an existing `EditorView` to another tab's `TabSession`, keeping both states intact. */
export function switchViewSession(
  view: EditorView,
  next: TabSession,
  callbacks: EngineCallbacks,
): void {
  const prevMeta = viewMeta.get(view);
  if (prevMeta?.key === next.key) {
    viewMeta.set(view, { key: next.key, callbacks });
    activeViews.set(next.key, view);
    if (!next.langLoaded) {
      void attachLanguage(next, view);
    }
    return;
  }
  saveViewSnapshot(view);
  if (prevMeta && activeViews.get(prevMeta.key) === view) {
    activeViews.delete(prevMeta.key);
  }
  viewMeta.set(view, { key: next.key, callbacks });
  activeViews.set(next.key, view);
  view.setState(next.state);
  if (!next.langLoaded) {
    void attachLanguage(next, view);
  }
  requestAnimationFrame(() => {
    if (viewMeta.get(view)?.key === next.key) {
      view.scrollDOM.scrollTop = next.scrollTop;
      view.scrollDOM.scrollLeft = next.scrollLeft;
    }
  });
}

/** Return the full text of a tab (preserving its line separator). */
export function getSessionText(key: string, view: EditorView | null): string | null {
  if (view && viewMeta.get(view)?.key === key) {
    return view.state.doc.toString();
  }
  return sessions.get(key)?.state.doc.toString() ?? null;
}

/** Mark the current buffer text as saved cleanly. */
export function markSessionSaved(key: string, view: EditorView | null): void {
  const session = sessions.get(key);
  if (!session) return;
  if (view && viewMeta.get(view)?.key === key) {
    session.state = view.state;
  }
  session.savedDoc = session.state.doc;
}

/** Update the git base text stored in a tab's editor state for gutter change markers. */
export function setSessionGitBase(key: string, base: string | null, view: EditorView | null): void {
  const session = sessions.get(key);
  if (!session) return;
  const effect = setGitBase.of(base);
  const targetView = view && viewMeta.get(view)?.key === key ? view : (activeViews.get(key) ?? null);
  if (targetView && viewMeta.get(targetView)?.key === key) {
    targetView.dispatch({ effects: effect });
    session.state = targetView.state;
  } else {
    session.state = session.state.update({ effects: effect }).state;
  }
}

/** Replace a tab's buffer with fresh text from disk while preserving cursor and scroll. */
export function reloadSessionText(key: string, newText: string, view: EditorView | null): void {
  const session = sessions.get(key);
  if (!session) return;
  const isAttached = !!view && viewMeta.get(view)?.key === key;
  const state = isAttached ? view.state : session.state;
  const scrollTop = isAttached ? view.scrollDOM.scrollTop : session.scrollTop;
  const scrollLeft = isAttached ? view.scrollDOM.scrollLeft : session.scrollLeft;

  const sep = lineSeparatorOf(newText);
  const sel = state.selection.main;
  const normalizedLen = newText.replace(/\r\n/g, "\n").length;
  const anchor = Math.max(0, Math.min(sel.anchor, normalizedLen));
  const head = Math.max(0, Math.min(sel.head, normalizedLen));

  const spec = {
    changes: { from: 0, to: state.doc.length, insert: newText },
    selection: { anchor, head },
    effects: session.lineSepCompartment.reconfigure(EditorState.lineSeparator.of(sep)),
    annotations: ExternalReload.of(true),
  };

  if (isAttached) {
    view.dispatch(spec);
    session.state = view.state;
    session.savedDoc = view.state.doc;
    requestAnimationFrame(() => {
      if (viewMeta.get(view)?.key === key) {
        view.scrollDOM.scrollTop = scrollTop;
        view.scrollDOM.scrollLeft = scrollLeft;
      }
    });
  } else {
    const tr = state.update(spec);
    session.state = tr.state;
    session.savedDoc = tr.state.doc;
  }
}

/** Scroll to and place the cursor at a 1-based line number. */
export function jumpToLine(view: EditorView, line: number): void {
  const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
  const info = view.state.doc.line(clamped);
  view.dispatch({
    selection: { anchor: info.from },
    effects: EditorView.scrollIntoView(info.from, { y: "center" }),
  });
  view.focus();
}

/** If the editor has no selection, place the cursor at the clicked coordinates. */
export function placeCursorAtCoordsIfEmpty(view: EditorView, x: number, y: number): void {
  if (!view.state.selection.main.empty) return;
  const pos = view.posAtCoords({ x, y });
  if (pos !== null && pos !== view.state.selection.main.head) {
    view.dispatch({ selection: { anchor: pos } });
  }
}

/** Extract the main selection (or current line when nothing is selected) from a CodeMirror view. */
export function extractEditorSelection(view: EditorView): EditorSelectionInfo {
  const { state } = view;
  const sel = state.selection.main;
  const readOnly = state.readOnly;
  if (!sel.empty) {
    const startLineObj = state.doc.lineAt(sel.from);
    const endLineObj = state.doc.lineAt(sel.to);
    let endLine = endLineObj.number;
    let sliceEnd = sel.to;
    if (endLineObj.from === sel.to && endLine > startLineObj.number) {
      endLine -= 1;
      sliceEnd = state.doc.line(endLine).to;
    }
    return {
      hasSelection: true,
      startLine: startLineObj.number,
      endLine,
      text: state.doc.sliceString(sel.from, sliceEnd),
      readOnly,
    };
  }
  const line = state.doc.lineAt(sel.head);
  return {
    hasSelection: false,
    startLine: line.number,
    endLine: line.number,
    text: line.text,
    readOnly,
  };
}

function selectedTextForClipboard(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

export async function editorCopy(view: EditorView): Promise<void> {
  const text = selectedTextForClipboard(view);
  if (text) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
  }
  view.focus();
}

export async function editorCut(view: EditorView): Promise<void> {
  if (view.state.readOnly) return;
  const text = selectedTextForClipboard(view);
  if (!text) {
    view.focus();
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    view.focus();
    return;
  }
  view.dispatch({
    ...view.state.replaceSelection(""),
    scrollIntoView: true,
    userEvent: "delete.cut",
  });
  view.focus();
}

export async function editorPaste(view: EditorView): Promise<void> {
  if (view.state.readOnly) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      view.dispatch({
        ...view.state.replaceSelection(text),
        scrollIntoView: true,
        userEvent: "input.paste",
      });
    }
  } catch {
    // Ignore clipboard read denials or non-text clipboard contents.
  }
  view.focus();
}

export function editorSelectAll(view: EditorView): void {
  selectAll(view);
  view.focus();
}

export type { EditorView };
