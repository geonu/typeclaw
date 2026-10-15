import { describe, expect, test } from 'bun:test'

import { escapeMarkdownV2, toTelegramMarkdownV2 } from './telegram-bot-format'

describe('escapeMarkdownV2', () => {
  test('escapes every MarkdownV2 reserved character outside entities', () => {
    const input = '_*[]()~`>#+-=|{}.!\\'
    const out = escapeMarkdownV2(input)
    for (const ch of input) {
      expect(out.includes('\\' + ch)).toBe(true)
    }
  })

  test('leaves alphanumerics and whitespace untouched', () => {
    expect(escapeMarkdownV2('hello world\n123')).toBe('hello world\n123')
  })
})

describe('toTelegramMarkdownV2 — plain text safety', () => {
  test('the original v1 mutation-guard string passes through with every special escaped', () => {
    const out = toTelegramMarkdownV2('a < b & c > d (with) raw . ! _ * special chars')
    expect(out).toBe('a < b & c \\> d \\(with\\) raw \\. \\! \\_ \\* special chars')
  })

  test('a string of nothing but reserved chars is fully escaped', () => {
    expect(toTelegramMarkdownV2('.!?-')).toBe('\\.\\!?\\-')
  })

  test('newlines pass through unescaped (Telegram treats them as literal)', () => {
    expect(toTelegramMarkdownV2('line one\nline two')).toBe('line one\nline two')
  })

  test('returns empty string for empty input', () => {
    expect(toTelegramMarkdownV2('')).toBe('')
  })
})

describe('toTelegramMarkdownV2 — bold', () => {
  test('converts **bold** to *bold*', () => {
    expect(toTelegramMarkdownV2('hello **world**!')).toBe('hello *world*\\!')
  })

  test('converts __bold__ to *bold* when not adjacent to word chars', () => {
    expect(toTelegramMarkdownV2('hello __world__ ok')).toBe('hello *world* ok')
  })

  test('does NOT treat my__var__name as bold (snake_case guard)', () => {
    const out = toTelegramMarkdownV2('use my__var__name here')
    expect(out).not.toContain('*var*')
    expect(out).toBe('use my\\_\\_var\\_\\_name here')
  })

  test('escapes special chars inside bold', () => {
    expect(toTelegramMarkdownV2('**a.b!c**')).toBe('*a\\.b\\!c*')
  })
})

describe('toTelegramMarkdownV2 — italic', () => {
  test('converts *italic* to _italic_', () => {
    expect(toTelegramMarkdownV2('this is *italic* text')).toBe('this is _italic_ text')
  })

  test('converts _italic_ to _italic_', () => {
    expect(toTelegramMarkdownV2('this is _italic_ text')).toBe('this is _italic_ text')
  })

  test('does NOT italicize snake_case identifiers', () => {
    expect(toTelegramMarkdownV2('see my_var_name in code')).toBe('see my\\_var\\_name in code')
  })

  test('does NOT italicize a*b*c (asterisk between word chars)', () => {
    expect(toTelegramMarkdownV2('a*b*c')).toBe('a\\*b\\*c')
  })

  test('does not italicize across line breaks', () => {
    const out = toTelegramMarkdownV2('start *line one\nline two* end')
    expect(out).toContain('\\*line one')
    expect(out).not.toContain('_line one')
  })
})

describe('toTelegramMarkdownV2 — inline code', () => {
  test('preserves inline code and only escapes ` and \\ inside', () => {
    expect(toTelegramMarkdownV2('use `foo.bar()` here')).toBe('use `foo.bar()` here')
  })

  test('special chars inside `code` are NOT escaped (would render as literal backslashes)', () => {
    expect(toTelegramMarkdownV2('`a.b!c`')).toBe('`a.b!c`')
  })

  test('a backslash inside inline code is doubled', () => {
    expect(toTelegramMarkdownV2('`a\\b`')).toBe('`a\\\\b`')
  })

  test('formatting markers inside inline code are literal', () => {
    expect(toTelegramMarkdownV2('`**not bold**`')).toBe('`**not bold**`')
  })
})

describe('toTelegramMarkdownV2 — fenced code blocks', () => {
  test('renders a fenced block with a language hint', () => {
    const input = '```python\ndef hi():\n    print("hi")\n```'
    expect(toTelegramMarkdownV2(input)).toBe('```python\ndef hi():\n    print("hi")\n```')
  })

  test('renders a fenced block without a language hint', () => {
    expect(toTelegramMarkdownV2('```\nplain code\n```')).toBe('```\nplain code\n```')
  })

  test('escapes ` and \\ inside the body but leaves other specials alone', () => {
    expect(toTelegramMarkdownV2('```\na.b! \\path c`d\n```')).toBe('```\na.b! \\\\path c\\`d\n```')
  })

  test('inline markers inside fence are literal, not parsed', () => {
    const out = toTelegramMarkdownV2('```\n**not bold** *not italic*\n```')
    expect(out).toContain('**not bold** *not italic*')
  })

  test('text around a fence is tokenized normally', () => {
    expect(toTelegramMarkdownV2('before **bold**\n```\nx\n```\nafter *italic*')).toBe(
      'before *bold*\n```\nx\n```\nafter _italic_',
    )
  })

  test('unterminated fence falls through to inline handling without swallowing the rest', () => {
    const out = toTelegramMarkdownV2('```python\nstuck')
    expect(out).toContain('python')
    expect(out).toContain('stuck')
  })
})

describe('toTelegramMarkdownV2 — links', () => {
  test('converts [label](url) to a MarkdownV2 link with proper escaping', () => {
    expect(toTelegramMarkdownV2('see [docs](https://example.com)')).toBe('see [docs](https://example.com)')
  })

  test('escapes special chars in the label per outside-entity rules', () => {
    expect(toTelegramMarkdownV2('[hi.](https://x)')).toBe('[hi\\.](https://x)')
  })

  test('escapes \\ in the url, but leaves dots / dashes literal', () => {
    expect(toTelegramMarkdownV2('[docs](https://example.com/v1.2-beta\\path)')).toBe(
      '[docs](https://example.com/v1.2-beta\\\\path)',
    )
  })

  test('a url with an unescaped ( falls through as escaped literals (avoids ambiguous close)', () => {
    const out = toTelegramMarkdownV2('[w](https://en.wikipedia.org/wiki/Foo_(bar))')
    expect(out).not.toContain('](http')
    expect(out).toContain('Foo')
  })

  test('a bare bracket pair without (url) is not a link', () => {
    expect(toTelegramMarkdownV2('see [todo] item')).toBe('see \\[todo\\] item')
  })

  test('a label with a newline disqualifies the link match', () => {
    expect(toTelegramMarkdownV2('[hello\nworld](https://x)')).toContain('\\[hello')
  })
})

describe('toTelegramMarkdownV2 — strikethrough and spoiler', () => {
  test('~~strike~~ becomes ~strike~', () => {
    expect(toTelegramMarkdownV2('this is ~~gone~~')).toBe('this is ~gone~')
  })

  test('||spoiler|| stays as ||spoiler||', () => {
    expect(toTelegramMarkdownV2('the answer is ||42||')).toBe('the answer is ||42||')
  })
})

describe('toTelegramMarkdownV2 — combined and adversarial', () => {
  test("the assistant's example reply formats correctly", () => {
    const input = 'Ha! See, **yours** works perfectly. *Bold*, *italic*, `code`—all rendered nice.'
    expect(toTelegramMarkdownV2(input)).toBe(
      'Ha\\! See, *yours* works perfectly\\. _Bold_, _italic_, `code`—all rendered nice\\.',
    )
  })

  test('mixed inline code and bold with punctuation that must escape', () => {
    expect(toTelegramMarkdownV2('Run `npm install` first, **then** open it!')).toBe(
      'Run `npm install` first, *then* open it\\!',
    )
  })

  test('a paragraph of pure prose with periods, hyphens, and a link', () => {
    expect(toTelegramMarkdownV2('Hello — visit [our docs](https://example.com/path-here) for v1.2.3 details.')).toBe(
      'Hello — visit [our docs](https://example.com/path-here) for v1\\.2\\.3 details\\.',
    )
  })

  test('a heading-style line falls through as escaped literals (Telegram has no headings)', () => {
    expect(toTelegramMarkdownV2('# Title')).toBe('\\# Title')
  })

  test('list markers fall through escaped (Telegram has no native lists)', () => {
    expect(toTelegramMarkdownV2('- item one\n- item two')).toBe('\\- item one\n\\- item two')
  })

  test('an empty bold pair `****` does not crash and does not produce a Telegram-rejected entity', () => {
    const out = toTelegramMarkdownV2('here ****  there')
    expect(out).toBe('here \\*\\*\\*\\*  there')
  })
})
