# `docker.file` reference — toggle catalog and build internals

Companion to the **Dockerfile** section of the `typeclaw-config` SKILL.md. The SKILL.md owns the entry point and the per-question playbooks; this file is the lookup table for the individual `docker.file` toggles and the build-layer internals. Consult it when the user wants a specific package toggled/pinned, or asks how the toggles land in the image.

## Toggle fields

`docker.file` has two layers of customization:

1. **Toggles** for opinionated package installs typeclaw knows how to layer correctly (`tmux`, `gh`, `python`, `ffmpeg`, `cjkFonts`, `cloudflared`, `xvfb`, `claudeCode`, `codexCli`, `omoCli`). Most are apt packages — boolean for on/off, version string for an apt pin (e.g. `"gh": "2.40.0"` → `gh=2.40.0`) — and benefit from BuildKit cache mounts. `cloudflared`, `claudeCode`, `codexCli`, and `omoCli` are the exceptions: `cloudflared` downloads the pinned GitHub release, `claudeCode` runs Anthropic's `curl | bash` installer, `codexCli` `bun install`s the `@openai/codex` npm package, and `omoCli` downloads digest-verified OmO Native 5.1.19 assets; all four are boolean-only. Use a toggle whenever it covers what the user wants over a hand-rolled `append` entry.
2. **`append`** is the escape hatch for everything the toggles don't cover. An array of single-line Dockerfile instructions spliced in right before `ENTRYPOINT`, prefixed with a `# Custom lines from typeclaw.json#docker.file.append.` comment.

| Field         | Required | Type                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tmux`        | no       | boolean \| string   | Default `true`. `false` omits tmux from the apt install. String pins the Debian package version (e.g. `"3.3a-3"` → `tmux=3.3a-3`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `gh`          | no       | boolean \| string   | Default `true`. `false` omits **both** the `gh` package and the GitHub CLI keyring bootstrap layer (skipping the network roundtrip on cold builds). String pins the version.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `python`      | no       | boolean             | Default `true`. Fans out to `python3 python3-pip python3-venv python-is-python3` (the bundle that makes `python` and `pip` resolve correctly inside the container). Boolean-only — no version pin, because Debian's `python3` is a meta-package that doesn't accept a useful pin.                                                                                                                                                                                                                                                                                                                                              |
| `ffmpeg`      | no       | boolean \| string   | Default `false`. `true` apt-installs ffmpeg (~80 MB of codecs). String pins the version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cjkFonts`    | no       | boolean or `"auto"` | Default `"auto"`. Installs `fonts-noto-cjk` (~89 MB) so Chromium (used by `agent-browser`) renders Korean/Japanese/Chinese glyphs correctly in screenshots, `page.pdf()`, and other raster output. `"auto"` resolves at `typeclaw start` from the host locale (`LANG`/`LC_ALL`/`Intl`): a CJK host (ja/ko/zh) installs the fonts, any other host skips them. An explicit `true`/`false` forces the decision. `false` skips the layer entirely (DOM/innerText scraping is unaffected by font absence — only raster output shows tofu boxes).                                                                                    |
| `cloudflared` | no       | boolean             | Default `false`. Downloads the pinned `cloudflared` GitHub release (~38 MB) into the image so `cloudflare-quick` tunnels work. Default `false` skips the layer on agents that don't use tunnels; `typeclaw tunnel add` / `channel add github` with a Cloudflare provider flip it to `true` automatically and prompt for a restart, so the happy path needs no manual edit. If the binary is absent when a tunnel starts, the tunnel goes `permanently-failed` with a "set docker.file.cloudflared: true and run typeclaw restart" message. Boolean-only — pinning is owned by the typeclaw release.                            |
| `xvfb`        | no       | boolean             | Default `true`. Installs `xvfb` (~5 MB) so the entrypoint shim can spawn a virtual X server and export `DISPLAY=:99`, giving headed Chrome (agent-browser `--headed`, headful Playwright) a real X11 display to defeat headless-mode WAF fingerprinting. `false` skips the layer; the shim self-heals (no `Xvfb` on PATH → execs the agent without `DISPLAY`). Boolean-only — xvfb tracks the upstream X server release with no useful apt pin.                                                                                                                                                                                |
| `claudeCode`  | no       | boolean             | Default `false`. `true` runs Anthropic's official installer with version argument `2.1.299`, copies the resolved executable into root-owned `/usr/local/lib/typeclaw-coding-agents/claude/2.1.299/claude`, and links `/usr/local/bin/claude` there so model bash's bwrap sandbox can execute it without binding `/root`. The layer retains the existing hooks and `~/.claude.json` onboarding seed. Boolean-only; the version pin is owned by the TypeClaw release. Protected authentication profiles remain masked.                                                                                                           |
| `codexCli`    | no       | boolean             | Default `false`. `true` runs `bun install -g @openai/codex@0.162.1` with `BUN_INSTALL=/usr/local/lib/typeclaw-coding-agents/codex` and `BUN_INSTALL_BIN=/usr/local/lib/typeclaw-coding-agents/codex/bin`. The root-owned global package tree (including the vendored native binary) stays under `/usr/local`; `/usr/local/bin/codex` invokes its JS launcher with Bun because the image's `node` fallback is outside the sandbox PATH. The layer retains the existing hook scripts and `~/.codex/hooks.json`. Boolean-only; the version pin is owned by the TypeClaw release. Protected authentication profiles remain masked. |
| `omoCli`      | no       | boolean             | Default `false`. Installs digest-verified OmO Native 5.1.19 (arm64 or amd64-baseline) under `/usr/local/lib/typeclaw-coding-agents/omo/5.1.19/`, linked from `/usr/local/bin/omo`. Both Dockerfile branches use the same pin. Task-local HOME/config and broker authority come from `coding_agent`; no provider profile is installed. See `typeclaw-omo-cli`.                                                                                                                                                                                                                                                                  |
| `append`      | no       | array of strings    | Each entry is a single Dockerfile line — schema **rejects** entries containing `\n` or `\r`. Defaults to `[]`. Splice happens just before `ENTRYPOINT`, after `ENV NODE_ENV=production`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Toggle version strings reject whitespace and `=` (apt-injection guard) — pass just the version, not `pkg=ver`.

## The single-line constraint (`append` only)

Each entry of `append` must be one Dockerfile instruction's worth of source — a `RUN`, `ENV`, `COPY`, `ARG`, etc. The schema enforces "no embedded newlines" because a multiline string in the JSON would silently break Dockerfile syntax (Dockerfile line continuations require backslashes at end-of-line, and a JSON multiline doesn't carry those). If the user wants a logically multi-step instruction, give them two entries:

```json
"docker": {
  "file": {
    "append": [
      "RUN apt-get update && apt-get install -y --no-install-recommends ripgrep fd-find",
      "ENV CUSTOM_TOOL=1"
    ]
  }
}
```

A single `RUN` with `&&`-chained shell commands is fine and idiomatic — that's still a single Dockerfile line. What's rejected is a literal newline inside the JSON string.

## Where things land in the build

The template's last layers are roughly:

```
RUN apt-get install ... <baseline + enabled toggle packages>   ← toggles fan out into this line
...
ENV NODE_ENV=production
# Custom lines from typeclaw.json#docker.file.append.   ← only emitted when append is non-empty
<your appended lines>
ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]
CMD ["run"]
```

The toggle-driven apt install benefits from BuildKit `--mount=type=cache` on `/var/cache/apt` and `/var/lib/apt/lists`, so toggling `ffmpeg: true` (or pinning `gh: "2.40.0"`) only re-fetches what changed. The `gh` keyring bootstrap is in its own earlier layer that's gated on `gh` being enabled — turning `gh: false` saves the network roundtrip even on cold builds.

`append` runs after every cache-friendly base layer (apt setup, the toggle-driven apt install, `agent-browser`, Chrome for Testing on amd64), so changing `append` invalidates only the final layer. Conversely, putting `apt-get install` in `append` is **slower than using a toggle** (no BuildKit cache mount) — and if the package you want is `tmux/gh/python/ffmpeg/cjkFonts`, just use the toggle.

## Restart and rebuild semantics

- **Restart-required.** `docker.file` is in `FIELD_EFFECTS` as restart-required. `reload` reports the change as `restartRequired` and the live container keeps running on the old image.
- **The next `typeclaw start` rebuilds the image automatically.** No `--build` flag is needed; the CLI re-runs `docker build` whenever the Dockerfile content has changed (it rewrites the file from the current template + current `docker.file` block every start). Tell the user: "Edited `docker.file` — restart-required. The next `typeclaw start` will rewrite the Dockerfile and rebuild the image."
- **Pre-existing host-side edits to the Dockerfile are clobbered.** If the user manually edited the Dockerfile before, the next `start` overwrites it and (if the working tree was dirty) auto-commits the cleanup. This is by design; don't try to preserve manual edits.
