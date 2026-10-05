// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutterLineClass,
  keymap,
  lineNumbers,
  placeholder,
  HighlightStyle,
  Language,
  defineLanguageFacet,
  syntaxHighlighting,
  defaultKeymap,
  history,
  historyKeymap,
  GFM,
  markdownParser,
  tags
} from "./vendor/codemirror.js";
import { getChangedRange } from "./editor-edit.js";
import { applyPureEdit } from "./editor-commands.js";

export const markdownLanguage = new Language(
  defineLanguageFacet(),
  markdownParser.configure([GFM]),
  [],
  "markdown"
);

export const externalChange = Annotation.define();

export const modeFacet = Facet.define({ combine: values => values[0] ?? "live" });

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: "syntax-heading" },
  { tag: [tags.emphasis, tags.strong, tags.strikethrough], class: "syntax-emphasis" },
  { tag: [tags.link, tags.url], class: "syntax-link" },
  { tag: tags.monospace, class: "syntax-code" },
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator, tags.list, tags.quote],
    class: "syntax-punctuation"
  }
]);

class DiffLineMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.elementClass = `cm-diff-line-${kind}`;
  }

  eq(other) {
    return other instanceof DiffLineMarker && other.elementClass === this.elementClass;
  }
}

const diffLineMarkers = {
  added: new DiffLineMarker("added"),
  removed: new DiffLineMarker("removed")
};

const emptyLineMarkers = new RangeSetBuilder().finish();

// Alt+Up/Down belongs to the app (note move); editor-commands handles list moves.
// Mod-i (selectParentSyntax) is the italic shortcut in editor-commands.
const reservedKeys = new Set(["Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown", "Mod-i"]);
const baseKeymap = defaultKeymap.filter(binding => !reservedKeys.has(binding.key));
const findMatchMark = Decoration.mark({ class: "cm-find-match" });
const findActiveMark = Decoration.mark({ class: "cm-find-match cm-find-active" });

const setFindEffect = StateEffect.define();
const setDiffEffect = StateEffect.define();

function clampedRange(start, end, length) {
  const from = Math.max(0, Math.min(Number(start) || 0, length));
  const to = Math.max(from, Math.min(Number(end) || 0, length));
  return to > from ? { from, to } : null;
}

function buildFindDecorations(find, doc) {
  if (!find) return Decoration.none;
  const ranges = [];
  find.matches.forEach((match, index) => {
    const range = clampedRange(match.start, match.end, doc.length);
    if (!range) return;
    const mark = index === find.activeIndex ? findActiveMark : findMatchMark;
    ranges.push(mark.range(range.from, range.to));
  });
  return Decoration.set(ranges, true);
}

function buildDiffState(diff, doc) {
  if (!diff) return null;
  const decorations = Array.isArray(diff.decorations) ? diff.decorations : [];
  const ranges = [];
  for (const item of decorations) {
    const range = clampedRange(item.start, item.end, doc.length);
    if (range && item.className) {
      ranges.push(Decoration.mark({ class: item.className }).range(range.from, range.to));
    }
  }

  const kind = decorations.some(item => item.className === "diff-line-removed") ? "removed" : "added";
  const lineIndexes = [...new Set(Array.isArray(diff.changedLines) ? diff.changedLines : [])]
    .filter(index => Number.isInteger(index) && index >= 0 && index < doc.lines)
    .sort((a, b) => a - b);
  const builder = new RangeSetBuilder();
  for (const index of lineIndexes) {
    const lineStart = doc.line(index + 1).from;
    builder.add(lineStart, lineStart, diffLineMarkers[kind]);
  }

  return { decorations: Decoration.set(ranges, true), lines: builder.finish() };
}

const findField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFindEffect)) next = buildFindDecorations(effect.value, tr.state.doc);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field)
});

const diffField = StateField.define({
  create: () => null,
  update(value, tr) {
    let next = value && {
      decorations: value.decorations.map(tr.changes),
      lines: value.lines.map(tr.changes)
    };
    for (const effect of tr.effects) {
      if (effect.is(setDiffEffect)) next = buildDiffState(effect.value, tr.state.doc);
    }
    return next;
  },
  provide: field => [
    EditorView.decorations.from(field, value => value ? value.decorations : Decoration.none),
    gutterLineClass.compute([field], state => state.field(field)?.lines ?? emptyLineMarkers)
  ]
});

function modeExtension(mode) {
  return [
    modeFacet.of(mode),
    EditorView.editorAttributes.of({ class: mode === "source" ? "cm-mode-source" : "cm-mode-live" })
  ];
}

function selectionDirection(range) {
  if (range.empty) return "none";
  return range.head < range.anchor ? "backward" : "forward";
}

/**
 * Creates the CodeMirror-backed Markdown editor.
 *
 * `setDiff` takes one side of a `compareNoteText` result from note-compare.js:
 * `{ decorations: leftDecorations, changedLines: leftChangedLines }` or the
 * right-side pair. `decorations` is `[{ start, end, className }]` and
 * `changedLines` holds 0-based line indexes. The side comes from the line
 * decorations: a "diff-line-removed" entry marks the changed lines with the
 * gutter class "cm-diff-line-removed", otherwise they get "cm-diff-line-added".
 *
 * @param {object} options
 * @param {HTMLElement} options.parent
 * @param {string} options.ariaLabel
 * @param {string} [options.placeholder]
 * @param {"live"|"source"} [options.mode="live"]
 * @param {boolean} [options.syntaxHighlighting=true]
 * @param {boolean} [options.lineNumbers=false]
 * @param {(text: string) => void} [options.onChange] user edits only, never setText/loadText or a remote update
 * @param {() => void} [options.onSelectionChange] selection or doc changed, from any source
 * @param {() => void} [options.onFocus]
 * @param {(href: string) => void} [options.onOpenLink]
 * @param {Extension[]} [options.extensions]
 */
export function createMarkdownEditor(options) {
  const {
    parent,
    ariaLabel,
    onChange,
    onSelectionChange,
    onFocus
  } = options;

  let mode = options.mode === "source" ? "source" : "live";
  let highlighting = options.syntaxHighlighting !== false;
  let showLineNumbers = options.lineNumbers === true;
  let diff = null;

  const modeCompartment = new Compartment();
  const highlightCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const extraCompartment = new Compartment();

  const highlightExtension = () => highlighting ? syntaxHighlighting(markdownHighlightStyle) : [];
  const gutterExtension = () => showLineNumbers || diff !== null ? lineNumbers() : [];

  const updateListener = EditorView.updateListener.of(update => {
    if (
      update.docChanged &&
      !update.transactions.some(tr => tr.annotation(externalChange) || tr.annotation(Transaction.remote))
    ) {
      onChange?.(update.state.doc.toString());
    }
    if (update.docChanged || update.selectionSet) onSelectionChange?.();
    if (update.focusChanged && update.view.hasFocus) onFocus?.();
  });

  function currentExtensions() {
    return [
      markdownLanguage,
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      keymap.of([...historyKeymap, ...baseKeymap]),
      options.placeholder ? placeholder(options.placeholder) : [],
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off"
      }),
      modeCompartment.of(modeExtension(mode)),
      highlightCompartment.of(highlightExtension()),
      gutterCompartment.of(gutterExtension()),
      findField,
      diffField.init(state => buildDiffState(diff, state.doc)),
      extraCompartment.of(options.extensions ?? []),
      updateListener
    ];
  }

  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions: currentExtensions() }),
    parent
  });

  const getText = () => view.state.doc.toString();
  const clamp = position => Math.max(0, Math.min(Number(position) || 0, view.state.doc.length));

  // The whole editor state, undo history included, so a page that shows several
  // documents in one editor can switch between them without losing either.
  function getState() {
    return view.state;
  }

  function restoreState(state) {
    view.setState(state);
    view.dispatch({
      effects: [
        modeCompartment.reconfigure(modeExtension(mode)),
        highlightCompartment.reconfigure(highlightExtension()),
        gutterCompartment.reconfigure(gutterExtension())
      ]
    });
    onSelectionChange?.();
  }

  // `extensions` belong to this document only, such as its collab client.
  function loadText(text, { extensions = [] } = {}) {
    view.setState(EditorState.create({ doc: String(text ?? ""), extensions: [currentExtensions(), extensions] }));
    view.scrollDOM.scrollTop = 0;
    onSelectionChange?.();
  }

  function setText(text) {
    const next = String(text ?? "");
    const previous = getText();
    if (next === previous) return;
    const change = getChangedRange(previous, next);
    view.dispatch({
      changes: { from: change.start, to: change.previousEnd, insert: change.replacement },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)]
    });
  }

  function getSelection() {
    const range = view.state.selection.main;
    return { start: range.from, end: range.to, direction: selectionDirection(range) };
  }

  function setSelection(start, end, { scroll = true } = {}) {
    view.dispatch({
      selection: EditorSelection.single(clamp(start), clamp(end)),
      scrollIntoView: scroll
    });
  }

  function applyEdit(edit) {
    return applyPureEdit(view, edit);
  }

  function replaceRange(from, to, insert, selection) {
    const start = clamp(from);
    const end = Math.max(start, clamp(to));
    const length = view.state.doc.length - (end - start) + insert.length;
    const bound = position => Math.max(0, Math.min(position, length));
    const caret = start + insert.length;
    view.dispatch({
      changes: { from: start, to: end, insert },
      selection: selection
        ? EditorSelection.single(bound(selection.start), bound(selection.end))
        : EditorSelection.cursor(caret),
      userEvent: "input",
      scrollIntoView: true
    });
  }

  function setMode(nextMode) {
    mode = nextMode === "source" ? "source" : "live";
    view.dispatch({ effects: modeCompartment.reconfigure(modeExtension(mode)) });
  }

  function setSyntaxHighlighting(enabled) {
    highlighting = Boolean(enabled);
    view.dispatch({ effects: highlightCompartment.reconfigure(highlightExtension()) });
  }

  function setLineNumbers(enabled) {
    showLineNumbers = Boolean(enabled);
    view.dispatch({ effects: gutterCompartment.reconfigure(gutterExtension()) });
  }

  function setFindMatches(matches, activeIndex) {
    view.dispatch({
      effects: setFindEffect.of({ matches: Array.isArray(matches) ? matches : [], activeIndex })
    });
  }

  function setDiff(nextDiff) {
    const hadGutter = showLineNumbers || diff !== null;
    diff = nextDiff ?? null;
    const effects = [setDiffEffect.of(diff)];
    if (hadGutter !== (showLineNumbers || diff !== null)) {
      effects.push(gutterCompartment.reconfigure(gutterExtension()));
    }
    view.dispatch({ effects });
  }

  function scrollToRange(start, end) {
    view.dispatch({
      effects: EditorView.scrollIntoView(EditorSelection.range(clamp(start), clamp(end)), { y: "center" })
    });
  }

  return {
    view,
    getText,
    loadText,
    getState,
    restoreState,
    setText,
    getSelection,
    setSelection,
    applyEdit,
    replaceRange,
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    setMode,
    setSyntaxHighlighting,
    setLineNumbers,
    setFindMatches,
    setDiff,
    scrollToRange,
    getScrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop: px => { view.scrollDOM.scrollTop = px; },
    destroy: () => view.destroy()
  };
}
