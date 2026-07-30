import { applySchema, isContextError } from 'composable-functions'
import { z } from 'zod'
import { ownerContext, ownerContextSchema } from '~/business/auth.server'
import { describe, expect, it } from '~/test/prelude'

describe('ownerContext', () => {
  it('carries the configured owner and every capability', () => {
    const context = ownerContext()

    expect(context.owner.discordUserId).toBe(process.env.DISCORD_OWNER_USER_ID)
    expect(context.owner.guildId).toBe(process.env.DISCORD_GUILD_ID)
    expect(context.canReadMessages).toBe(true)
    expect(context.canManageBookmarks).toBe(true)
    expect(context.canSendMessages).toBe(true)
  })

  it('is accepted by a business function validating ownerContextSchema', async () => {
    const whoami = applySchema(
      z.object({}),
      ownerContextSchema
    )(async (_input, { owner }) => ({ owner }))

    const result = await whoami({}, ownerContext())

    expect(result.success).toBe(true)
  })

  it('rejects a context missing a capability with a ContextError', async () => {
    const whoami = applySchema(
      z.object({}),
      ownerContextSchema
    )(async (_input, { owner }) => ({ owner }))

    const result = await whoami(
      {},
      {
        ...ownerContext(),
        canSendMessages: false,
      }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
