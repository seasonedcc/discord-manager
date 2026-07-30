import { ownerContext as configuredOwnerContext } from '~/business/auth.server'
import { env } from '~/env.server'
import {
  configuredGuild,
  createGuild,
  createMessage,
  ownerContext,
} from './fixtures'
import { db, describe, expect, it } from './prelude'

describe('configuredGuild', () => {
  it('returns the one guild carrying the configured Discord server id', async () => {
    const first = await configuredGuild()
    const second = await configuredGuild()

    const rows = await db()
      .selectFrom('guilds')
      .selectAll()
      .where('discordGuildId', '=', env().discordGuildId)
      .execute()

    expect(first.discordGuildId).toBe(env().discordGuildId)
    expect(second.id).toBe(first.id)
    expect(rows).toHaveLength(1)
  })
})

describe('ownerContext', () => {
  it('speaks for the configured Discord server by default', async () => {
    const context = await ownerContext()

    expect(context.owner.guildId).toBe(configuredOwnerContext().owner.guildId)
    expect(context.canReadMessages).toBe(true)
    expect(context.canManageBookmarks).toBe(true)
    expect(context.canSendMessages).toBe(true)
  })

  it('speaks for a guild the test built when given one', async () => {
    const guild = await createGuild()

    const context = await ownerContext({ guildId: guild.id })

    expect(context.owner.guildId).toBe(guild.discordGuildId)
  })
})

describe('createMessage', () => {
  it('accepts an explicit Discord message id', async () => {
    const discordMessageId = '109876543210987654'

    const message = await createMessage({ discordMessageId })

    expect(message.discordMessageId).toBe(discordMessageId)
  })

  it('invents an eighteen-digit snowflake when none is given', async () => {
    const message = await createMessage()

    expect(message.discordMessageId).toMatch(/^\d{18}$/)
  })
})
