---
name: project-zero-egress-requirement
description: Sodilaud fork must never send user data anywhere (planned clipboard manager holds API tokens/secrets); build path is in scope for exfil-injection review
metadata:
  type: project
---

The owner plans to add a clipboard manager that will hold API tokens and secrets. The rule is zero egress: nothing may send, upload or sync user data to any remote destination, not even anonymous stats. Compromised build steps that could inject exfiltration code are in scope too.

**Why:** Secrets will live in the app, and the owner runs a binary they build themselves every day. Supply-chain compromise matters as much as the app's runtime behaviour.

**How to apply:** Treat any outbound network capability as a finding, however benign its purpose. Known cases as of 2026-09-25:
- the upstream update check against crims0n.github.io in src-tauri/src/updates.rs
- reqwest and its TLS stack
- the opener capability, which allows any http(s) URL

Also flag any third-party code that runs while a write-scoped token is present. Before re-reporting any of these, check whether they have since been removed. Related: [[ci-build-token-exposure]]
