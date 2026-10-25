import { afterEach, describe, expect, test } from 'bun:test'

import { JSDOM } from 'jsdom'

import { CLEAR_FIELD_FUNCTION, fillSecretIntoFocusedField } from './fill-secret'

type Focus = { kind: string; field?: string }
type FakeOptions = {
  targets: { url: string }[]
  focus: Focus
  navigatesOnSubmit: boolean
  failOn?: 'Page.enable' | 'submit'
}
type Call = { method: string; params: Record<string, unknown>; sessionId?: string }

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

// Hand-rolled Chrome stand-in: answers the CDP commands the fill flow sends and
// fires a main-frame navigation when the page "submits".
function fakeChrome(options: FakeOptions): { cdpUrl: string; calls: Call[] } {
  const calls: Call[] = []
  server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw)) as Call & { id: number }
        calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
        const reply = (result: unknown): void => {
          ws.send(JSON.stringify({ id, result }))
        }
        const fail = (): void => {
          ws.send(JSON.stringify({ id, error: { message: `${method} failed` } }))
        }
        if (method === 'Page.enable' && options.failOn === 'Page.enable') return fail()
        switch (method) {
          case 'Target.getTargets':
            return reply({
              targetInfos: options.targets.map((t, i) => ({ targetId: `t${i}`, type: 'page', url: t.url })),
            })
          case 'Target.attachToTarget':
            return reply({ sessionId: 'S' })
          case 'Runtime.evaluate':
            return reply(
              params['returnByValue'] ? { result: { value: options.focus } } : { result: { objectId: 'el-1' } },
            )
          case 'Runtime.callFunctionOn': {
            const fn = String(params['functionDeclaration'])
            if (fn.includes('requestSubmit') && options.failOn === 'submit') return fail()
            reply({ result: { value: true } })
            if (fn.includes('requestSubmit') && options.navigatesOnSubmit) {
              ws.send(
                JSON.stringify({ method: 'Page.frameNavigated', sessionId: 'S', params: { frame: { id: 'main' } } }),
              )
            }
            return
          }
          default:
            return reply({})
        }
      },
    },
  })
  return { cdpUrl: `ws://127.0.0.1:${server.port}/devtools/browser/x`, calls }
}

const password: Focus = { kind: 'editable', field: 'input[type=password]' }
const insertedText = (calls: Call[]) =>
  calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params['text'])
const clearCalls = (calls: Call[]) =>
  calls.filter((c) => c.method === 'Runtime.callFunctionOn' && c.params['functionDeclaration'] === CLEAR_FIELD_FUNCTION)

describe('fillSecretIntoFocusedField', () => {
  test('types the value into the focused field, submits its form, and reports the navigation without the value', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://example.com/login' }],
      focus: password,
      navigatesOnSubmit: true,
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: true })

    expect(outcome).toEqual({ status: 'submitted', url: 'https://example.com/login', field: 'input[type=password]' })
    expect(JSON.stringify(outcome)).not.toContain('hunter2')
    expect(insertedText(calls)).toEqual(['hunter2'])
    expect(clearCalls(calls)).toEqual([])
  })

  test('clears the field when the submit does not navigate, so the value is not left on the page', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://example.com/login' }],
      focus: password,
      navigatesOnSubmit: false,
    })

    const outcome = await fillSecretIntoFocusedField({
      cdpUrl,
      value: 'hunter2',
      submit: true,
      navigationTimeoutMs: 50,
    })

    expect(outcome).toMatchObject({ status: 'not-navigated', cleared: true })
    expect(clearCalls(calls)).toHaveLength(1)
  })

  test('leaves a plain fill in place for non-submit fields such as an address', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://shop.example/checkout' }],
      focus: { kind: 'editable', field: 'textarea' },
      navigatesOnSubmit: false,
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: '1 Main St', submit: false })

    expect(outcome).toEqual({ status: 'filled', url: 'https://shop.example/checkout', field: 'textarea' })
    expect(insertedText(calls)).toEqual(['1 Main St'])
  })

  test('refuses without typing when nothing editable is focused', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://example.com/' }],
      focus: { kind: 'none', field: 'button' },
      navigatesOnSubmit: false,
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: false })

    expect(outcome).toMatchObject({ status: 'refused' })
    expect(insertedText(calls)).toEqual([])
  })

  test('asks for a url when several tabs are open, and uses the one it names', async () => {
    const targets = [{ url: 'https://a.example/login' }, { url: 'https://b.example/' }]
    const ambiguous = fakeChrome({ targets, focus: password, navigatesOnSubmit: false })
    expect(await fillSecretIntoFocusedField({ cdpUrl: ambiguous.cdpUrl, value: 'x', submit: false })).toMatchObject({
      status: 'refused',
    })
    expect(insertedText(ambiguous.calls)).toEqual([])
    server?.stop(true)

    const picked = fakeChrome({ targets, focus: password, navigatesOnSubmit: false })
    const outcome = await fillSecretIntoFocusedField({
      cdpUrl: picked.cdpUrl,
      value: 'x',
      submit: false,
      url: 'https://a.example',
    })
    expect(outcome).toMatchObject({ status: 'filled', url: 'https://a.example/login' })
    expect(picked.calls.find((c) => c.method === 'Target.attachToTarget')?.params['targetId']).toBe('t0')
  })

  test.each(['Page.enable', 'submit'] as const)(
    'clears the field and rethrows when %s fails after the value was typed',
    async (failOn) => {
      const { cdpUrl, calls } = fakeChrome({
        targets: [{ url: 'https://example.com/login' }],
        focus: password,
        navigatesOnSubmit: false,
        failOn,
      })

      await expect(fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: true })).rejects.toThrow('failed')

      expect(insertedText(calls)).toEqual(['hunter2'])
      expect(clearCalls(calls)).toHaveLength(1)
    },
  )
})

describe('CLEAR_FIELD_FUNCTION', () => {
  // Mirrors React's inputValueTracking: the element gets an own `value`
  // property whose setter records what the app last saw, and the change
  // plugin only fires onChange when the live value differs from that record.
  function controlledInput(dom: JSDOM, initial: string) {
    const input = dom.window.document.createElement('input')
    dom.window.document.body.append(input)
    const native = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!
    let tracked = ''
    const state = { value: initial }
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native.get!.call(input),
      set: (next: string) => {
        tracked = next
        native.set!.call(input, next)
      },
    })
    const render = (): void => {
      input.value = state.value
    }
    input.addEventListener('input', () => {
      const live = native.get!.call(input) as string
      if (live === tracked) return
      tracked = live
      state.value = live
    })
    render()
    return { input, state, render }
  }

  test('empties a controlled input so the app state is cleared and a re-render keeps it empty', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
    const { input, state, render } = controlledInput(dom, 'hunter2')
    const clear = dom.window.eval(`(${CLEAR_FIELD_FUNCTION})`) as (this: HTMLElement) => boolean

    expect(clear.call(input)).toBe(true)
    render()

    expect(state.value).toBe('')
    expect(input.value).toBe('')
  })
})
