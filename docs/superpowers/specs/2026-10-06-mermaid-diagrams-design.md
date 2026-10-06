# Mermaid diagrams

Roadmap item 7. Render fenced ` ```mermaid ` blocks as diagrams in Live mode, Reading mode and
copy-as-HTML, in both the main window and Quick Notes.

## Decisions (2026-10-06)

- **Renderer:** the official Mermaid (12.1), vendored and loaded lazily. A lighter renderer was
  rejected: its output and syntax coverage would differ from GitHub and from what agents write.
- **Live mode:** with the cursor outside the block, a diagram widget replaces the block. With the
  cursor inside, the raw source stays editable and the diagram renders below it, refreshed after
  typing pauses. A click on the widget moves the cursor into the block, the same as tables.
- **Copy-as-HTML:** the rendered diagram as inline `<svg>`, matching Reading mode.
- **ELK is left out.** Mermaid ships elkjs (EPL-2.0) for the opt-in `layout: elk`. EPL-2.0 is not
  GPL-compatible without a secondary-license notice, and elkjs has none. The vendor script skips
  the ELK chunk. Mermaid 12 made ELK its default layout (globally and for state diagrams), so
  the renderer sets `layout: "dagre"`, the Mermaid 11 default. A diagram that asks for
  `layout: elk` shows an error in place.

## Vendoring

`scripts/vendor-mermaid.mjs` (`npm run vendor:mermaid`) copies Mermaid's prebuilt split ESM
build into `src/vendor/mermaid/`: the `mermaid.esm.min.mjs` entry and its
`chunks/mermaid.esm.min/*.mjs`, without source maps and without `elk-*.mjs`. Mermaid itself
loads diagram types on demand, so a flowchart only pulls the core and the flowchart chunks.
Tauri serves `.mjs` as `text/javascript`. Nothing is fetched remotely: the CSP
(`script-src 'self'`, `connect-src ipc:`) stays unchanged.

## Module: `src/mermaid.js`

One renderer per window, created by `createMermaidRenderer({ document, load })`. `load`
defaults to `import("./vendor/mermaid/mermaid.esm.min.mjs")` and is replaced by a fake in
tests.

- `render(source)` returns `Promise<{ svg } | { error }>`. Results are cached by source text
  (bounded LRU), so a re-render of unchanged diagrams is a map lookup. Renders run one at a
  time, because Mermaid measures text in a shared hidden element.
- `cached(source)` returns a finished result synchronously or `undefined`, so widgets with a
  known diagram never flash a placeholder.
- `setTheme(variables)` re-initialises Mermaid (`theme: "base"`, `securityLevel: "strict"`,
  `startOnLoad: false`), clears the cache and notifies listeners (`onChange`) when the
  variables differ from the current ones.
- `renderBlocks(container)` replaces each `pre > code.language-mermaid` in rendered Markdown
  with a `div.mermaid-diagram` holding the SVG or the error. It is a no-op that never loads
  Mermaid when the container has no such block.
- `themeVariablesFrom(document)` reads the preview background, text, accent and border colors
  and the dark flag from the computed styles, normalised to hex through `css-color.js`, so every
  theme and preset maps onto Mermaid's `base` theme.

Errors: a parse or render failure shows `Mermaid: <message>` in a `div.mermaid-error`, never a
blank block. Mermaid's leftover error element is removed from the page.

## Live mode (`editor-live-preview.js`)

The table `StateField` also builds Mermaid decorations, because block widgets must come from
state. For each top-level `FencedCode` whose info string is `mermaid`:

- not revealed: `Decoration.replace({ block: true })` over the block with a `MermaidWidget`;
- revealed: a `Decoration.widget({ block: true, side: 1 })` after the block, a `MermaidWidget`
  in "preview" form.

`MermaidWidget.toDOM` fills the wrapper from `cached()` when it can, otherwise shows a sized
placeholder and fills it when the render finishes, then asks the view to re-measure.
`updateDOM` reuses the existing element when only the source changed and re-renders after a
300 ms pause, so typing keeps the last good diagram on screen. A renderer `onChange` (theme
switch) dispatches an effect that rebuilds the widgets.

`livePreview({ onOpenLink, mermaid })` takes the renderer; without one, Mermaid blocks stay
plain code blocks.

## Reading mode and copy-as-HTML

The three Reading renders (notes primary and secondary, file editor) call
`renderBlocks(preview)` after `highlightPreviewCode`. Copy-as-HTML in Reading mode already
copies the preview's HTML. In Live and Source modes it renders into a detached container, awaits
`renderBlocks`, and copies that.

## Theme

Each window's theme `onApplied` calls `mermaid.setTheme(themeVariablesFrom(document))`. A
change re-renders open Reading previews and Live widgets.

## Testing

- `test/mermaid.test.js`: caching, sequential renders, error results, theme change clears the
  cache and notifies, `renderBlocks` replaces only Mermaid blocks and never loads Mermaid
  without one, theme variables from computed styles.
- `test/editor-live-preview.test.js`: widget when outside, source plus preview when inside,
  nothing in Source mode, click moves the cursor in, cached diagrams render synchronously.
- `test/mermaid-vendor.test.js`: the vendored entry exists, every relative import in the vendor
  tree resolves except ELK, no ELK file, no source map references.
- Manual: the real app, a flowchart and a sequence diagram, theme switch, a syntax error, and
  measured first-render cost.

Not covered: KaTeX math in labels renders without KaTeX fonts (none are vendored).
