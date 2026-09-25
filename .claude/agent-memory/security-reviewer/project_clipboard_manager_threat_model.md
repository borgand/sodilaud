---
name: clipboard-manager-threat-model
description: Owner plans a clipboard manager storing API tokens; clipboard/note content is untrusted and renderer XSS = secret exfil via withGlobalTauri + opener
metadata:
  type: project
---

Owner plans to add a clipboard manager that stores copied content including API tokens (stated 2026-09-25).

**Why:** Any renderer XSS becomes full secret compromise because tauri.conf.json has `withGlobalTauri: true` and opener allows http/https/mailto URLs.

**How to apply:** Treat note content, clipboard content, theme files and MCP writes as untrusted. Any new innerHTML/template-string sink in clipboard UI code must escape or go through sanitizeMarkdownHtml. As of 2026-09-25 audit the renderer was clean: custom allowlist sanitizer in src/markdown.js plus CSP `script-src 'self'` and `img-src 'self' asset: data:` (no remote fetch). Weak spots: isValidColor accepts any `var(...)` value; main.js escapeHTML throws on non-strings.
