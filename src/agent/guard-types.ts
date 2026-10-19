import type { ToolFileOperands, ToolProvenance } from '@/plugin'

import type { SessionOrigin } from './session-origin'

export type InternalGuardEvent = {
  readonly tool: string
  readonly sessionId: string
  readonly callId: string
  readonly args: Readonly<Record<string, unknown>>
  readonly origin?: SessionOrigin
  readonly toolProvenance?: ToolProvenance
  readonly fileOperands?: ToolFileOperands
}

export type InternalGuardResult =
  | undefined
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'acknowledgement-required'; readonly reason: string }

export type InternalGuard = {
  readonly owner: string
  readonly key: string
  readonly tools: ReadonlySet<string>
  // Hygiene guards that protect no boundary set this so a bug in their check
  // is logged and skipped instead of denying every call to their tools.
  readonly skipOnCheckError?: true
  readonly check: (event: InternalGuardEvent) => InternalGuardResult | Promise<InternalGuardResult>
}
