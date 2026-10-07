// SPDX-License-Identifier: GPL-3.0-or-later

// Folding a section by its heading in Live and Source mode. Folds are named by
// heading slug, so Reading mode can show the same ones; they live in the
// editor state for the session and are never written to the file.

import {
  Decoration,
  EditorView,
  Prec,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType
} from "./vendor/codemirror.js";
import { documentAnchors, findAnchor } from "./editor-anchors.js";
import { sectionEnds } from "./outline.js";

const toggleFold = StateEffect.define();
const setFolds = StateEffect.define();

/** The text a folded section hides: from the line after its heading to the line before the next one. */
export function sectionFoldRanges(state, anchors = documentAnchors(state)) {
  const headings = anchors.filter(anchor => anchor.kind === "heading");
  const ends = sectionEnds(headings, state.doc.length);
  return headings.map((heading, index) => {
    const headingLine = state.doc.lineAt(heading.to);
    const from = headingLine.to + 1;
    const end = ends[index];
    const to = end < state.doc.length ? state.doc.lineAt(end).from - 1 : state.doc.length;
    return { id: heading.id, level: heading.level, from, to: Math.max(from, to) };
  });
}

class FoldedWidget extends WidgetType {
  constructor(id) {
    super();
    this.id = id;
  }

  eq(other) {
    return other.id === this.id;
  }

  toDOM(view) {
    const element = view.dom.ownerDocument.createElement("div");
    element.className = "cm-section-folded";
    element.textContent = "…";
    element.title = "Unfold section";
    element.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ effects: toggleFold.of({ id: this.id, folded: false }) });
    });
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

function buildFolds(state, ids) {
  if (!ids.size) return Decoration.none;
  const ranges = [];
  let coveredTo = -1;
  for (const range of sectionFoldRanges(state)) {
    if (!ids.has(range.id) || range.to <= range.from || range.from <= coveredTo) continue;
    ranges.push(Decoration.replace({ widget: new FoldedWidget(range.id), block: true }).range(range.from, range.to));
    coveredTo = range.to;
  }
  return Decoration.set(ranges);
}

const foldField = StateField.define({
  create: () => ({ ids: new Set(), decorations: Decoration.none }),
  update(value, tr) {
    let { ids } = value;
    let changed = false;
    for (const effect of tr.effects) {
      if (effect.is(setFolds)) {
        ids = new Set(effect.value);
        changed = true;
      } else if (effect.is(toggleFold)) {
        ids = new Set(ids);
        if (effect.value.folded) ids.add(effect.value.id);
        else ids.delete(effect.value.id);
        changed = true;
      }
    }
    if (!changed && !(tr.docChanged && ids.size)) return value;
    return { ids, decorations: buildFolds(tr.state, ids) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

export const foldedSections = state => state.field(foldField, false)?.ids ?? new Set();

export function setSectionFolded(view, id, folded) {
  view.dispatch({ effects: toggleFold.of({ id, folded }) });
}

export function setFoldedSections(view, ids) {
  view.dispatch({ effects: setFolds.of(ids) });
}

/** Unfolds every folded section that hides the anchor `fragment` names. */
export function revealAnchor(view, fragment) {
  const ids = foldedSections(view.state);
  if (!ids.size) return false;
  const anchor = findAnchor(view.state, fragment);
  if (!anchor) return false;
  const hiding = sectionFoldRanges(view.state)
    .filter(range => ids.has(range.id) && anchor.from >= range.from && anchor.from <= range.to);
  if (!hiding.length) return false;
  view.dispatch({ effects: hiding.map(range => toggleFold.of({ id: range.id, folded: false })) });
  return true;
}

class ChevronWidget extends WidgetType {
  constructor(id, folded) {
    super();
    this.id = id;
    this.folded = folded;
  }

  eq(other) {
    return other.id === this.id && other.folded === this.folded;
  }

  toDOM(view) {
    const button = view.dom.ownerDocument.createElement("span");
    button.className = `cm-heading-fold${this.folded ? " is-folded" : ""}`;
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", this.folded ? "Unfold section" : "Fold section");
    button.setAttribute("aria-expanded", String(!this.folded));
    button.title = this.folded ? "Unfold section" : "Fold section";
    // Mousedown, so the caret never lands on the heading and reveals its markup.
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      setSectionFolded(view, this.id, !this.folded);
    });
    return button;
  }

  ignoreEvent() {
    return true;
  }
}

function chevrons(view) {
  const ids = foldedSections(view.state);
  const ranges = [];
  for (const anchor of documentAnchors(view.state, { full: false })) {
    if (anchor.kind !== "heading") continue;
    const line = view.state.doc.lineAt(anchor.from);
    if (anchor.from !== line.from) continue;
    ranges.push(Decoration.widget({ widget: new ChevronWidget(anchor.id, ids.has(anchor.id)), side: -1 }).range(line.from));
  }
  return Decoration.set(ranges);
}

const chevronPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = chevrons(view);
  }

  update(update) {
    const before = foldedSections(update.startState);
    const after = foldedSections(update.state);
    if (update.docChanged || update.viewportChanged || before !== after) this.decorations = chevrons(update.view);
  }
}, { decorations: plugin => plugin.decorations });

/** Fold chevrons on headings and the folds themselves. */
export function sectionFolding() {
  return [Prec.high(foldField), chevronPlugin];
}
