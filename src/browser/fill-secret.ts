// Types a runtime-held value into the focused field of a managed-browser tab
// over CDP, so the model can enter a secret it never sees. The value only ever
// travels runtime -> Chrome; every outcome reports where it went, never what.

const COMMAND_TIMEOUT_MS = 10_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000

export type FillSecretOptions = {
  cdpUrl: string
  value: string
  url?: string
  submit: boolean
  navigationTimeoutMs?: number
}

export type FillSecretOutcome =
  | { status: 'filled'; url: string; field: string }
  | { status: 'submitted'; url: string; field: string }
  | { status: 'not-navigated'; url: string; field: string; cleared: boolean }
  | { status: 'refused'; reason: string }

export async function fillSecretIntoFocusedField(options: FillSecretOptions): Promise<FillSecretOutcome> {
  const cdp = await CdpConnection.open(options.cdpUrl)
  try {
    const target = await pickTarget(cdp, options.url)
    if ('reason' in target) return { status: 'refused', reason: target.reason }
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as {
      sessionId: string
    }
    // Background tabs (omowright opens them) report no focus; emulate it so
    // keyboard input reaches the focused element without stealing the window.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    const focused = await inspectFocus(cdp, sessionId)
    if (focused.kind === 'none') {
      return {
        status: 'refused',
        reason: `no editable field is focused on ${target.url}${focused.field === undefined ? '' : ` (focused: ${focused.field})`}; click or focus the field first`,
      }
    }

    await pressCommand(cdp, sessionId, 'selectAll')
    try {
      await cdp.send('Input.insertText', { text: options.value }, sessionId)
      if (!options.submit) return { status: 'filled', url: target.url, field: focused.field }

      await cdp.send('Page.enable', {}, sessionId)
      const navigated = cdp.waitForEvent(
        'Page.frameNavigated',
        sessionId,
        (params) => (params as { frame?: { parentId?: string } }).frame?.parentId === undefined,
        options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      )
      await submitField(cdp, sessionId, focused.objectId)
      if (await navigated) return { status: 'submitted', url: target.url, field: focused.field }
    } catch (error) {
      // The value may already be in the field; a failed step must not leave it there.
      if (focused.objectId !== undefined) await clearField(cdp, sessionId, focused.objectId)
      throw error
    }

    // The page stayed put (wrong value, inline error, SPA): don't leave the
    // secret sitting in the DOM for a later snapshot or script to read back.
    const cleared = focused.objectId !== undefined && (await clearField(cdp, sessionId, focused.objectId))
    return { status: 'not-navigated', url: target.url, field: focused.field, cleared }
  } finally {
    cdp.close()
  }
}

type TargetInfo = { targetId: string; type: string; url: string }

async function pickTarget(
  cdp: CdpConnection,
  url: string | undefined,
): Promise<{ targetId: string; url: string } | { reason: string }> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: TargetInfo[] }
  const pages = targetInfos.filter((t) => t.type === 'page' && !/^(devtools|chrome|chrome-extension):/.test(t.url))
  const matches = url === undefined ? pages : pages.filter((t) => t.url === url || t.url.startsWith(url))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    return { reason: url === undefined ? 'the shared browser has no open tab' : `no open tab matches ${url}` }
  }
  return { reason: `several tabs match; pass \`url\` to pick one of: ${matches.map((t) => t.url).join(', ')}` }
}

type FocusInfo = { kind: 'editable'; field: string; objectId?: string } | { kind: 'none'; field?: string }

// Walks shadow roots and same-origin iframes down to the real focused element.
// A cross-origin iframe (hosted card/key widgets) can't be inspected from the
// top frame, but keyboard input still lands in its focused field.
const FOCUS_EXPRESSION = `(() => {
  const deepest = (el) => { while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el }
  let el = deepest(document.activeElement)
  while (el && el.tagName === 'IFRAME') {
    let doc = null
    try { doc = el.contentDocument } catch {}
    if (!doc) return { kind: 'frame' }
    el = deepest(doc.activeElement)
  }
  if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return { kind: 'none' }
  const tag = el.tagName.toLowerCase()
  if (el.isContentEditable) return { kind: 'editable', field: tag + '[contenteditable]', el }
  const usable = !el.disabled && !el.readOnly
  if (tag === 'textarea') return usable ? { kind: 'editable', field: 'textarea', el } : { kind: 'none', field: tag }
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    const textual = ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(type)
    return textual && usable ? { kind: 'editable', field: 'input[type=' + type + ']', el } : { kind: 'none', field: 'input[type=' + type + ']' }
  }
  return { kind: 'none', field: tag }
})()`

async function inspectFocus(cdp: CdpConnection, sessionId: string): Promise<FocusInfo> {
  const described = (await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(() => { const r = ${FOCUS_EXPRESSION}; return { kind: r.kind, field: r.field } })()`,
      returnByValue: true,
    },
    sessionId,
  )) as { result: { value?: { kind: string; field?: string } } }
  const info = described.result.value
  if (info?.kind === 'frame') return { kind: 'editable', field: 'cross-origin iframe' }
  if (info?.kind !== 'editable' || info.field === undefined)
    return { kind: 'none', ...(info?.field ? { field: info.field } : {}) }
  // Hold a handle to the exact element so a later clear can't hit whatever
  // happens to be focused after the page changes.
  const handle = (await cdp.send('Runtime.evaluate', { expression: `(${FOCUS_EXPRESSION}).el` }, sessionId)) as {
    result: { objectId?: string }
  }
  return {
    kind: 'editable',
    field: info.field,
    ...(handle.result.objectId ? { objectId: handle.result.objectId } : {}),
  }
}

// Frameworks such as React shadow `value` on the element itself to track the
// last value they saw; assigning through that shadow updates the tracker, so the
// input event looks like no change and the app's state keeps the secret. Writing
// through the prototype's native setter leaves the tracker stale, so the app sees
// the edit and its own state is emptied too.
export const CLEAR_FIELD_FUNCTION = `function () {
  if (!this.isConnected) return true
  if (this.isContentEditable) {
    this.textContent = ''
    this.dispatchEvent(new Event('input', { bubbles: true }))
    return this.textContent === ''
  }
  let setter
  for (let proto = Object.getPrototypeOf(this); proto && !setter; proto = Object.getPrototypeOf(proto)) {
    setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  }
  if (!setter) return false
  setter.call(this, '')
  this.dispatchEvent(new Event('input', { bubbles: true }))
  return this.value === ''
}`

async function clearField(cdp: CdpConnection, sessionId: string, objectId: string): Promise<boolean> {
  const result = (await cdp
    .send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: CLEAR_FIELD_FUNCTION,
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => ({ result: { value: false } }))) as { result: { value?: boolean } }
  return result.result.value === true
}

async function pressCommand(cdp: CdpConnection, sessionId: string, command: string): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', commands: [command] }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' }, sessionId)
}

// A form without a submit button and with several fields ignores Enter (HTML
// implicit submission), so submit the owning form directly when there is one;
// script-driven logins with no form still get the Enter keystroke.
async function submitField(cdp: CdpConnection, sessionId: string, objectId: string | undefined): Promise<void> {
  if (objectId !== undefined) {
    const submitted = (await cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function () {
          if (!this.form) return false
          this.form.requestSubmit()
          return true
        }`,
        returnByValue: true,
      },
      sessionId,
    )) as { result: { value?: boolean } }
    if (submitted.result.value === true) return
  }
  await pressEnter(cdp, sessionId)
}

async function pressEnter(cdp: CdpConnection, sessionId: string): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId)
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type EventListener = { method: string; sessionId: string; onEvent: (params: unknown) => void }

class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<EventListener>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)))
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('browser connection closed'))
      }
      this.pending.clear()
    })
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error('could not connect to the shared browser')), {
        once: true,
      })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  // Registered before the triggering command so a fast event can't slip past.
  waitForEvent(
    method: string,
    sessionId: string,
    predicate: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const listener: EventListener = {
        method,
        sessionId,
        onEvent: (params) => {
          if (!predicate(params)) return
          finish(true)
        },
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(value)
      }
      this.listeners.add(listener)
    })
  }

  close(): void {
    this.socket.close()
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: unknown
      sessionId?: string
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    for (const listener of this.listeners) {
      if (listener.method === message.method && listener.sessionId === message.sessionId)
        listener.onEvent(message.params)
    }
  }
}
