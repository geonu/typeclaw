import { describe, expect, test } from 'bun:test'

import { classifyReviewClaim, isPositiveWarnCloseout, type ReviewClaim } from './github-review-claim'

const PRODUCTION_FIXED_SEGMENT = 'Verified: the original status-send latch issue is fixed at `2290b80`.'
const PRODUCTION_HOLD_OPEN_SEGMENT =
  'I can’t resolve this thread yet because the PR still has a blocking issue in the recovered-final-prose path.'
const PRODUCTION_KEEP_OPEN_SEGMENT =
  'Keeping this thread open while the remaining recovery-path blocker is addressed, so the PR can receive one clean re-review verdict afterward.'

const cases: ReadonlyArray<[string, ReviewClaim]> = [
  ['Approved!', 'block-approve'],
  ['**Approved** — nice work', 'block-approve'],
  ['I approve this PR', 'block-approve'],
  ['Approving now.', 'block-approve'],
  ['Approval submitted ✅', 'block-approve'],
  ['LGTM, approved', 'block-approve'],

  ['Requesting changes here.', 'block-request-changes'],
  ['Changes requested — see inline.', 'block-request-changes'],
  ['I request changes on this.', 'block-request-changes'],
  ['Blocking this PR until the leak is fixed.', 'block-request-changes'],

  // block-resolve
  ['Verified at abc123, that fixes it. Thanks!', 'block-resolve'],
  ['Thanks, looks resolved.', 'block-resolve'],
  ['Marked resolved.', 'block-resolve'],
  ['That resolves it — closing this out.', 'block-resolve'],
  ['Verified — that closes it, thanks!', 'block-resolve'],
  ['Confirmed fixed.', 'block-resolve'],
  [PRODUCTION_FIXED_SEGMENT, 'block-resolve'],

  // warn: soft signals, allowed through with a nudge
  ['LGTM', 'warn'],
  ['looks good', 'warn'],
  ['Looks good to me!', 'warn'],
  ['seems fine', 'warn'],
  ['this needs changes IMO', 'warn'],
  ['looks resolved?', 'warn'],

  ["I haven't approved yet — still reviewing.", 'ignore'],
  ['I cannot approve this until tests pass.', 'ignore'],
  ['not approved', 'ignore'],
  ["I'll approve once CI is green.", 'ignore'],
  ['Going to review this shortly.', 'ignore'],
  ['I approved it earlier, in my last review.', 'ignore'],
  ['Yes, I requested changes yesterday.', 'ignore'],
  // the re-review acknowledgement the GitHub session prompt prescribes must not read as a fresh receipt
  [
    'I approved `abc1234` earlier and it is still the head, so that verdict stands. Push new commits or point me at something specific to re-check.',
    'ignore',
  ],
  ['not LGTM yet — tests are still red', 'ignore'],
  ['This is not looks good territory yet.', 'ignore'],
  ['Please do not just say `LGTM`; submit the review.', 'ignore'],
  ['The comment "LGTM" is not enough here.', 'ignore'],
  ['Was this approved already?', 'ignore'],
  ['Who approved this?', 'ignore'],
  ['The pre-approved template text is unrelated.', 'ignore'],
  ['I confirmed the issue is not resolved yet.', 'ignore'],
  [PRODUCTION_HOLD_OPEN_SEGMENT, 'ignore'],
  ['Can you clarify the second point?', 'ignore'],
  ['', 'ignore'],

  // "addresses the concern" close-out family (PR #672) escalates as a positive warn.
  ['That addresses the concern nicely.', 'warn'],
  ['Thanks — addressed your feedback well.', 'warn'],
  // ...but genuine future/obligation "address" prose stays ignore.
  ["I'll address your feedback in the next push.", 'ignore'],
  ['Still need to address the concern before this lands.', 'ignore'],
  ['Going to address your review comments shortly.', 'ignore'],
  // A bare `to address` clause must NOT demote a hard claim in the same sentence (PR #675).
  ['Approved — thanks for updating the docs to address my feedback.', 'block-approve'],
  ['Requesting changes; please update the tests to address the leak.', 'block-request-changes'],
  [PRODUCTION_KEEP_OPEN_SEGMENT, 'warn'],
]

describe('classifyReviewClaim', () => {
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(classifyReviewClaim(text)).toBe(expected)
    })
  }

  test('block-tier outranks an embedded warn phrase', () => {
    // given a message carrying both a soft signal and a hard approval claim
    // when classified
    // then the hard claim wins
    expect(classifyReviewClaim('looks good — approved!')).toBe('block-approve')
  })

  test('negation demotes even when a block phrase is present', () => {
    expect(classifyReviewClaim("looks good but I haven't approved it")).toBe('ignore')
  })

  test('separate non-negated sentence can still carry the receipt', () => {
    expect(classifyReviewClaim("I didn't approve the previous revision. This one is approved.")).toBe('block-approve')
    expect(classifyReviewClaim("I haven't approved yet. LGTM on the current diff.")).toBe('warn')
  })

  test('lets a later refusal to close the thread veto an earlier resolved finding', () => {
    const text = `${PRODUCTION_FIXED_SEGMENT} ${PRODUCTION_HOLD_OPEN_SEGMENT}`

    expect(classifyReviewClaim(text)).not.toBe('block-resolve')
    expect(isPositiveWarnCloseout(text)).toBe(false)
  })

  test.each([
    ['Verified: the original issue is fixed. One issue remains.'],
    ['Verified: the original issue is fixed. 하지만 차단 문제가 남아 있어 이 스레드는 열어 둡니다.'],
  ])('applies the hold-open veto across the whole multilingual reply: %p', (text) => {
    expect(classifyReviewClaim(text)).not.toBe('block-resolve')
    expect(isPositiveWarnCloseout(text)).toBe(false)
  })

  test('does not let a hold-open marker veto a formal approval receipt', () => {
    expect(classifyReviewClaim('Approved. One minor issue remains.')).toBe('block-approve')
    expect(classifyReviewClaim('Requesting changes. One issue remains.')).toBe('block-request-changes')
  })

  test.each([
    ['The issue remained, but it is now fixed. Resolving this thread.'],
    ['One concern remained and has been addressed. Closing this out.'],
    ["Confirmed fixed. The issue that remained is now fixed, so I'm closing this out."],
    ['問題が残っていたが、今は修正済みです。 Confirmed fixed. Closing this out.'],
  ])('keeps completed remnant history in the close-out tier: %p', (text) => {
    expect(classifyReviewClaim(text)).toBe('block-resolve')
  })

  test('still vetoes a close-out when present work remains and the thread stays open', () => {
    const text = 'Confirmed fixed. One issue remains. Keeping this thread open.'

    expect(classifyReviewClaim(text)).not.toBe('block-resolve')
    expect(isPositiveWarnCloseout(text)).toBe(false)
  })
})

describe('classifyReviewClaim — multilingual verdicts', () => {
  const positives: ReadonlyArray<[string, ReviewClaim]> = [
    ['Aprobado, buen trabajo.', 'block-approve'],
    ['Aprovado, ótimo trabalho.', 'block-approve'],
    ['Approuvé, beau travail.', 'block-approve'],
    ['Approvato, ottimo lavoro.', 'block-approve'],
    ['Genehmigt, gute Arbeit.', 'block-approve'],
    [
      '\u041E\u0434\u043E\u0431\u0440\u0435\u043D\u043E, \u0445\u043E\u0440\u043E\u0448\u0430\u044F \u0440\u0430\u0431\u043E\u0442\u0430.',
      'block-approve',
    ], // Одобрено
    ['\u627F\u8A8D\u3057\u307E\u3057\u305F\u3002', 'block-approve'], // 承認しました
    ['\u5DF2\u6279\u51C6\u3002', 'block-approve'], // 已批准
    ['Onayland\u0131, te\u015Fekk\u00FCrler.', 'block-approve'], // Onaylandı
    ['Disetujui, kerja bagus.', 'block-approve'],

    ['Solicito cambios en esto.', 'block-request-changes'],
    ['Je demande des modifications ici.', 'block-request-changes'],
    ['Modifiche richieste, vedi commenti.', 'block-request-changes'],
    ['\u5909\u66F4\u3092\u8981\u6C42\u3057\u307E\u3059\u3002', 'block-request-changes'], // 変更を要求します
    ['\u8BF7\u6C42\u4FEE\u6539\u3002', 'block-request-changes'], // 请求修改
  ]

  for (const [text, expected] of positives) {
    test(`${JSON.stringify(text)} -> ${expected}`, () => {
      expect(classifyReviewClaim(text)).toBe(expected)
    })
  }

  // The load-bearing safety property: a declined or deferred verdict in any
  // supported language must NOT block a real reply.
  const demoted: readonly string[] = [
    'No apruebo esto todav\u00EDa.', // es: not approved yet
    'Ainda n\u00E3o aprovei isto.', // pt: not approved yet
    'N\u00E3o aprovado.', // pt: standalone "não" + aprovado (regression: was block-approve)
    'N\u00E3o aprovado ainda.', // pt
    "Je ne vais pas approuver pour l'instant.", // fr: I won't approve for now
    'Non ho ancora approvato.', // it
    'Ich werde das noch nicht genehmigen.', // de: won't approve yet
    '\u041F\u043E\u043A\u0430 \u043D\u0435 \u043E\u0434\u043E\u0431\u0440\u044F\u044E.', // ru: not approving for now
    '\u307E\u3060\u627F\u8A8D\u3057\u3066\u3044\u307E\u305B\u3093\u3002', // ja: not approved yet
    '\u8FD8\u6CA1\u6279\u51C6\u3002', // zh: not approved yet
    'Hen\u00FCz onaylamad\u0131m.', // tr: haven't approved yet (negation marker present)
    'Belum saya setujui.', // id: not yet approved
    'T\u00F4i ch\u01B0a duy\u1EC7t.', // vi: I haven't approved
  ]

  for (const text of demoted) {
    test(`negation/future demotes to ignore: ${JSON.stringify(text)}`, () => {
      expect(classifyReviewClaim(text)).toBe('ignore')
    })
  }

  test('a question about approval is not a verdict', () => {
    expect(classifyReviewClaim('\u00BFLo apruebo o pido cambios?')).toBe('ignore') // es "Do I approve or request changes?"
  })
})

describe('isPositiveWarnCloseout', () => {
  test.each(['LGTM', 'looks good', 'looks fine', 'seems fine', 'should be good', 'looks resolved'])(
    'true for approval/resolve-shaped warn: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(true)
    },
  )

  test.each(['this needs changes IMO', 'still needs work here'])(
    'false for negative warn that re-asserts a block: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(false)
    },
  )

  test.each(['Approved!', 'Confirmed fixed.', 'Can you clarify the second point?', ''])(
    'false for non-warn tiers: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(false)
    },
  )

  test('treats keeping the thread open as negative despite neighbouring positive-closeout words', () => {
    expect(isPositiveWarnCloseout(PRODUCTION_KEEP_OPEN_SEGMENT)).toBe(false)
  })
})
