# Egress gate allowance: SVG namespace identifier (2026-09-26)

`src/clipboard.js` builds the clipboard history popup's reveal, hide, and delete icons as
inline SVG, created node by node with `document.createElementNS`, because the popup is not
allowed to use `innerHTML` (see the guard test in `test/clipboard-boundary.test.js`).
`document.createElementNS` requires the SVG XML namespace URI as its first argument:

```
http://www.w3.org/2000/svg
```

That string matches the "remote url" rule (`/https?:\/\/\S/`) in
`scripts/check-no-egress.mjs`, because it has the shape of a URL. It is not one: it is a fixed
XML namespace identifier defined by the SVG specification, used only as a local string literal
passed to `createElementNS`. Nothing in `src/clipboard.js` fetches it, opens it, or otherwise
makes a network request with it, and nothing else in the popup can reach the network (see the
same guard test, and `docs/security/2026-09-25-audit-findings.md`).

## Scope of the allowance

`scripts/check-no-egress.mjs` keeps the "remote url" rule active everywhere else. It adds a
short, exact-string allowlist, `NON_NETWORK_IDENTIFIERS`, currently holding only
`http://www.w3.org/2000/svg`, and a pure function, `stripNonNetworkIdentifiers(line)`, that
removes an exact occurrence of that identifier from a line before the "remote url" pattern is
tested against it. The removal only fires when the identifier is not immediately followed by
another URI character (letters, digits, or `-._~:/?#[]@!$&'()*+,;=%`), so:

- A line containing only the identifier (`const SVG_NS = "http://www.w3.org/2000/svg";`) no
  longer matches the "remote url" rule and passes.
- A line containing the identifier plus a different, real URL
  (`"http://www.w3.org/2000/svg" + "https://evil.example/"`) still fails, because the second
  URL is untouched by the stripping step.
- A near-miss that only looks like the identifier, such as
  `http://www.w3.org/2000/svg-evil` or `https://www.w3.org/2000/svg`, is not an exact match
  and still fails.

This is deliberately narrower than adding `src/clipboard.js` to the checker's per-file
`ALLOWED` map, which would have suppressed the "remote url" rule for every line in that file
and let any future remote URL slip in unnoticed. The allowance here is scoped to one exact
string, checked wherever it appears in scanned source, not to one file.

Covered by `test/no-egress.test.js`: unit tests on `stripNonNetworkIdentifiers` and
integration tests that run the checker against probe files for the three cases above.
