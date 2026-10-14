# Codex authentication through the broker

The host operator configures `providers.openai-codex` using `typeclaw provider add openai-codex`, enables `docker.file.codexCli:true`, and runs `typeclaw start` to rebuild a changed image. This provider is ChatGPT subscription OAuth. An `openai` API key is a different billing surface and is not a fallback.

## Runtime boundary

TypeClaw resolves and refreshes canonical credentials through the existing locked credential store. A trusted fixed-upstream broker sends only Responses requests to the Codex backend, injecting the OAuth bearer and `ChatGPT-Account-Id` from the matching trusted credential generation. The request cannot select an account or destination.

The whole Codex process tree runs inside outer bwrap. It receives only a fresh, bounded local inference capability. Its per-task `CODEX_HOME` contains conversation state and generated custom-provider configuration, never an exported `auth.json`, refresh token, ID token, or account ID. No fake JWT, model-driven login, or child-side token refresh is part of this path.

The custom provider uses Responses streaming with WebSockets disabled and local compaction. It does not use `OPENAI_BASE_URL`, and the model must not hand-write proxy configuration. Account management, cloud services, and arbitrary authenticated routes are unavailable.

## Safe troubleshooting

- Missing/revoked credentials: report the coding tool's diagnostic and ask the host operator to run `typeclaw provider add openai-codex`. Retry the same task after repair.
- Missing binary: enable the installation toggle and rebuild/restart from the host.
- Sandbox/proc/FD-bind failure: repair the container image or host namespace policy. Never launch an unconfined fallback.
- Resume/version failure: retain and inspect the partial diff and report the incompatibility.

Missing Codex auth affects only that delegation, not startup, Claude, or ordinary bash. Do not inspect environment values or credential files for readiness. Never request tokens in chat or transfer protected profiles. Ordinary `bash("codex ...")` has no broker authority; a role grant or guard acknowledgement does not change that.

The confidentiality guarantee covers private canonical credentials, not keys an operator already exposed through `.env`, source history, prompts, or model-readable files. Before release, the pinned CLI's live subscription first turn, tools, resume, refresh, and compaction still require qualification on supported Linux architectures.
