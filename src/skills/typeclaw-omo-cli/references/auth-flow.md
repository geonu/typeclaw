# OmO authentication through the broker

Host setup is `docker.file.omoCli:true`, `typeclaw provider add anthropic` or `typeclaw provider add openai-codex`, then `typeclaw start`. Anthropic supports API-key or subscription OAuth credentials; `openai-codex` supports ChatGPT subscription OAuth only. Do not silently switch billing surfaces.

The trusted runtime resolves and refreshes credentials. A per-invocation broker authenticates a fresh local capability, permits only the selected model and exact inference routes, rebuilds headers, and uses fixed upstreams. OmO's Anthropic OAuth capability has a transport compatibility prefix but is not a real OAuth token. The child never receives an access, refresh, or ID token, account identifier, or exported auth profile.

The generated provider config routes main, category, named-agent, and compaction calls through this broker. Categories use one explicit model chain; named agents clear inherited fallback chains. Memory side models, telemetry, update checks, ambient OAuth extensions, and MCP startup are disabled. Ordinary dependency downloads and tool networking remain governed by the outer sandbox, not by an offline marketing claim.

Missing credentials affect only the requested task. Ask the host operator to repair the chosen provider using its setup command, then retry. Missing binary or sandbox support requires an image rebuild or host namespace repair, never an unconfined fallback. Missing exact session data requires restoration or review of retained changes, not a fresh conversation disguised as a resume.

The guarantee covers private canonical credentials. Keys already exposed in `.env`, prompts, source objects, or model-readable files are outside it. Live subscription tools, resume, refresh, compaction, and Linux amd64/arm64 bwrap execution remain release gates; mock traffic does not establish upstream acceptance.
