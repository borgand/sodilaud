// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Decoration,
  EditorView,
  GutterMarker,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  getSyncedVersion,
  gutter,
  keymap,
  sendableUpdates
} from "./vendor/codemirror.js";

// Comments anchored to text, shown as tinted ranges with a gutter marker, an
// inline composer for new ones, and a short highlight where an agent edited.
// Rust owns the comments; this extension only shows them and keeps their
// ranges mapped through edits between two snapshots, the same way Rust does.

export const setComments = StateEffect.define();
export const setActiveComment = StateEffect.define();
const composerEffect = StateEffect.define();
const flashEffect = StateEffect.define();
const clearFlashEffect = StateEffect.define();

export const FLASH_MS = 2000;

const visible = comment => !comment.orphaned && comment.state !== "resolved" && comment.to > comment.from;

const commentsField = StateField.define({
  create: () => [],
  update(list, tr) {
    for (const effect of tr.effects) if (effect.is(setComments)) return effect.value;
    if (!tr.docChanged || list.length === 0) return list;
    return list.map(comment => {
      const from = tr.changes.mapPos(comment.from, 1);
      const to = tr.changes.mapPos(comment.to, -1);
      return { ...comment, from, to: Math.max(from, to) };
    });
  }
});

const activeField = StateField.define({
  create: () => null,
  update(active, tr) {
    for (const effect of tr.effects) if (effect.is(setActiveComment)) return effect.value;
    return active;
  }
});

const composerField = StateField.define({
  create: () => null,
  update(composer, tr) {
    for (const effect of tr.effects) if (effect.is(composerEffect)) return effect.value;
    if (!composer || !tr.docChanged) return composer;
    const from = tr.changes.mapPos(composer.from, 1);
    return { ...composer, from, to: Math.max(from, tr.changes.mapPos(composer.to, -1)) };
  }
});

const flashField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flashEffect)) {
        const mark = Decoration.mark({ class: "cm-agent-edit", flash: effect.value.id });
        marks = marks.update({ add: effect.value.ranges.map(range => mark.range(range.from, range.to)), sort: true });
      } else if (effect.is(clearFlashEffect)) {
        marks = marks.update({ filter: (from, to, value) => value.spec.flash !== effect.value });
      }
    }
    return marks;
  },
  provide: field => EditorView.decorations.from(field)
});

const commentDecorations = EditorView.decorations.compute([commentsField, activeField], state => {
  const active = state.field(activeField);
  const ranges = state.field(commentsField).filter(visible).map(comment => Decoration.mark({
    class: `cm-comment cm-comment-${comment.author}${comment.id === active ? " cm-comment-active" : ""}`,
    attributes: { "data-comment-id": comment.id }
  }).range(comment.from, comment.to));
  return Decoration.set(ranges, true);
});

class CommentMarker extends GutterMarker {
  constructor(author) {
    super();
    this.author = author;
  }

  eq(other) {
    return other.author === this.author;
  }

  toDOM(view) {
    const marker = view.dom.ownerDocument.createElement("span");
    marker.className = `cm-comment-marker cm-comment-marker-${this.author}`;
    marker.textContent = "●";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

const markers = { owner: new CommentMarker("owner"), agent: new CommentMarker("agent") };

function lineComments(state, line) {
  return state.field(commentsField).filter(comment => visible(comment) && state.doc.lineAt(comment.from).number === line);
}

/** The comments shown in `state`, with their ranges as they are now. */
export function shownComments(state) {
  return state.field(commentsField, false) ?? [];
}

// Composes the changes this editor made that Rust has not confirmed yet.
function unconfirmed(state) {
  const updates = sendableUpdates(state);
  return updates.length ? updates.slice(1).reduce((all, update) => all.compose(update.changes), updates[0].changes) : null;
}

/** A range of `state` as positions in the text Rust last confirmed, with its version. */
export function toConfirmed(state, from, to) {
  const version = getSyncedVersion(state);
  const changes = unconfirmed(state);
  if (!changes) return { version, from, to };
  const inverse = changes.invertedDesc;
  return { version, from: inverse.mapPos(from, 1), to: inverse.mapPos(to, -1) };
}

/** Rust's comments at the confirmed version, placed in `state`'s text. */
export function fromConfirmed(state, comments) {
  const changes = unconfirmed(state);
  if (!changes) return comments;
  return comments.map(comment => {
    const from = changes.mapPos(comment.from, 1);
    return { ...comment, from, to: Math.max(from, changes.mapPos(comment.to, -1)) };
  });
}

/** Opens the composer under the selection. Returns false when nothing is selected. */
export function startComment(view) {
  const selection = view.state.selection.main;
  if (selection.empty || view.state.field(composerField, false) === undefined) return false;
  view.dispatch({ effects: composerEffect.of({ from: selection.from, to: selection.to, key: Date.now() + Math.random() }) });
  return true;
}

export function closeComposer(view) {
  if (view.state.field(composerField, false)) view.dispatch({ effects: composerEffect.of(null) });
}

let flashCounter = 0;

/** Highlights what a transaction changed for a moment, as an agent's edit. */
export function flashChanges(view, transaction) {
  const ranges = [];
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) ranges.push({ from: fromB, to: toB });
  });
  if (ranges.length === 0 || view.state.field(flashField, false) === undefined) return;
  flashCounter += 1;
  view.dispatch({ effects: flashEffect.of({ id: flashCounter, ranges }) });
}

/**
 * @param {object} options
 * @param {(view: EditorView, comment: {from: number, to: number, body: string}) => Promise<void>} options.onSubmit
 *   adds the comment; rejects with an error to show in the composer
 * @param {(id: string) => void} [options.onSelect] a comment's range or marker was clicked
 */
export function commentsExtension({ onSubmit, onSelect = () => {} }) {
  class ComposerWidget extends WidgetType {
    constructor(key) {
      super();
      this.key = key;
    }

    eq(other) {
      return other.key === this.key;
    }

    toDOM(view) {
      const doc = view.dom.ownerDocument;
      const box = doc.createElement("div");
      box.className = "cm-comment-composer";
      const input = doc.createElement("textarea");
      input.className = "cm-comment-input";
      input.rows = 2;
      input.placeholder = "Comment";
      input.setAttribute("aria-label", "New comment");
      const error = doc.createElement("p");
      error.className = "cm-comment-error";
      error.hidden = true;
      const actions = doc.createElement("div");
      actions.className = "cm-comment-actions";
      const add = doc.createElement("button");
      add.type = "button";
      add.className = "cm-comment-add";
      add.textContent = "Comment";
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "cm-comment-cancel";
      cancel.textContent = "Cancel";
      actions.append(add, cancel);
      box.append(input, error, actions);

      const close = () => {
        closeComposer(view);
        view.focus();
      };
      const submit = async () => {
        const composer = view.state.field(composerField);
        const body = input.value.trim();
        if (!composer || !body) return;
        add.disabled = true;
        try {
          await onSubmit(view, { from: composer.from, to: composer.to, body });
          if (view.state.field(composerField)?.key === this.key) close();
        } catch (failure) {
          error.textContent = failure?.message ?? String(failure);
          error.hidden = false;
          add.disabled = false;
        }
      };
      input.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      });
      add.addEventListener("click", submit);
      cancel.addEventListener("click", close);
      setTimeout(() => input.focus(), 0);
      return box;
    }

    ignoreEvent() {
      return true;
    }
  }

  const composerDecorations = EditorView.decorations.compute([composerField], state => {
    const composer = state.field(composerField);
    if (!composer) return Decoration.none;
    const end = state.doc.lineAt(composer.to).to;
    return Decoration.set([
      Decoration.mark({ class: "cm-comment cm-comment-draft" }).range(composer.from, Math.max(composer.from, composer.to)),
      Decoration.widget({ widget: new ComposerWidget(composer.key), block: true, side: 1 }).range(end)
    ].filter(range => range.from < range.to || range.value.spec.widget), true);
  });

  const flashTimers = ViewPlugin.define(view => {
    const timers = new Set();
    return {
      update(update) {
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (!effect.is(flashEffect)) continue;
            const timer = setTimeout(() => {
              timers.delete(timer);
              view.dispatch({ effects: clearFlashEffect.of(effect.value.id) });
            }, FLASH_MS);
            timers.add(timer);
          }
        }
      },
      destroy() {
        timers.forEach(clearTimeout);
      }
    };
  });

  const commentGutter = gutter({
    class: "cm-comment-gutter",
    markers: view => {
      const builder = new RangeSetBuilder();
      const seen = new Set();
      const shown = view.state.field(commentsField).filter(visible).sort((a, b) => a.from - b.from);
      for (const comment of shown) {
        const line = view.state.doc.lineAt(comment.from);
        if (seen.has(line.number)) continue;
        seen.add(line.number);
        builder.add(line.from, line.from, markers[comment.author] ?? markers.owner);
      }
      return builder.finish();
    },
    lineMarkerChange: update => update.startState.field(commentsField) !== update.state.field(commentsField),
    domEventHandlers: {
      mousedown(view, line) {
        const found = lineComments(view.state, view.state.doc.lineAt(line.from).number);
        if (found.length === 0) return false;
        onSelect(found[0].id);
        return true;
      }
    }
  });

  return [
    commentsField,
    activeField,
    composerField,
    flashField,
    commentDecorations,
    composerDecorations,
    flashTimers,
    commentGutter,
    Prec.high(keymap.of([{ key: "Mod-Alt-m", run: startComment }])),
    EditorView.domEventHandlers({
      click(event) {
        const id = event.target?.closest?.("[data-comment-id]")?.getAttribute("data-comment-id");
        if (id) onSelect(id);
        return false;
      }
    })
  ];
}
