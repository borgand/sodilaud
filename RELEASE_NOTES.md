# Sodilaud v0.12.0

Mermaid diagrams render in place: write a ` ```mermaid ` block and see the diagram.

## Highlights

- **Mermaid diagrams.** A ` ```mermaid ` code block shows as a diagram in Live mode, in Reading mode, and in **Copy rendered HTML**, in files and in Quick Notes. Flowcharts, sequence, class, state, ER, Gantt, mindmap and the other Mermaid diagram types are supported.
- **Edit with the diagram in view.** Click a diagram to edit its source. The diagram stays below the source while you type and updates when you pause.
- **Follows your theme.** Diagrams use the active theme's colors and redraw when you switch theme or preset.
- **Errors in place.** A diagram with a syntax error shows Mermaid's message where the diagram would be, never a blank block.

## Limits

- The ELK layout is not included (its license is not compatible with Sodilaud's). Diagrams use Mermaid's standard dagre layout; a diagram that asks for `layout: elk` shows an error.
- Math in diagram labels renders without its proper fonts.
- Images inside diagram labels load only from within the app; remote images are blocked.

## Compatibility

- Mermaid 12.1 is bundled and runs offline. It loads only when a document contains a diagram, so documents without one start as before. The app grows by about 4 MB.
- Notes, files, settings and workspaces carry over unchanged.
- Builds are not production-signed; macOS and Windows may display a security warning.
