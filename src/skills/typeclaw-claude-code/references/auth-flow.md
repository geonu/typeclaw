# Authentication through the runtime broker

The host operator configures `providers.anthropic` through `typeclaw provider add anthropic` and enables `docker.file.claudeCode`. Rebuild/restart on the host when the installed binary is missing. The runtime uses the canonical credential store and coordinates refresh with ordinary agent requests.

The tool reports readiness failures safely. Missing credentials affect this task, not startup or other providers. A revoked subscription needs host re-login, not model-side token handling. API-key and subscription authentication remain distinct; the broker never silently falls back from a failed subscription to API billing.

The sandboxed child has only a random, short-lived loopback capability. The broker accepts the selected model and explicit helper model on Messages/count-token routes, injects provider authentication upstream, and revokes the capability when the invocation ends. There is no token, refresh, login, or arbitrary proxy endpoint.

Never inspect `.env`, `secrets.json`, `auth.json`, runtime HOME, or Claude profiles. Do not request `claude login`/`setup-token` output, copy credentials into a task, or send them through chat or tool arguments. Guard acknowledgements do not alter this boundary.

Ordinary operator-declared `.env` values can already be visible to model bash. The confidentiality guarantee covers private canonical credentials not also exposed there, in prompts, or source history. The delegated runner does not inherit ambient credential variables.

If auth fails, return the safe diagnostic to the parent and retain the worktree. Do not change endpoints or broaden the broker's routes to fix unsupported account/cloud features.
