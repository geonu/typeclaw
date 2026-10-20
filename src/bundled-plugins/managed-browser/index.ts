import { join } from 'node:path'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { type ManagedBrowser, startManagedBrowser } from '@/browser/managed-browser'
import { BROWSER_ENGINES, type BrowserConfig, needsManagedBrowser } from '@/browser/registry'
import { getConfig } from '@/config'
import type { PermissionService } from '@/permissions'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import { definePlugin, type Hooks } from '@/plugin'

const SKILLS_ROOT = join(import.meta.dir, 'skills')

export default definePlugin({
  plugin: async (ctx) => {
    // Boot snapshot: `browser` is restart-required, matching the image layers
    // and the browser process started below.
    const browser = getConfig().browser
    const skillsDirs = browserSkillDirs(browser)
    if (!needsManagedBrowser(browser)) return { skillsDirs }

    let managed: ManagedBrowser
    try {
      managed = await startManagedBrowser({ agentDir: ctx.agentDir, browser, logger: ctx.logger })
    } catch (error) {
      ctx.logger.error(`managed browser failed to start; browser engines are unavailable: ${String(error)}`)
      return { skillsDirs }
    }
    const overlay = browserEnvOverlay(browser, managed)

    return {
      skillsDirs,
      hooks: { 'tool.before': sharedBrowserBashHook(ctx.permissions, overlay) },
      onDispose: () => managed.stop(),
    }
  },
})

export function sharedBrowserBashHook(
  permissions: PermissionService,
  overlay: Record<string, string>,
): NonNullable<Hooks['tool.before']> {
  return (event) => {
    if (event.tool !== 'bash') return
    if (!permissions.has(event.origin, CORE_PERMISSIONS.browserShared)) return
    const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
    const current = existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}
    event.args[TYPECLAW_INTERNAL_BASH_ENV] = { ...current, ...overlay }
  }
}

export function browserSkillDirs(browser: BrowserConfig): string[] {
  const ids = [...browser.engines.filter((id) => id !== 'agent-browser'), ...browser.extensions]
  // One root per id (skills/<id>/<skill>/SKILL.md) so disabled engines stay out of the catalog.
  return ids.map((id) => join(SKILLS_ROOT, id))
}

export function browserEnvOverlay(
  browser: BrowserConfig,
  managed: Pick<ManagedBrowser, 'cdpUrl' | 'filesDir' | 'bskRelay' | 'token'>,
) {
  const env: Record<string, string> = {
    TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
    TYPECLAW_BROWSER_FILES: managed.filesDir,
  }
  for (const id of browser.engines) Object.assign(env, BROWSER_ENGINES[id].env(managed.cdpUrl))
  if (managed.bskRelay !== undefined) {
    Object.assign(env, { TYPECLAW_BSK_RELAY: managed.bskRelay, TYPECLAW_BSK_TOKEN: managed.token })
  }
  return env
}
