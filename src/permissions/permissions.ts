import type { SessionOrigin } from '@/agent/session-origin'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROLES, CORE_PERMISSIONS, expandOwnerWildcard, isBuiltinRoleName } from './builtins'
import type { MatchRule } from './match-rule'
import { matchesOrigin } from './resolve'
import type { RoleConfig, RolesConfig } from './schema'

export type PermissionService = {
  has(origin: SessionOrigin | undefined, permission: string): boolean
  resolveRole(origin: SessionOrigin | undefined): string
  // Discovery/delegation must distinguish an actual rule from the guest fallback.
  resolveRole(origin: SessionOrigin | undefined, options: { requireMatch: true }): string | undefined
  describe(origin: SessionOrigin | undefined): { role: string; permissions: readonly string[] }
  // Orders two role names on the severity tower so callers can cap an
  // action to the requester's role (a guest turn must not read the output
  // of a member-spawned subagent). `undefined` means an unknown role on
  // either side and MUST be treated as deny, never allow — mistreating it
  // as allow reopens the privilege-escalation hole this gate closes.
  compareRoleSeverity(a: string, b: string): -1 | 0 | 1 | undefined
  // Resolved (wildcard-expanded) permission set for a role NAME, or
  // `undefined` for an unknown role. Unlike `describe`, which takes an
  // origin, this answers "what can role X do" directly — needed for
  // capability-dominance checks (e.g. "may the caller schedule deferred
  // work as role X") that cannot use the coarse `compareRoleSeverity`
  // tower, since custom roles are arbitrary permission bags with no
  // inherent ordering. Callers MUST treat `undefined` as deny.
  permissionsForRole(role: string): readonly string[] | undefined
  // Rebuilds the resolved role table from the given roles config, preserving
  // the same plugin-permission set captured at construction time. Used by
  // the config reloadable so role match-rule edits (typeclaw role claim,
  // hand-edits to typeclaw.json) take effect without a container restart.
  replaceRoles(roles: RolesConfig | undefined): void
  // Rebuilds the role table with a new plugin-permission set, preserving the
  // object identity that plugin factories captured. The plugin manager calls
  // this AFTER the load loop to finalize the permission model from only the
  // plugins that survived: a user plugin that failed to load must not leave
  // its declared permissions or owner-wildcard exclusions in the live service.
  // Optional so the many partial test stubs and the channel-respond stub need
  // not implement it; the real service from createPermissionService always does.
  replacePluginPermissions?(opts: {
    pluginPermissions: readonly string[]
    ownerWildcardExclusions: readonly string[]
  }): void
}

export type UnknownPermissionWarning = {
  role: string
  permission: string
  hint: string
}

export const noopPermissionService: PermissionService = {
  has: () => false,
  resolveRole: () => 'guest',
  compareRoleSeverity: () => undefined,
  permissionsForRole: () => undefined,
  describe: () => ({ role: 'guest', permissions: [] }),
  replaceRoles: () => {},
  replacePluginPermissions: () => {},
}

type ResolvedRole = {
  name: string
  match: readonly MatchRule[]
  permissions: readonly string[]
}

export type CreatePermissionServiceOptions = {
  roles?: RolesConfig
  pluginPermissions?: readonly string[]
  // Permission strings that the owner wildcard sentinel must NOT
  // auto-expand to. Today populated from the bundled security plugin's
  // high-tier list so audience-leak guards do not get auto-granted to
  // owner. Generic by design — any future plugin could contribute
  // exclusions through the plugin manager. See expandOwnerWildcard.
  ownerWildcardExclusions?: readonly string[]
}

// Returns warnings for user-declared `permissions[]` strings that aren't
// in the known universe (core permissions ∪ plugin-declared). Non-fatal;
// the runtime still resolves the role with the unknown string in its
// permission list -- `has()` checks for that exact string and would return
// true if someone happened to check for it. The warning surfaces typos
// like `security.bypass.secretExfilBach` before they silently fail to
// gate the corresponding guard.
export function findUnknownPermissions(
  roles: RolesConfig | undefined,
  pluginPermissions: readonly string[],
): UnknownPermissionWarning[] {
  if (!roles) return []
  const known = new Set<string>([...Object.values(CORE_PERMISSIONS), ...pluginPermissions])
  const out: UnknownPermissionWarning[] = []
  for (const [role, config] of Object.entries(roles)) {
    if (config.permissions === undefined) continue
    for (const perm of config.permissions) {
      if (!known.has(perm)) {
        out.push({ role, permission: perm, hint: closestPermission(perm, known) })
      }
    }
  }
  return out
}

// The mirror of findUnknownPermissions. `definePlugin({ permissions })`
// registers a string but grants nothing, so a plugin gating a surface on a
// fresh id without a matching `roles.<role>.permissions[]` entry is denied
// for EVERY caller including owner -- previously with no signal until the
// block fired at call time. Non-fatal: withholding a capability is a valid
// operator choice.
//
// Resolves the role table rather than reading raw config because
// expandOwnerWildcard auto-flows a plugin's `security.bypass.*` strings to
// owner; reading config would report every one of them as ungranted.
export function findUngrantedPluginPermissions(
  roles: RolesConfig | undefined,
  pluginPermissions: readonly string[],
  ownerWildcardExclusions: readonly string[] = [],
): string[] {
  if (pluginPermissions.length === 0) return []
  const granted = new Set<string>()
  for (const role of buildRoleTable(roles ?? {}, pluginPermissions, ownerWildcardExclusions)) {
    for (const permission of role.permissions) granted.add(permission)
  }
  return pluginPermissions.filter((permission) => !granted.has(permission))
}

function closestPermission(target: string, known: ReadonlySet<string>): string {
  let best: { name: string; distance: number } | null = null
  for (const name of known) {
    const d = levenshtein(target, name)
    if (best === null || d < best.distance) best = { name, distance: d }
  }
  if (best === null || best.distance > Math.max(3, Math.floor(target.length * 0.25))) {
    return 'no close match in known permissions; check spelling'
  }
  return `did you mean '${best.name}'?`
}

function levenshtein(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  const prev = new Array<number>(lb + 1)
  const curr = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j]!
  }
  return prev[lb]!
}

// Cap on the memoized role-resolution cache. Channel keys derive from
// externally-controlled coordinates, so the cache must be bounded — see the
// roleCache comment in createPermissionService.
export const ROLE_CACHE_MAX = 4096

export type BoundedCache<V> = {
  get(key: string): V | undefined
  set(key: string, value: V): void
  clear(): void
  readonly size: number
}

// Insertion-ordered cache with a hard capacity. On overflow it evicts the
// oldest inserted entry (JS Map preserves insertion order), so size never
// exceeds `max`. Extracted as a standalone factory so the bound is unit-testable
// in isolation — the in-service cache is otherwise unobservable.
export function createBoundedCache<V>(max: number): BoundedCache<V> {
  const store = new Map<string, V>()
  return {
    get: (key) => store.get(key),
    set(key, value) {
      if (!store.has(key) && store.size >= max) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      store.set(key, value)
    },
    clear: () => store.clear(),
    get size() {
      return store.size
    },
  }
}

export function createPermissionService(opts: CreatePermissionServiceOptions = {}): PermissionService {
  let pluginPermissions = opts.pluginPermissions ?? []
  let ownerWildcardExclusions = opts.ownerWildcardExclusions ?? []
  let lastRoles = opts.roles ?? {}
  let resolved = buildRoleTable(lastRoles, pluginPermissions, ownerWildcardExclusions)
  let byName = new Map(resolved.map((r) => [r.name, r]))

  // resolveRole is called several times per tool invocation (the bash sandbox
  // alone resolves it up to 6x through resolveHiddenPaths) and once per channel
  // admission, and each call re-scans the whole role table via matchesOrigin.
  // The result is a pure function of (role table, resolved origin fields), so
  // memoize it. The cache holds only the CURRENT role table's verdicts; both
  // role-table rebuilds (replaceRoles / replacePluginPermissions) drop it, so a
  // stale entry can never survive a config change and hand back a now-wrong
  // (e.g. over-privileged) role. See roleCacheKey for exactly which fields the
  // key covers — it must stay a superset of what computeRole reads.
  //
  // Bounded because channel cache keys derive from externally-controlled
  // coordinates (workspace/chat/author): a stream of distinct GitHub issue or
  // chat ids — even denied traffic that resolves to guest — would otherwise
  // grow the map without limit until the next role-table rebuild. See
  // createBoundedCache for the eviction policy.
  const roleCache = createBoundedCache<string | null>(ROLE_CACHE_MAX)

  function computeRole(origin: SessionOrigin): string | null {
    // Runtime-owned infrastructure (memory, backup) acts on the operator's
    // behalf over operator-owned state. It is constructed only by runtime/
    // bundled code — inbound channel/cron content cannot produce this kind —
    // so resolving it to owner is not a laundering vector. See the `system`
    // origin doc in session-origin.ts.
    if (origin.kind === 'system') return 'owner'

    if (origin.kind === 'cron') {
      const role = origin.scheduledByRole
      if (role !== undefined && byName.has(role)) return role
      return 'guest'
    }
    if (origin.kind === 'subagent') {
      const role = origin.spawnedByRole
      if (role !== undefined && byName.has(role)) return role
      return 'guest'
    }

    const matchable = toMatchable(origin)
    if (matchable === null) return null

    for (const role of resolved) {
      for (const rule of role.match) {
        if (matchesOrigin(rule, matchable)) return role.name
      }
    }
    return null
  }

  function resolveRole(origin: SessionOrigin | undefined): string
  function resolveRole(origin: SessionOrigin | undefined, options: { requireMatch: true }): string | undefined
  function resolveRole(origin: SessionOrigin | undefined, options?: { requireMatch: true }): string | undefined {
    const fallback = options?.requireMatch ? undefined : 'guest'
    if (origin === undefined) return fallback
    const key = roleCacheKey(origin)
    if (key === null) return computeRole(origin) ?? fallback
    const cached = roleCache.get(key)
    if (cached !== undefined) return cached ?? fallback
    const role = computeRole(origin)
    roleCache.set(key, role)
    return role ?? fallback
  }

  function invalidateRoleCache(): void {
    roleCache.clear()
  }

  function roleSeverity(name: string): number | undefined {
    if (name === 'owner') return 4
    if (name === 'trusted') return 3
    if (name === 'member') return 1
    if (name === 'guest') return 0
    if (byName.has(name)) return 2
    return undefined
  }

  return {
    has(origin, permission) {
      // Fail-safe floor: an undefined origin holds nothing, regardless of
      // role permissions. Previously this floor was implicit in `guest`
      // being empty; now `guest` is grantable (an operator may grant it
      // `channel.respond`), so the floor must live on the no-actor input
      // instead. Keeps every downstream `has(maybeUndefined, ...)` check
      // (bypass tiers, fs.see.*, subagent spawn) closed even after a guest
      // grant. resolveRole/describe still report 'guest' for audit/display;
      // only authorization is forced closed.
      if (origin === undefined) return false
      const roleName = resolveRole(origin)
      const role = byName.get(roleName)
      if (!role) return false
      return role.permissions.includes(permission)
    },
    resolveRole,
    compareRoleSeverity(a, b) {
      const aRank = roleSeverity(a)
      const bRank = roleSeverity(b)
      if (aRank === undefined || bRank === undefined) return undefined
      if (aRank < bRank) return -1
      if (aRank > bRank) return 1
      return 0
    },
    permissionsForRole(role) {
      return byName.get(role)?.permissions
    },
    describe(origin) {
      const name = resolveRole(origin)
      const role = byName.get(name)
      return { role: name, permissions: role?.permissions ?? [] }
    },
    replaceRoles(roles) {
      lastRoles = roles ?? {}
      resolved = buildRoleTable(lastRoles, pluginPermissions, ownerWildcardExclusions)
      byName = new Map(resolved.map((r) => [r.name, r]))
      invalidateRoleCache()
    },
    replacePluginPermissions(next) {
      pluginPermissions = next.pluginPermissions
      ownerWildcardExclusions = next.ownerWildcardExclusions
      resolved = buildRoleTable(lastRoles, pluginPermissions, ownerWildcardExclusions)
      byName = new Map(resolved.map((r) => [r.name, r]))
      invalidateRoleCache()
    },
  }
}

// Walk order: owner, trusted, custom roles (in REVERSE declaration order),
// member, guest. First role whose `match[]` covers the origin wins.
//
// Built-in tower: owner > trusted > member > guest. Pinning the tower
// ahead of any user-declared rule closes a load-bearing footgun in the
// previous pure-declaration-order resolver: declaring
// `member.match: ["*"]` before `owner.match: [...]` resolved every
// channel session — INCLUDING the owner's — to `member`, because the
// wildcard matched first. The rolePromotion guard then made it
// un-fixable from inside the demoted session (a member-resolved speaker
// cannot rewrite `roles` without a TUI-issued ack).
//
// Custom roles use REVERSE declaration order: later declarations override
// earlier ones. This matches the standard "later config wins" mental
// model — when an operator adds a new role with the same match-scope as
// an existing one (or appends a new author-pinned override to an existing
// broad rule), the newer entry takes precedence. The previous "earlier
// wins" was an arbitrary consequence of map iteration order rather than
// a deliberate semantic.
//
// Custom roles cannot self-promote above trusted (no inherent severity
// guarantee) and cannot demote themselves below member (declaring a custom
// role implies the operator wants it to win against bottom catch-alls).
function buildRoleTable(
  roles: RolesConfig,
  pluginPermissions: readonly string[],
  ownerWildcardExclusions: readonly string[],
): ResolvedRole[] {
  const out: ResolvedRole[] = []
  const seen = new Set<string>()

  const emit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push(resolveOne(name, roles[name], pluginPermissions, ownerWildcardExclusions))
  }

  emit('owner')
  emit('trusted')
  const customRoles = Object.keys(roles).filter((name) => !isBuiltinRoleName(name))
  for (let i = customRoles.length - 1; i >= 0; i--) {
    emit(customRoles[i]!)
  }
  emit('member')
  emit('guest')

  return out
}

function resolveOne(
  name: string,
  user: RoleConfig | undefined,
  pluginPermissions: readonly string[],
  ownerWildcardExclusions: readonly string[],
): ResolvedRole {
  if (isBuiltinRoleName(name)) {
    const builtin = BUILTIN_ROLES[name]
    const match = [...builtin.match, ...(user?.match ?? [])]
    const rawPerms = user?.permissions !== undefined ? user.permissions : [...builtin.permissions]
    const permissions =
      name === 'owner' ? expandOwnerWildcard(rawPerms, pluginPermissions, ownerWildcardExclusions) : rawPerms
    return { name, match, permissions }
  }
  return {
    name,
    match: user?.match ?? [],
    permissions: user?.permissions ?? [],
  }
}

// Cache key for the memoized role resolution. It MUST enumerate exactly the
// origin fields that computeRole/matchesOrigin consult, and NOTHING that varies
// turn-to-turn without changing the verdict (participants, membership, thread,
// reactionRef, *Name display fields). Returning null opts an origin OUT of the
// cache — used for kinds where the answer is already O(1) (system/cron/subagent,
// which read only a role string off the origin) so there is no scan to save and
// no reason to risk an under-specified key. tui and channel are the scan-heavy
// kinds worth caching:
//   - tui: verdict depends only on kind (matchesOrigin's tui rule ignores
//     sessionId), so every tui origin shares one entry.
//   - channel: verdict depends on adapter + workspace + chat + parentChat + lastInboundAuthorId
//     (the exact inputs matchesChannel/matchesBucket/matchesAuthor read).
// The `c` prefix + NUL separators keep channel keys unambiguous even if a field
// contained the delimiter of another.
function roleCacheKey(origin: SessionOrigin): string | null {
  switch (origin.kind) {
    case 'tui':
      return 'tui'
    case 'channel':
      return [
        'c',
        origin.adapter,
        origin.workspace,
        origin.chat,
        origin.parentChat ?? '',
        origin.lastInboundAuthorId ?? '',
        origin.lastInboundAuthorAdapter ?? origin.adapter,
      ].join('\u0000')
    default:
      return null
  }
}

function toMatchable(origin: SessionOrigin): Parameters<typeof matchesOrigin>[1] | null {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui', sessionId: origin.sessionId }
    case 'channel':
      return {
        kind: 'channel',
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        ...(origin.parentChat !== undefined ? { parentChat: origin.parentChat } : {}),
        ...(origin.lastInboundAuthorId !== undefined ? { lastInboundAuthorId: origin.lastInboundAuthorId } : {}),
        ...(origin.lastInboundAuthorAdapter !== undefined
          ? { lastInboundAuthorAdapter: origin.lastInboundAuthorAdapter }
          : {}),
      }
    default:
      return null
  }
}
