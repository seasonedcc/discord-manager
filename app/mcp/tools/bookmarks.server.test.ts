import { isContextError } from 'composable-functions'
import { callTool } from '~/mcp/server.server'
import {
  createBookmarkedMessage,
  createChannel,
  createGuild,
  createMessage,
  ownerContext,
} from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

function inADay() {
  return new Date(Date.now() + 24 * 60 * 60_000).toISOString()
}

describe('bookmarks_add', () => {
  it('bookmarks the message a Discord link points at', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_add',
      {
        messageLink: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
      },
      await ownerContext({ guildId: guild.id })
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(isError).toBe(false)
    expect(payload.bookmark).toMatchObject({
      messageId: message.id,
      source: 'mcp',
    })
    expect(additions).toHaveLength(1)
    expect(additions[0].source).toBe('mcp')
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_add',
      { messageLink: 'https://discord.com/channels/1/2/3' },
      { ...context, canManageBookmarks: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canManageBookmarks'])
  })
})

describe('bookmarks_list', () => {
  it('reads the bookmarks still waiting on the owner', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_list',
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.bookmarks).toContainEqual(
      expect.objectContaining({ messageId: message.id, source: 'reaction' })
    )
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_list',
      {},
      { ...context, canManageBookmarks: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canManageBookmarks'])
  })
})

describe('bookmarks_resolve', () => {
  it('appends the removal event that clears a bookmark', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_resolve',
      { messageId: message.id },
      await ownerContext({ guildId: guild.id })
    )

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(isError).toBe(false)
    expect(payload.bookmark).toMatchObject({
      messageId: message.id,
      resolvedVia: 'mcp',
    })
    expect(removals).toHaveLength(1)
    expect(removals[0].source).toBe('mcp')
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_resolve',
      { messageId: message.id },
      { ...context, canManageBookmarks: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canManageBookmarks'])
  })
})

describe('bookmarks_snooze', () => {
  it('appends the snooze event that hides a bookmark until later', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const until = inADay()

    const { isError, payload } = await callAsOwner(
      'bookmarks_snooze',
      { messageId: message.id, until },
      await ownerContext({ guildId: guild.id })
    )

    const snoozes = await db()
      .selectFrom('bookmarkSnoozes')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(isError).toBe(false)
    expect(payload.bookmark).toMatchObject({
      messageId: message.id,
      snoozedUntil: until,
    })
    expect(snoozes).toHaveLength(1)
    expect(snoozes[0].until).toBe(until)
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'bookmarks_snooze',
      { messageId: message.id, until: inADay() },
      { ...context, canManageBookmarks: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canManageBookmarks'])
  })
})
