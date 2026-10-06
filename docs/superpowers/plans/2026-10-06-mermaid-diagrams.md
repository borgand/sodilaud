# Mermaid diagrams: implementation plan

Spec: [`../specs/2026-10-06-mermaid-diagrams-design.md`](../specs/2026-10-06-mermaid-diagrams-design.md).
One PR, `feat/mermaid-diagrams`.

1. Vendor: add `mermaid` (exact version) to devDependencies, write
   `scripts/vendor-mermaid.mjs` and the `vendor:mermaid` npm script, run it, and add
   `test/mermaid-vendor.test.js`. Add Mermaid and its bundled libraries to
   `THIRD_PARTY_NOTICES.md`.
2. Renderer: `src/mermaid.js` with `createMermaidRenderer` and `themeVariablesFrom`, test first
   (`test/mermaid.test.js`). Add it to `check:js`.
3. Live mode: `MermaidWidget` and the block decorations in `editor-live-preview.js`, tests in
   `test/editor-live-preview.test.js`. Styles for `.cm-lp-mermaid`, `.mermaid-diagram`,
   `.mermaid-error` in `styles.css`.
4. Wiring: create the renderer in `notes.js` and `file-editor.js` (through `app.js`), pass it to
   `livePreview`, call `renderBlocks` after each Reading render, make copy-as-HTML await it, and
   call `setTheme` from the theme's `onApplied`.
5. Verify: `npm run check`, cargo fmt/clippy/tests as CI runs them, then a manual run in the app
   (flowchart, sequence, error, theme switch, copy-as-HTML), recording first-render time and the
   bundle size in the PR.
6. Docs: roadmap item 7 status, README feature line, release notes entry.
