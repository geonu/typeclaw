// Installed as /usr/local/bin/bsk. The BrowserSkill daemon socket is
// runtime-private; this gives the real CLI a per-call BSK_HOME whose socket is
// bridged to TypeClaw's token-gated relay, so only sessions handed the token
// (roles with browser.shared) can drive the shared browser through bsk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const relay = process.env.TYPECLAW_BSK_RELAY
const token = process.env.TYPECLAW_BSK_TOKEN
if (!relay || !token) {
  console.error(
    'bsk: the shared browser is unavailable in this session (it needs the browser.shared permission, or the browser failed to start; the operator log says which).',
  )
  process.exit(2)
}
const separator = relay.lastIndexOf(':')
const host = relay.slice(0, separator)
const port = Number(relay.slice(separator + 1))

const home = mkdtempSync(join(tmpdir(), 'typeclaw-bsk-'))
mkdirSync(join(home, 'run'), { mode: 0o700 })
const server = createServer((inbound) => {
  const outbound = connect(port, host, () => {
    outbound.write(token + '\n')
    inbound.pipe(outbound)
    outbound.pipe(inbound)
  })
  const close = () => {
    inbound.destroy()
    outbound.destroy()
  }
  inbound.on('error', close)
  outbound.on('error', close)
  inbound.on('close', close)
  outbound.on('close', close)
})
const sockPath = join(home, 'run', 'daemon.sock')
await new Promise((resolve) => server.listen(sockPath, resolve))
// The CLI locates its daemon through daemon.json and cross-checks its pid
// against the daemon, so mirror the real file and point only sock_path here.
const daemon = await describeDaemon().then(JSON.parse, () => {
  console.error(
    'bsk: the shared browser refused this session or its BrowserSkill daemon is not running; the operator log says which.',
  )
  rmSync(home, { recursive: true, force: true })
  process.exit(2)
})
writeFileSync(join(home, 'daemon.json'), JSON.stringify({ ...daemon, sock_path: sockPath }))

function describeDaemon() {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => socket.write(token + ' describe\n'))
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk
    })
    socket.on('end', () => (text === '' ? reject(new Error('daemon not available')) : resolve(text)))
    socket.on('error', reject)
  })
}

const child = Bun.spawn(
  [process.env.TYPECLAW_BSK_BIN ?? '/usr/local/lib/typeclaw-browser/bsk/bsk', ...process.argv.slice(2)],
  {
    env: { ...process.env, BSK_HOME: home, BSK_AUTO_START: '0' },
    stdio: ['inherit', 'inherit', 'inherit'],
  },
)
const code = await child.exited
server.close()
rmSync(home, { recursive: true, force: true })
process.exit(code)
