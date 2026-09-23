import { isCancel, log, note, select, text } from '@clack/prompts'

import type { OAuthCallbacks } from '@/init/oauth-login'

// Shared between `typeclaw init` (src/cli/init.ts) and `typeclaw provider
// add/set` (src/cli/provider.ts). Both call into the same OAuth runner, so
// they need to render the same UX: a note() box with the URL + cross-device
// guidance, a select() prompt for provider-defined choices, a text() prompt
// for the post-callback manual fallback, and a concurrent onManualCodeInput
// prompt for users whose browser is on a different host than the CLI. See
// src/init/oauth-login.ts for the contract on each callback and why
// onManualCodeInput is required for cross-device.
//
// Returns `{ callbacks, dispose }` rather than bare callbacks because of a
// pi-ai contract gap: pi-ai races `onManualCodeInput()` against the local
// callback server (packages/ai/src/utils/oauth/anthropic.ts:210-253). When
// the browser wins the race, pi-ai sets `result.code` and falls through to
// token exchange WITHOUT calling `server.cancelWait()` on the manual side —
// the manual `text()` prompt is left dangling in clack's render pipeline,
// re-appearing after every subsequent log line. Without the dispose hook,
// the user sees "Logged in to {Provider}" immediately followed by the stale
// "paste the redirect URL here" prompt that's now meaningless. Each call
// site (init/provider) MUST call `dispose()` in a finally after the OAuth
// runner returns so the orphaned prompt aborts cleanly; clack honors the
// signal by resolving the prompt with cancel state, the cancel branch
// throws inside our callback, and pi-ai's outer `.catch()` swallows it
// (since it stops awaiting the manual promise on the winning-browser path).
export type OAuthCallbackHandle = {
  callbacks: OAuthCallbacks
  dispose: () => void
}

export function buildOAuthCallbacks(providerName: string): OAuthCallbackHandle {
  const controller = new AbortController()
  const { signal } = controller
  return {
    dispose: () => controller.abort(),
    callbacks: {
      onAuth: (url, instructions) => {
        // Don't put the URL inside note(): clack wraps long lines with the box
        // border `│` on each wrapped segment, which corrupts the URL when the
        // user copy-pastes it. Keep instructional text in the box, but print
        // the URL itself as a bare console.log line that any terminal will
        // hyperlink intact.
        const preamble = [
          `Open this URL in your browser to sign in to ${providerName}.`,
          '',
          'If the page after sign-in shows a code to copy (or a "this site can\'t',
          'be reached" / "could not establish connection" error), copy that code —',
          'or the full address from the top of the browser — and paste it below.',
        ]
        if (instructions) preamble.push('', instructions)
        note(preamble.join('\n'), 'Browser login')
        console.log(url)
        console.log('')
      },
      onProgress: (message) => {
        log.info(message)
      },
      onPrompt: async (message, placeholder) => {
        const value = await text({
          message,
          signal,
          ...(placeholder !== undefined ? { placeholder } : {}),
        })
        if (isCancel(value)) return null
        return value
      },
      onSelect: async (message, options) => {
        const value = await select({
          message,
          options: options.map((option) => ({
            value: option.id,
            label: option.label,
            hint: option.description,
          })),
          signal,
        })
        if (isCancel(value)) return null
        return value
      },
      onManualCodeInput: async () => {
        const value = await text({
          message:
            'After signing in, paste the code shown on the page (some providers offer a copy button), or the full redirect address from the top of the browser:',
          placeholder: 'code, or http://localhost:1455/auth/callback?code=...&state=...',
          signal,
        })
        if (isCancel(value)) throw new Error('Login cancelled by user')
        return value
      },
    },
  }
}
