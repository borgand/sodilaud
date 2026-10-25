# Roadmap

Planned work is tracked as [GitHub issues](https://github.com/borgand/sodilaud/issues). This
file lists the open plans by area. Each item links its issue, and its design once one exists.

Items 1 to 18 of the earlier roadmap are delivered (0.9.0 to 0.16.0). Design docs and plans
that refer to "ROADMAP item N" mean that list, which is kept in the git history of this file
up to 0.16.0. The specs are in [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Editor

- Vim motions: [#68](https://github.com/borgand/sodilaud/issues/68)
- Line-number numbering in Live mode: [#74](https://github.com/borgand/sodilaud/issues/74)
- Soft line breaks render inconsistently (needs a sample): [#75](https://github.com/borgand/sodilaud/issues/75)

## Window chrome

- Merge the title bar and the toolbar: [#70](https://github.com/borgand/sodilaud/issues/70)
- Floating formatting pill: [#71](https://github.com/borgand/sodilaud/issues/71)
- Open Files and Outline as sidebar tabs: [#72](https://github.com/borgand/sodilaud/issues/72)
- Focus mode in the main window: [#73](https://github.com/borgand/sodilaud/issues/73)
- Resizable sidebars: [#65](https://github.com/borgand/sodilaud/issues/65)
- Same status bar and outline in Quick Notes as in the file editor: [#76](https://github.com/borgand/sodilaud/issues/76)

## Command line

- `sodilaud --wait`, so the command works as `$EDITOR`: [#69](https://github.com/borgand/sodilaud/issues/69)

## Not planned

- A smaller "MCP listening" indicator. It shows only while agent access is on, and the security
  audit relies on it being visible.
- A grid editor for `.csv` and `.tsv`. They open as plain text; a grid would be a separate
  editor component, built only if it is needed.
