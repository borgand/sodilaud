---
name: project-no-outbound-requirement
description: Owner plans a clipboard manager holding API tokens/secrets; any outbound network capability counts as a finding
metadata:
  type: project
---

The owner plans to add a clipboard manager that will hold API tokens and secrets (stated 2026-09-25). Hard requirement: nothing may send, upload, sync or leak data to any remote destination, not even anonymous stats or a tracking pixel.

**Why:** secrets in notes/clipboard; any egress path is unacceptable.
**How to apply:** in reviews, report every outbound capability (update checker, opener plugin, MCP server exposure, link clicks) even if opt-in; flag plaintext-at-rest storage of note content as relevant to the secrets use case.
