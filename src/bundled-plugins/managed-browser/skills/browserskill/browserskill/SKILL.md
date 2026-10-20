---
name: browserskill
description: BrowserSkill (bsk) CLI driving the shared TypeClaw browser through its extension. Use for semantic page observation, table/list extraction, recording traces, and website debugging evidence.
---

# browserskill

The `bsk` CLI talks to a daemon TypeClaw runs next to the shared browser; the BrowserSkill extension is preloaded and connected. `bsk` reaches that daemon through `$TYPECLAW_BSK_RELAY`; do not set `BSK_HOME` yourself. If the variable is unset, this session's role cannot use the shared browser (it needs the `browser.shared` permission) or the browser failed to start; the operator log (`typeclaw logs`) names which. Do not try to start Chrome yourself.

```bash
bsk status --json                       # a connected browser must be listed
SID=$(bsk session start --json | jq -r .session_id)
bsk navigate https://example.com --session "$SID"
bsk snapshot --session "$SID"           # @eN refs
bsk click @e3 --session "$SID"
bsk session stop "$SID"                 # always stop, success or failure
```

- Sessions open their own Agent Window. Never borrow an existing tab: borrowing asks a human to confirm, and nobody can click it here.
- `bsk --help` and `bsk <command> --help` list everything (`extract`, `observe`, `record`, `debug`).
- Never run `bsk update`, `bsk daemon stop`, or `bsk daemon restart`; TypeClaw owns the daemon and its version.

## Shared browser rules

- One TypeClaw-managed Chrome serves every engine and every session that has `browser.shared`. Logins and tabs persist across bash calls and sessions.
- Work only in tabs you opened. Never navigate or close a tab another engine or session is using.
- Files: downloads land in `$TYPECLAW_BROWSER_FILES`; to upload a file, copy it there first and pass that path. Chrome cannot see other paths.
- The browser runs in its own sandbox with no view of the agent folder, so `file://` URLs outside `$TYPECLAW_BROWSER_FILES` fail by design.
