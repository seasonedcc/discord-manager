import { fromSuccess, isContextError, isInputError } from 'composable-functions'
import {
  addBookmarkByLink,
  listBookmarks,
  resolveBookmark,
  snoozeBookmark,
} from '~/business/bookmarks.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createBookmarkedMessage,
  createChannel,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

function messageLink({
  discordGuildId,
  discordChannelId,
  discordMessageId,
}: {
  discordGuildId: string
  discordChannelId: string
  discordMessageId: string
}) {
  return `https://discord.com/channels/${discordGuildId}/${discordChannelId}/${discordMessageId}`
}

describe('addBookmarkByLink', () => {
  it('bookmarks the linked message and records the mcp source', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
      },
      await ownerContext({ guildId: guild.id })
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.messageId).toBe(message.id)
    expect(bookmark.source).toBe('mcp')
    expect(additions).toHaveLength(1)
    expect(additions[0].source).toBe('mcp')
  })

  it('leaves an already bookmarked message untouched', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      source: 'reaction',
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
      },
      await ownerContext({ guildId: guild.id })
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.source).toBe('reaction')
    expect(bookmark.bookmarkedAt).toBe('2099-01-01T00:00:00.000Z')
    expect(additions).toHaveLength(1)
  })

  it('bookmarks again after the bookmark was resolved', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })

    await db()
      .insertInto('bookmarkRemovals')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'mcp',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
      },
      await ownerContext({ guildId: guild.id })
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.source).toBe('mcp')
    expect(additions).toHaveLength(2)
  })

  it('rejects anything that is not a Discord message link', async () => {
    const guild = await createGuild()

    const result = await addBookmarkByLink(
      { messageLink: 'https://example.com/channels/1/2/3' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'Use a Discord message link that looks like https://discord.com/channels/<server>/<channel>/<message>'
    )
  })

  it('rejects a link whose ids are not snowflakes', async () => {
    const guild = await createGuild()

    const result = await addBookmarkByLink(
      { messageLink: 'https://discord.com/channels/guild/channel/message' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'Use a Discord message link that looks like https://discord.com/channels/<server>/<channel>/<message>'
    )
  })

  it('rejects a link that points at another Discord server', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await addBookmarkByLink(
      {
        messageLink: messageLink({
          discordGuildId: snowflake(),
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That link points at a different Discord server than this deployment manages'
    )
  })

  it('explains that a message the bot never ingested cannot be bookmarked', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const result = await addBookmarkByLink(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: snowflake(),
        }),
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message has not been ingested yet. Let the bot catch up on that channel, then bookmark it again.'
    )
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })

    const result = await addBookmarkByLink(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
      },
      { ...context, canManageBookmarks: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})

describe('resolveBookmark', () => {
  it('appends a removal event carrying the mcp source', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const { bookmark } = await fromSuccess(resolveBookmark)(
      { messageId: message.id },
      await ownerContext({ guildId: guild.id })
    )

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.messageId).toBe(message.id)
    expect(removals).toHaveLength(1)
    expect(removals[0].source).toBe('mcp')
  })

  it('fails when the message is not bookmarked', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await resolveBookmark(
      { messageId: message.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to resolve'
    )
  })

  it('fails when the bookmark was already resolved', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2020-01-01T00:00:00.000Z',
    })
    const context = await ownerContext({ guildId: guild.id })

    await fromSuccess(resolveBookmark)({ messageId: message.id }, context)
    const result = await resolveBookmark({ messageId: message.id }, context)

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to resolve'
    )
  })

  it('fails when the message belongs to another Discord server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: otherGuild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const result = await resolveBookmark(
      { messageId: message.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message is not in the server this deployment manages'
    )
  })
})

describe('snoozeBookmark', () => {
  it('records the snooze deadline', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const { bookmark } = await fromSuccess(snoozeBookmark)(
      { messageId: message.id, until: '2099-12-31T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    const snoozes = await db()
      .selectFrom('bookmarkSnoozes')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.snoozedUntil).toBe('2099-12-31T00:00:00.000Z')
    expect(snoozes).toHaveLength(1)
    expect(snoozes[0].until).toBe('2099-12-31T00:00:00.000Z')
  })

  it('fails when the deadline is already past', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const result = await snoozeBookmark(
      { messageId: message.id, until: '2020-01-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe('Pick a snooze time in the future')
  })

  it('fails when the message belongs to another Discord server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: otherGuild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const result = await snoozeBookmark(
      { messageId: message.id, until: '2099-12-31T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message is not in the server this deployment manages'
    )
  })
})

describe('listBookmarks', () => {
  it('reads the newest content, author, channel, and jump link', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id, name: 'support' })
    const member = await createMember({ displayName: 'Grace Hopper' })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      authorMemberId: member.id,
      content: 'as first ingested',
      discordCreatedAt: '2099-01-01T00:00:00.000Z',
      source: 'reaction',
      bookmarkedAt: '2099-01-02T00:00:00.000Z',
    })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'after the author edited it',
        createdAt: '2099-01-03T00:00:00.000Z',
      })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks).toEqual([
      {
        messageId: message.id,
        discordMessageId: message.discordMessageId,
        discordCreatedAt: '2099-01-01T00:00:00.000Z',
        channelId: channel.id,
        discordChannelId: channel.discordChannelId,
        channelName: 'support',
        authorDisplayName: 'Grace Hopper',
        content: 'after the author edited it',
        bookmarkedAt: '2099-01-02T00:00:00.000Z',
        source: 'reaction',
        snoozedUntil: null,
        deletedUpstream: false,
        jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
      },
    ])
  })

  it('keeps a message that was deleted upstream and flags it', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: message.id })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([message.id])
    expect(bookmarks[0].deletedUpstream).toBe(true)
  })

  it('drops a bookmark once it is resolved', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })

    await db()
      .insertInto('bookmarkRemovals')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'mcp',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks).toHaveLength(0)
  })

  it('brings a bookmark back when it is added again after a removal', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })

    await db()
      .insertInto('bookmarkRemovals')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'mcp',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    await db()
      .insertInto('bookmarkAdditions')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'reaction',
        createdAt: '2099-01-03T00:00:00.000Z',
      })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([message.id])
    expect(bookmarks[0].bookmarkedAt).toBe('2099-01-03T00:00:00.000Z')
  })

  it('hides a snoozed bookmark until it is asked for', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const awake = await createBookmarkedMessage({ channelId: channel.id })
    const snoozed = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })

    await fromSuccess(snoozeBookmark)(
      { messageId: snoozed.id, until: '2099-12-31T00:00:00.000Z' },
      context
    )

    const withoutSnoozed = await fromSuccess(listBookmarks)({}, context)
    const withSnoozed = await fromSuccess(listBookmarks)(
      { includeSnoozed: true },
      context
    )

    expect(withoutSnoozed.bookmarks.map(({ messageId }) => messageId)).toEqual([
      awake.id,
    ])
    expect(
      withSnoozed.bookmarks.find(({ messageId }) => messageId === snoozed.id)
        ?.snoozedUntil
    ).toBe('2099-12-31T00:00:00.000Z')
  })

  it('shows a bookmark again once its snooze has expired', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    await db()
      .insertInto('bookmarkSnoozes')
      .values({
        id: newId(),
        messageId: message.id,
        until: '2099-12-31T00:00:00.000Z',
        createdAt: '2020-01-01T00:00:00.000Z',
      })
      .execute()

    await db()
      .insertInto('bookmarkSnoozes')
      .values({
        id: newId(),
        messageId: message.id,
        until: '2020-01-02T00:00:00.000Z',
        createdAt: '2020-01-03T00:00:00.000Z',
      })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([message.id])
    expect(bookmarks[0].snoozedUntil).toBe(null)
  })

  it('lists the most recently bookmarked message first', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const older = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })
    const newer = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-01-02T00:00:00.000Z',
    })

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([
      newer.id,
      older.id,
    ])
  })

  it('only lists bookmarks from the configured server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const otherChannel = await createChannel({ guildId: otherGuild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    await createBookmarkedMessage({ channelId: otherChannel.id })

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([message.id])
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await listBookmarks(
      {},
      { ...context, canManageBookmarks: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
