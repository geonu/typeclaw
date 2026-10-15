import { describe, expect, test } from 'bun:test'

import { toKakaoPlainText } from './kakaotalk-format'

describe('toKakaoPlainText — passthrough', () => {
  test('returns empty string for empty input', () => {
    expect(toKakaoPlainText('')).toBe('')
  })

  test('leaves plain prose untouched', () => {
    expect(toKakaoPlainText('hello world, nothing to strip here')).toBe('hello world, nothing to strip here')
  })

  test('preserves newlines', () => {
    expect(toKakaoPlainText('line one\nline two')).toBe('line one\nline two')
  })

  test('keeps emoji and non-ASCII content', () => {
    expect(toKakaoPlainText('확인 완료 ✅ (๑˃̵ᴗ˂̵)و')).toBe('확인 완료 ✅ (๑˃̵ᴗ˂̵)و')
  })
})

describe('toKakaoPlainText — bold', () => {
  test('strips **bold** markers', () => {
    expect(toKakaoPlainText('hello **world**!')).toBe('hello world!')
  })

  test('strips __bold__ when not adjacent to word chars', () => {
    expect(toKakaoPlainText('hello __world__ ok')).toBe('hello world ok')
  })

  test('does NOT treat snake_case as bold', () => {
    expect(toKakaoPlainText('use my__var__name here')).toBe('use my__var__name here')
  })
})

describe('toKakaoPlainText — italic', () => {
  test('strips *italic* markers', () => {
    expect(toKakaoPlainText('this is *italic* text')).toBe('this is italic text')
  })

  test('strips _italic_ markers', () => {
    expect(toKakaoPlainText('this is _italic_ text')).toBe('this is italic text')
  })

  test('does NOT italicize identifiers with underscores', () => {
    expect(toKakaoPlainText('field is user_id_value here')).toBe('field is user_id_value here')
  })

  test('does NOT italicize a*b math', () => {
    expect(toKakaoPlainText('compute a*b*c now')).toBe('compute a*b*c now')
  })
})

describe('toKakaoPlainText — inline code', () => {
  test('strips backticks, keeps content', () => {
    expect(toKakaoPlainText('call `formatAuthorLine` now')).toBe('call formatAuthorLine now')
  })

  test('content inside code is not re-tokenized', () => {
    expect(toKakaoPlainText('`a**b**c`')).toBe('a**b**c')
  })
})

describe('toKakaoPlainText — strikethrough', () => {
  test('strips ~~strike~~ markers', () => {
    expect(toKakaoPlainText('this is ~~gone~~ now')).toBe('this is gone now')
  })
})

describe('toKakaoPlainText — fenced code blocks', () => {
  test('strips fences and language hint, keeps body', () => {
    expect(toKakaoPlainText('```js\nconst x = 1\n```')).toBe('const x = 1')
  })

  test('strips bare fences', () => {
    expect(toKakaoPlainText('```\nplain body\n```')).toBe('plain body')
  })

  test('surrounding text survives a fenced block', () => {
    expect(toKakaoPlainText('before\n```\ncode\n```\nafter')).toBe('before\ncode\nafter')
  })

  test('an unterminated fence does not drop the tail', () => {
    expect(toKakaoPlainText('intro\n```js\nstill here')).toBe('intro\nstill here')
  })
})

describe('toKakaoPlainText — headings', () => {
  test('strips hashes at every level', () => {
    expect(toKakaoPlainText('# h1\n## h2\n###### h6')).toBe('h1\nh2\nh6')
  })

  test('does NOT strip a mid-line hash', () => {
    expect(toKakaoPlainText('issue #448 fixed')).toBe('issue #448 fixed')
  })
})

describe('toKakaoPlainText — blockquotes', () => {
  test('strips leading quote arrow', () => {
    expect(toKakaoPlainText('> quoted line')).toBe('quoted line')
  })

  test('does NOT strip a mid-line greater-than', () => {
    expect(toKakaoPlainText('a > b comparison')).toBe('a > b comparison')
  })
})

describe('toKakaoPlainText — links', () => {
  test('collapses [label](url) to "label (url)"', () => {
    expect(toKakaoPlainText('see [the docs](https://example.com)')).toBe('see the docs (https://example.com)')
  })

  test('keeps a bare label when url is empty', () => {
    expect(toKakaoPlainText('[label]()')).toBe('label')
  })
})

describe('toKakaoPlainText — lists', () => {
  test('numbered list markers stay (they read fine unrendered)', () => {
    expect(toKakaoPlainText('1. first\n2. second')).toBe('1. first\n2. second')
  })

  test('bullet markers stay', () => {
    expect(toKakaoPlainText('- one\n- two')).toBe('- one\n- two')
  })
})

describe('toKakaoPlainText — realistic agent reply', () => {
  test('strips the spammy markdown from a release-notes summary', () => {
    const input = [
      'Hi, I checked the 0.13.0 / 0.14.0 release notes and the code!',
      '',
      'Fixed ✅',
      '1. **channel_reply JSON leak** — 0.13.0 (#448) `isLikelyPlainTextChannelToolCall` added',
      '2. **weekday/timezone confusion** — 0.13.0 (#457) `formatLocalWeekday` added',
      '',
      'Not yet fixed ❌',
      '3. **duplicate bot name** — `formatAuthorLine` unchanged',
    ].join('\n')

    const expected = [
      'Hi, I checked the 0.13.0 / 0.14.0 release notes and the code!',
      '',
      'Fixed ✅',
      '1. channel_reply JSON leak — 0.13.0 (#448) isLikelyPlainTextChannelToolCall added',
      '2. weekday/timezone confusion — 0.13.0 (#457) formatLocalWeekday added',
      '',
      'Not yet fixed ❌',
      '3. duplicate bot name — formatAuthorLine unchanged',
    ].join('\n')

    expect(toKakaoPlainText(input)).toBe(expected)
  })
})
