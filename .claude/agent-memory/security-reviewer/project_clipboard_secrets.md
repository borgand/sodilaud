---
name: project-clipboard-secrets
description: Owner plans a clipboard manager storing API tokens/secrets in sodilaud; hard requirement that no data leaves the machine
metadata:
  type: project
---

Owner plans to add a clipboard manager to sodilaud (fork of crims0n/scratchpad) that will hold API tokens and secrets, stored following the existing notes storage pattern.

**Why:** Hard requirement stated 2026-09-25: no data ever leaves the machine. Storage layer is treated as the most security-critical area.

**How to apply:** In reviews, weigh any egress channel (MCP agent access, opener links, update check, synced DB paths) and at-rest issues (plaintext SQLite, no secure_delete, trash retention, webview-supplied db paths) as high priority, not hardening nits.
