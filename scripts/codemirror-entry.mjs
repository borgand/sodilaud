// SPDX-License-Identifier: GPL-3.0-or-later

export { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Facet, Prec, RangeSetBuilder, StateEffect, StateField, Text, Transaction } from "@codemirror/state";
export { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
export { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutterLineClass, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { HighlightStyle, Language, defineLanguageFacet, syntaxHighlighting, syntaxTree } from "@codemirror/language";
export { defaultKeymap, history, historyKeymap, isolateHistory, undo } from "@codemirror/commands";
export { GFM, parser as markdownParser } from "@lezer/markdown";
export { tags } from "@lezer/highlight";
