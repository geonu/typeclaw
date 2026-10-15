import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'

import {
  DISCORD_MODES,
  familyModeOptions,
  holderSpinnerControl,
  printLinePincode,
  printLineQrUrl,
  reauthAdapterRejectionMessage,
  setAdapterRejectionMessage,
  SLACK_MODES,
  WEBEX_MODES,
  type LineAuthSpinnerHolder,
} from './channel'

function captureStream(): { stream: Writable; written: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return { stream, written: () => chunks.join('') }
}

describe('printLineQrUrl', () => {
  const url = 'https://line.me/R/au/lgn/sq/aBcDeFgHiJ?secret=Zm9vYmFyL21lL3NlY3JldA%3D%3D&e2eeVersion=1'

  test('writes the URL to the stream verbatim on its own line so it stays copyable', () => {
    // given
    const { stream, written } = captureStream()

    // when
    printLineQrUrl(url, stream)

    // then: the raw URL is emitted intact (no box border `│` splicing it apart)
    expect(written()).toContain(`${url}\n`)
    expect(written()).not.toContain('│')
  })
})

describe('printLinePincode', () => {
  test('writes the PIN verbatim and outside the note() gutter so digits are not split', () => {
    // given
    const { stream, written } = captureStream()

    // when
    printLinePincode('12345678', stream)

    // then
    expect(written()).toContain('12345678')
    expect(written()).not.toContain('│')
  })
})

describe('familyModeOptions', () => {
  test('preselects the recommended Bot mode for Slack when both modes are available', () => {
    // given both Slack modes are addable (CHANNEL_KINDS lists slack-bot before slack)
    const available = ['slack-bot', 'slack'] as const

    // when
    const options = familyModeOptions(SLACK_MODES, available)

    // then the recommended Bot (official) option is first, so options[0] is the default —
    // the QR user session is unofficial, so it must not be the default
    expect(options.map((o) => o.value)).toEqual(['slack-bot', 'slack'])
    expect(options[0]?.value).toBe('slack-bot')
  })

  test('preselects the recommended Bot mode for Discord when both modes are available', () => {
    // given both Discord modes are addable
    const available = ['discord-bot', 'discord'] as const

    // when
    const options = familyModeOptions(DISCORD_MODES, available)

    // then the recommended Bot (official) option is first; the QR user session is
    // unofficial, so it must not be the default
    expect(options.map((o) => o.value)).toEqual(['discord-bot', 'discord'])
    expect(options[0]?.value).toBe('discord-bot')
  })

  test('preselects the recommended User mode for Webex when both modes are available', () => {
    // given
    const available = ['webex', 'webex-bot'] as const

    // when
    const options = familyModeOptions(WEBEX_MODES, available)

    // then
    expect(options[0]?.value).toBe('webex')
  })

  test('keeps only the still-available mode when one is already configured', () => {
    // given only the bot mode is left to add
    const available = ['slack-bot'] as const

    // when
    const options = familyModeOptions(SLACK_MODES, available)

    // then
    expect(options.map((o) => o.value)).toEqual(['slack-bot'])
  })
})

describe('holderSpinnerControl', () => {
  function fakeSpinner(calls: string[]): LineAuthSpinnerHolder['current'] {
    return {
      start: (m?: string) => calls.push(`start:${m ?? ''}`),
      stop: (m?: string) => calls.push(`stop:${m ?? ''}`),
      message: () => {},
    } as unknown as LineAuthSpinnerHolder['current']
  }

  test('pause stops the live spinner and resume restarts it with the given message', () => {
    // given
    const calls: string[] = []
    const holder: LineAuthSpinnerHolder = { current: fakeSpinner(calls) }
    const control = holderSpinnerControl(holder)

    // when
    control.pause()
    control.resume('Waiting for you to confirm the PIN in the LINE app...')

    // then
    expect(calls).toEqual(['stop:', 'start:Waiting for you to confirm the PIN in the LINE app...'])
  })

  test('is a no-op when no spinner is active', () => {
    // given
    const holder: LineAuthSpinnerHolder = { current: null }
    const control = holderSpinnerControl(holder)

    // when / then: pausing/resuming without a live spinner must not throw
    expect(() => {
      control.pause()
      control.resume('anything')
    }).not.toThrow()
  })
})

describe('setAdapterRejectionMessage', () => {
  test('redirects reauthable adapters to `channel reauth` instead of dead-ending', () => {
    // given a user-mode adapter that rotates via full re-auth (the reported Discord bug)
    // when
    const message = setAdapterRejectionMessage('discord')

    // then it points at the command that actually works, not a contradictory one
    expect(message).toBe(
      'Adapter "discord" does not support `channel set`. Use `typeclaw channel reauth discord` instead.',
    )
  })

  test('gives a remove+add recipe for a known kind that is neither settable nor reauthable', () => {
    // given slack user-mode has no in-place rotation path
    // when
    const message = setAdapterRejectionMessage('slack')

    // then it does not falsely suggest reauth
    expect(message).toContain('typeclaw channel remove slack && typeclaw channel add slack')
    expect(message).not.toContain('reauth')
  })

  test('reports unknown adapters with the settable allow-list', () => {
    // when
    const message = setAdapterRejectionMessage('bogus')

    // then
    expect(message).toContain('Unknown adapter "bogus"')
  })
})

describe('reauthAdapterRejectionMessage', () => {
  test('redirects settable adapters to `channel set` instead of dead-ending', () => {
    // given discord-bot rotates via a token field, not re-auth (mirror of the reported bug)
    // when
    const message = reauthAdapterRejectionMessage('discord-bot')

    // then it points at the command that actually works
    expect(message).toBe(
      'Adapter "discord-bot" does not support reauth. Use `typeclaw channel set discord-bot` to rotate its credentials.',
    )
  })

  test('lists the supported adapters (now including discord) for a neither-settable-nor-reauthable kind', () => {
    // given slack user-mode is neither settable nor reauthable
    // when
    const message = reauthAdapterRejectionMessage('slack')

    // then discord user-mode is advertised as reauth-capable
    expect(message).toContain('does not support reauth. Supported:')
    expect(message).toContain('discord')
  })
})
