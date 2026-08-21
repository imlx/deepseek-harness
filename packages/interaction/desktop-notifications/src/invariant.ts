/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-desktop-notifications`.
 * @module @deepseek-ai/dsh-desktop-notifications/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-notifications'

/** Cordis companion plugin name. */
export const name = 'desktop-notifications-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package's whole output is a best-effort native
 * notification — a side effect on the OS, outside every authoritative event
 * stream — and it never appends session events, so no event/data relation
 * exists for an independent companion to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
