#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundled `bun run`-able render script for the doc-render plugin: the agent runs
// `bun run <this> <doc.html> <out.pdf>`. Lives as a script (not a registered
// tool) so it costs zero always-on system-prompt context. It drives the Chrome
// the image already ships for agent-browser through playwright-core, which the
// agent installs on first use into writable per-session scratch (it downloads
// no browser). The document is self-contained: the agent writes its own CSS;
// nothing is injected. A4 applies unless the document's @page says otherwise.

// Keep in sync with the `bun add` line in skills/typeclaw-render-pdf/SKILL.md.
export const PLAYWRIGHT_PACKAGE = 'playwright-core'
export const PLAYWRIGHT_VERSION = '1.64.1'
export const RUNTIME_DIR = '/tmp/typeclaw-doc-render-runtime'
// Same default the image's agent-browser wrapper uses (src/init/dockerfile.ts);
// an operator AGENT_BROWSER_EXECUTABLE_PATH wins there and here.
export const DEFAULT_CHROME_PATH = '/usr/local/lib/typeclaw-agent-browser/chrome'
const RENDER_TIMEOUT_MS = 90_000

type Playwright = {
  chromium: {
    launch(options: { executablePath: string; args: string[]; timeout: number }): Promise<{
      newPage(): Promise<{
        goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<unknown>
        evaluate(fn: string): Promise<unknown>
        pdf(options: {
          path: string
          format: 'A4'
          preferCSSPageSize: boolean
          printBackground: boolean
        }): Promise<Uint8Array>
      }>
      close(): Promise<void>
    }>
  }
}

export function chromePath(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_BROWSER_EXECUTABLE_PATH || DEFAULT_CHROME_PATH
}

export function missingPlaywrightGuidance(): string {
  return [
    `doc-render: ${PLAYWRIGHT_PACKAGE} is not installed.`,
    '',
    'Install it in this session’s writable scratch runtime (it uses the Chrome',
    'already in the image and downloads no browser), then re-run the render from',
    'the document directory:',
    '',
    `  mkdir -p ${RUNTIME_DIR} && cd ${RUNTIME_DIR}`,
    `  bun add ${PLAYWRIGHT_PACKAGE}@${PLAYWRIGHT_VERSION}`,
    '',
    'Do NOT fall back to jsPDF, pdfkit, a canvas text dump, or Python ReportLab.',
  ].join('\n')
}

// The per-tool sandbox falls back to a degraded `--tmpfs /proc` on a host with
// no usable user namespaces, where Bun's loader can't read /proc/self/{fd,maps}
// and aborts with ENOTDIR. Rare since the proc-bind retry fix (typeclaw 0.35.1),
// but still possible on exotic runtimes — and unfixable by switching libraries.
function isNotDirError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOTDIR'
  )
}

function notDirGuidance(): string {
  return [
    'doc-render: the renderer aborted with a Bun "NotDir" / ENOTDIR error.',
    '',
    'This is the sandbox /proc degraded mode, not your markup: on a host with no',
    'usable user namespaces the per-tool sandbox falls back to a tmpfs /proc where',
    "bun can't run packages. Retry once; if it persists, report it as a",
    'sandbox/environment issue. A different PDF library will not fix it.',
  ].join('\n')
}

type ValidatedRuntimePackage = {
  entry: string
}

async function validateRuntimePackage(
  runtimeDir: string,
  packageName: string,
  version: string,
): Promise<ValidatedRuntimePackage> {
  const packageDir = join(runtimeDir, 'node_modules', ...packageName.split('/'))
  const manifestPath = join(packageDir, 'package.json')
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
  } catch {
    throw new Error(`doc-render: ${packageName}@${version} is not installed in ${runtimeDir}`)
  }
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(
      `doc-render: expected ${packageName}@${version} in ${runtimeDir}, found ${String(manifest.name)}@${String(manifest.version)}`,
    )
  }

  const resolved = Bun.resolveSync(packageDir, packageDir)
  const [realRuntimeDir, realPackageDir, realEntry] = await Promise.all([
    realpath(runtimeDir),
    realpath(packageDir),
    realpath(resolved),
  ])
  for (const [candidate, label] of [
    [realPackageDir, 'package'],
    [realEntry, 'entry'],
  ] as const) {
    const fromRuntime = relative(realRuntimeDir, candidate)
    if (fromRuntime === '..' || fromRuntime.startsWith(`..${sep}`) || isAbsolute(fromRuntime)) {
      throw new Error(`doc-render: ${packageName} ${label} resolves outside the scratch runtime`)
    }
  }
  const fromPackage = relative(realPackageDir, realEntry)
  if (fromPackage === '..' || fromPackage.startsWith(`..${sep}`) || isAbsolute(fromPackage)) {
    throw new Error(`doc-render: ${packageName} entry resolves outside its runtime-local package directory`)
  }
  return { entry: realEntry }
}

// Resolve only from the pinned scratch runtime. A document may contain an
// attacker-controlled node_modules tree, so its cwd must never enter resolution.
export async function loadPlaywright(runtimeDir: string = RUNTIME_DIR): Promise<Playwright> {
  const pkg = await validateRuntimePackage(runtimeDir, PLAYWRIGHT_PACKAGE, PLAYWRIGHT_VERSION)
  return (await import(pkg.entry)) as Playwright
}

export async function renderPdf(inFile: string, outFile: string): Promise<number> {
  const chrome = chromePath()
  if (!existsSync(chrome)) {
    throw new Error(
      `doc-render: no Chrome at ${chrome}. Set AGENT_BROWSER_EXECUTABLE_PATH to a Chrome/Chromium binary.`,
    )
  }
  const { chromium } = await loadPlaywright()
  // Chrome's own sandbox cannot nest inside the per-tool bwrap userns; bwrap
  // is the boundary here, same as for agent-browser.
  const browser = await chromium.launch({
    executablePath: chrome,
    args: ['--no-sandbox', '--allow-file-access-from-files'],
    timeout: RENDER_TIMEOUT_MS,
  })
  try {
    const page = await browser.newPage()
    await page.goto(pathToFileURL(resolve(inFile)).href, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS })
    await page.evaluate('document.fonts.ready')
    const pdf = await page.pdf({ path: resolve(outFile), format: 'A4', preferCSSPageSize: true, printBackground: true })
    return pdf.length
  } finally {
    await browser.close()
  }
}

const EXIT_RENDER_FAILED = 1
const EXIT_BAD_USAGE = 2
const EXIT_RENDERER_MISSING = 3

async function main(): Promise<void> {
  const [, , inFile, outFile] = process.argv
  if (!inFile || !outFile) {
    process.stderr.write('usage: bun run render.ts <doc.html> <out.pdf>\n')
    process.exit(EXIT_BAD_USAGE)
  }

  let bytes: number
  try {
    bytes = await renderPdf(inFile, outFile)
  } catch (error) {
    if (isNotDirError(error)) {
      process.stderr.write(`${notDirGuidance()}\n`)
      process.exit(EXIT_RENDER_FAILED)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(`${PLAYWRIGHT_PACKAGE}@${PLAYWRIGHT_VERSION} is not installed`)) {
      process.stderr.write(`${missingPlaywrightGuidance()}\n`)
      process.exit(EXIT_RENDERER_MISSING)
    }
    process.stderr.write(`doc-render: render failed: ${message}\n`)
    process.exit(EXIT_RENDER_FAILED)
  }

  process.stdout.write(`wrote ${outFile} (${bytes} bytes)\n`)
}

if (import.meta.main) {
  await main()
}
