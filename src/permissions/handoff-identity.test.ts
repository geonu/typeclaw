import { expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { createPermissionService } from './permissions'
import { rolesConfigSchema } from './schema'

const target: SessionOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: 'guild',
  chat: 'support',
  thread: null,
  lastInboundAuthorId: 'alice',
}

test('shared platform accounts resolve the same authenticated author', () => {
  // Given
  const permissions = createPermissionService({
    roles: rolesConfigSchema.parse({ member: { match: ['discord:guild author:alice'] } }),
  })
  // When
  const role = permissions.resolveRole({ ...target, lastInboundAuthorAdapter: 'discord' }, { requireMatch: true })
  // Then
  expect(role).toBe('member')
})

test('foreign authors cannot reuse a target platform author grant or its cached role', () => {
  // Given
  const permissions = createPermissionService({
    roles: rolesConfigSchema.parse({ owner: { match: ['discord:guild author:alice'] } }),
  })
  expect(permissions.resolveRole(target)).toBe('owner')
  // When
  const origin: SessionOrigin = { ...target, lastInboundAuthorAdapter: 'slack' }
  const role = permissions.resolveRole(origin, { requireMatch: true })
  // Then
  expect(role).toBeUndefined()
  expect(permissions.has(origin, 'channel.respond')).toBe(false)
  expect(permissions.resolveRole(target)).toBe('owner')
})

test('foreign authors can match authorless target rules', () => {
  // Given
  const permissions = createPermissionService({
    roles: rolesConfigSchema.parse({
      owner: { match: ['discord:guild author:alice'] },
      member: { match: ['discord:guild/support'] },
    }),
  })
  // When
  const role = permissions.resolveRole({ ...target, lastInboundAuthorAdapter: 'slack' }, { requireMatch: true })
  // Then
  expect(role).toBe('member')
})

test('an unmatched fallback guest differs from an explicitly matched guest', () => {
  // Given
  const permissions = createPermissionService({
    roles: rolesConfigSchema.parse({ guest: { permissions: ['channel.respond'] } }),
  })
  expect(permissions.resolveRole(target)).toBe('guest')
  expect(permissions.resolveRole(target, { requireMatch: true })).toBeUndefined()
  // When
  permissions.replaceRoles(rolesConfigSchema.parse({ guest: { match: ['discord:guild'] } }))
  // Then
  expect(permissions.resolveRole(target, { requireMatch: true })).toBe('guest')
})
