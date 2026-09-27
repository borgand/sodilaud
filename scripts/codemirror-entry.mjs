// SPDX-License-Identifier: GPL-3.0-or-later

export { Annotation, Compartment, EditorSelection, EditorState, Facet, Prec, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
export { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutterLineClass, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { HighlightStyle, Language, defineLanguageFacet, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
export { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
export { GFM, parser as markdownParser } from "@lezer/markdown";
export { tags } from "@lezer/highlight";
