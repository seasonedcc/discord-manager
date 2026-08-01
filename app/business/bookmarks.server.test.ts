import { randomUUID } from 'node:crypto'
import {
  InputError,
  fromSuccess,
  isContextError,
  isInputError,
} from 'composable-functions'
import { inboxBookmarkReasonId } from '~/business/bookmarks.common'
import {
  addBookmarkByLink,
  addBookmarkReason,
  editBookmarkReason,
  listBookmarkReasons,
  listBookmarks,
  resolveBookmark,
  retireBookmarkReason,
  setBookmarkReason,
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

async function createReason(
  context: Awaited<ReturnType<typeof ownerContext>>,
  attributes: { name?: string; description?: string } = {}
) {
  const { reason } = await fromSuccess(addBookmarkReason)(
    {
      name: attributes.name ?? `reason-${randomUUID()}`,
      description: attributes.description ?? `description-${randomUUID()}`,
    },
    context
  )

  return reason
}

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
        reasonId: inboxBookmarkReasonId,
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

  it('leaves an already bookmarked message bookmarked and applies the reason it was given', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      source: 'reaction',
      bookmarkedAt: '2099-01-01T00:00:00.000Z',
    })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
        reasonId: reason.reasonId,
      },
      context
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.source).toBe('reaction')
    expect(bookmark.bookmarkedAt).toBe('2099-01-01T00:00:00.000Z')
    expect(bookmark.reasonId).toBe(reason.reasonId)
    expect(additions).toHaveLength(1)
  })

  it('records the reason alongside the addition', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
        reasonId: reason.reasonId,
      },
      context
    )

    const assignments = await db()
      .selectFrom('bookmarkReasonAssignments')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.reasonId).toBe(reason.reasonId)
    expect(bookmark.reasonName).toBe(reason.name)
    expect(assignments).toHaveLength(1)
    expect(assignments[0].reasonId).toBe(reason.reasonId)
  })

  it('fails without recording anything when the reason is unknown', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await addBookmarkByLink(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
        reasonId: newId(),
      },
      await ownerContext({ guildId: guild.id })
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No bookmark reason with that id exists. List your bookmark reasons to pick one.'
    )
    expect(additions).toHaveLength(0)
  })

  it('fails without recording anything when the reason is retired', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const result = await addBookmarkByLink(
      {
        messageLink: messageLink({
          discordGuildId: guild.discordGuildId,
          discordChannelId: channel.discordChannelId,
          discordMessageId: message.discordMessageId,
        }),
        reasonId: reason.reasonId,
      },
      context
    )

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That bookmark reason is retired, so nothing new can be given it. Pick an active reason, or add one.'
    )
    expect(additions).toHaveLength(0)
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
        reasonId: inboxBookmarkReasonId,
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

  it('bookmarks a link copied from the canary client', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: `https://canary.discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
        reasonId: inboxBookmarkReasonId,
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmark.messageId).toBe(message.id)
  })

  it('bookmarks a link copied from the old discordapp.com host', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const { bookmark } = await fromSuccess(addBookmarkByLink)(
      {
        messageLink: `https://discordapp.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
        reasonId: inboxBookmarkReasonId,
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmark.messageId).toBe(message.id)
  })

  it('rejects anything that is not a Discord message link', async () => {
    const guild = await createGuild()

    const result = await addBookmarkByLink(
      {
        messageLink: 'https://example.com/channels/1/2/3',
        reasonId: inboxBookmarkReasonId,
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That is not a Discord message link. Right-click the message in Discord, choose Copy Message Link, and pass that — it looks like https://discord.com/channels/<server>/<channel>/<message>.'
    )
  })

  it('tells a link with the right shape but the wrong ids apart', async () => {
    const guild = await createGuild()

    const result = await addBookmarkByLink(
      {
        messageLink: 'https://discord.com/channels/guild/channel/message',
        reasonId: inboxBookmarkReasonId,
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message link carries something other than Discord ids. Copy it again from Discord without editing the numbers.'
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
        reasonId: inboxBookmarkReasonId,
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That link points at a different Discord server than this deployment manages. Pick a message from the server this deployment manages.'
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
        reasonId: inboxBookmarkReasonId,
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
        reasonId: inboxBookmarkReasonId,
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
      'No message with that id has been ingested. List your bookmarks or catch up to pick one.'
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
    expect(result.errors[0].message).toBe(
      'That snooze time has already passed. Pick a moment in the future, such as tomorrow morning.'
    )
  })

  it('fails when the message was never bookmarked', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await snoozeBookmark(
      { messageId: message.id, until: '2099-12-31T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    const snoozes = await db()
      .selectFrom('bookmarkSnoozes')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to snooze'
    )
    expect(snoozes).toHaveLength(0)
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

    const result = await snoozeBookmark(
      { messageId: message.id, until: '2099-12-31T00:00:00.000Z' },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to snooze'
    )
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
      'No message with that id has been ingested. List your bookmarks or catch up to pick one.'
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
        reasonId: inboxBookmarkReasonId,
        reasonName: 'Inbox',
        snoozedUntil: null,
        attachments: [],
        embeds: [],
        deletedUpstream: false,
        jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
      },
    ])
  })

  it('reads what a bookmarked alert says in its embeds and attachments', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      attachments: [
        {
          filename: 'runbook.md',
          size: 3120,
          url: 'https://cdn.example.test/runbook.md',
        },
      ],
      channelId: channel.id,
      content: '',
      embeds: ['Deploy blocked\nThe migration has not finished'],
    })

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )
    const bookmarked = bookmarks.find(
      ({ messageId }) => messageId === message.id
    )

    expect(bookmarked?.embeds).toEqual([
      'Deploy blocked\nThe migration has not finished',
    ])
    expect(bookmarked?.attachments).toEqual([
      {
        filename: 'runbook.md',
        size: 3120,
        url: 'https://cdn.example.test/runbook.md',
      },
    ])
  })

  it('reads the embeds of the newest revision only', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      content: 'the first wording',
      embeds: ['A preview nobody kept'],
    })

    const newerRevision = await db()
      .insertInto('messageRevisions')
      .values({
        content: 'the wording that stuck',
        id: newId(),
        messageId: message.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db()
      .insertInto('messageRevisionEmbeds')
      .values({
        content: 'The preview that replaced it',
        id: newId(),
        messageRevisionId: newerRevision.id,
        position: 0,
      })
      .execute()

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )
    const bookmarked = bookmarks.find(
      ({ messageId }) => messageId === message.id
    )

    expect(bookmarked?.embeds).toEqual(['The preview that replaced it'])
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

  it('brings back at most the asked-for number and says it was truncated', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-03-01T00:00:00.000Z',
    })
    const newer = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2099-03-02T00:00:00.000Z',
    })
    const context = await ownerContext({ guildId: guild.id })

    const capped = await fromSuccess(listBookmarks)({ limit: 1 }, context)
    const whole = await fromSuccess(listBookmarks)({}, context)

    expect(capped.bookmarks.map(({ messageId }) => messageId)).toEqual([
      newer.id,
    ])
    expect(capped.truncated).toBe(true)
    expect(whole.bookmarks).toHaveLength(2)
    expect(whole.truncated).toBe(false)
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

  it('reads a bookmark that was never sorted as Inbox', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const { bookmarks } = await fromSuccess(listBookmarks)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(bookmarks.map(({ messageId }) => messageId)).toEqual([message.id])
    expect(bookmarks[0].reasonId).toBe(inboxBookmarkReasonId)
    expect(bookmarks[0].reasonName).toBe('Inbox')
  })

  it('reads the reason the newest assignment gave a bookmark', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const first = await createReason(context)
    const second = await createReason(context)

    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: first.reasonId },
      context
    )
    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: second.reasonId },
      context
    )

    const { bookmarks } = await fromSuccess(listBookmarks)({}, context)

    expect(bookmarks[0].reasonId).toBe(second.reasonId)
    expect(bookmarks[0].reasonName).toBe(second.name)
  })

  it('keeps showing the last known name of a retired reason', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )
    await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const { bookmarks } = await fromSuccess(listBookmarks)({}, context)
    const filtered = await fromSuccess(listBookmarks)(
      { reasonId: reason.reasonId },
      context
    )

    expect(bookmarks[0].reasonName).toBe(reason.name)
    expect(filtered.bookmarks.map(({ messageId }) => messageId)).toEqual([
      message.id,
    ])
  })

  it('shows the new name on a bookmark carrying a renamed reason', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)
    const renamed = `renamed-${randomUUID()}`

    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )
    await fromSuccess(editBookmarkReason)(
      {
        reasonId: reason.reasonId,
        name: renamed,
        description: 'What it means now.',
      },
      context
    )

    const { bookmarks } = await fromSuccess(listBookmarks)({}, context)

    expect(bookmarks[0].reasonName).toBe(renamed)
  })

  it('brings back only the bookmarks carrying the asked-for reason', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const sorted = await createBookmarkedMessage({ channelId: channel.id })
    const unsorted = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(setBookmarkReason)(
      { messageId: sorted.id, reasonId: reason.reasonId },
      context
    )

    const chosen = await fromSuccess(listBookmarks)(
      { reasonId: reason.reasonId },
      context
    )
    const inbox = await fromSuccess(listBookmarks)(
      { reasonId: inboxBookmarkReasonId },
      context
    )

    expect(chosen.bookmarks.map(({ messageId }) => messageId)).toEqual([
      sorted.id,
    ])
    expect(inbox.bookmarks.map(({ messageId }) => messageId)).toEqual([
      unsorted.id,
    ])
  })

  it('fails when the reason filter names no known reason', async () => {
    const guild = await createGuild()

    const result = await listBookmarks(
      { reasonId: newId() },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No bookmark reason with that id exists. List your bookmark reasons to pick one.'
    )
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

describe('addBookmarkReason', () => {
  it('records the reason and its first detail revision together', async () => {
    const context = await ownerContext()
    const name = `reason-${randomUUID()}`

    const { reason } = await fromSuccess(addBookmarkReason)(
      { name, description: 'When a message needs a second pair of eyes.' },
      context
    )

    const revisions = await db()
      .selectFrom('bookmarkReasonDetailRevisions')
      .selectAll()
      .where('reasonId', '=', reason.reasonId)
      .execute()

    expect(reason.name).toBe(name)
    expect(reason.description).toBe(
      'When a message needs a second pair of eyes.'
    )
    expect(revisions).toHaveLength(1)
    expect(revisions[0].name).toBe(name)
  })

  it('fails when an active reason already carries that name, whatever the casing', async () => {
    const context = await ownerContext()
    const name = `Reason-${randomUUID()}`

    await fromSuccess(addBookmarkReason)(
      { name, description: 'The first one.' },
      context
    )

    const result = await addBookmarkReason(
      { name: name.toUpperCase(), description: 'The second one.' },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')

    const [error] = result.errors

    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }

    expect(error.message).toBe(
      `An active bookmark reason is already called "${name}". Pick another name, or edit that reason.`
    )
    expect(error.path).toEqual(['name'])
  })

  it('frees the name of a reason once it is retired', async () => {
    const context = await ownerContext()
    const name = `reason-${randomUUID()}`
    const first = await createReason(context, { name })

    await fromSuccess(retireBookmarkReason)(
      { reasonId: first.reasonId },
      context
    )

    const { reason } = await fromSuccess(addBookmarkReason)(
      { name, description: 'Taking the name over.' },
      context
    )

    expect(reason.name).toBe(name)
    expect(reason.reasonId).not.toBe(first.reasonId)
  })
})

describe('editBookmarkReason', () => {
  it('records a new full snapshot of the name and description', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)
    const renamed = `renamed-${randomUUID()}`

    const edited = await fromSuccess(editBookmarkReason)(
      {
        reasonId: reason.reasonId,
        name: renamed,
        description: 'What it means now.',
      },
      context
    )

    const revisions = await db()
      .selectFrom('bookmarkReasonDetailRevisions')
      .selectAll()
      .where('reasonId', '=', reason.reasonId)
      .execute()

    expect(edited.reason.name).toBe(renamed)
    expect(edited.reason.description).toBe('What it means now.')
    expect(revisions).toHaveLength(2)
  })

  it('fails when no reason carries that id', async () => {
    const context = await ownerContext()

    const result = await editBookmarkReason(
      { reasonId: newId(), name: 'Anything', description: 'Anything at all.' },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No bookmark reason with that id exists. List your bookmark reasons to pick one.'
    )
  })

  it('fails when the reason is retired', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)

    await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const result = await editBookmarkReason(
      {
        reasonId: reason.reasonId,
        name: `renamed-${randomUUID()}`,
        description: 'Anything at all.',
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That bookmark reason is retired, so there is nothing to edit. Add a new reason instead.'
    )
  })

  it('fails when asked to reword Inbox', async () => {
    const context = await ownerContext()

    const result = await editBookmarkReason(
      {
        reasonId: inboxBookmarkReasonId,
        name: 'Unsorted',
        description: 'Anything at all.',
      },
      context
    )

    const revisions = await db()
      .selectFrom('bookmarkReasonDetailRevisions')
      .selectAll()
      .where('reasonId', '=', inboxBookmarkReasonId)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'Inbox is where every unsorted bookmark lands, so its name and description belong to the product. Add a reason of your own instead.'
    )
    expect(revisions).toHaveLength(1)
  })

  it('fails when another active reason already carries that name', async () => {
    const context = await ownerContext()
    const taken = await createReason(context)
    const reason = await createReason(context)

    const result = await editBookmarkReason(
      {
        reasonId: reason.reasonId,
        name: taken.name.toUpperCase(),
        description: 'Anything at all.',
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      `An active bookmark reason is already called "${taken.name}". Pick another name, or edit that reason.`
    )
  })

  it('lets a reason keep its own name while its description changes', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)

    const { reason: edited } = await fromSuccess(editBookmarkReason)(
      {
        reasonId: reason.reasonId,
        name: reason.name,
        description: 'A sharper sentence about when this applies.',
      },
      context
    )

    expect(edited.name).toBe(reason.name)
    expect(edited.description).toBe(
      'A sharper sentence about when this applies.'
    )
  })
})

describe('retireBookmarkReason', () => {
  it('records the retirement that takes a reason out of the active list', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)

    const { reason: retired } = await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const retirements = await db()
      .selectFrom('bookmarkReasonRetirements')
      .selectAll()
      .where('reasonId', '=', reason.reasonId)
      .execute()

    const { reasons } = await fromSuccess(listBookmarkReasons)({}, context)

    expect(retired.reasonId).toBe(reason.reasonId)
    expect(retirements).toHaveLength(1)
    expect(reasons.map(({ reasonId }) => reasonId)).not.toContain(
      reason.reasonId
    )
  })

  it('fails when no reason carries that id', async () => {
    const context = await ownerContext()

    const result = await retireBookmarkReason({ reasonId: newId() }, context)

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No bookmark reason with that id exists. List your bookmark reasons to pick one.'
    )
  })

  it('fails when the reason is already retired', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)

    await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const result = await retireBookmarkReason(
      { reasonId: reason.reasonId },
      context
    )

    const retirements = await db()
      .selectFrom('bookmarkReasonRetirements')
      .selectAll()
      .where('reasonId', '=', reason.reasonId)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That bookmark reason is already retired.'
    )
    expect(retirements).toHaveLength(1)
  })

  it('fails when asked to retire Inbox', async () => {
    const context = await ownerContext()

    const result = await retireBookmarkReason(
      { reasonId: inboxBookmarkReasonId },
      context
    )

    const retirements = await db()
      .selectFrom('bookmarkReasonRetirements')
      .selectAll()
      .where('reasonId', '=', inboxBookmarkReasonId)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'Inbox is where every unsorted bookmark lands, so it cannot be retired. Retire a reason of your own instead.'
    )
    expect(retirements).toHaveLength(0)
  })
})

describe('listBookmarkReasons', () => {
  it('brings back an active reason with its current name and description', async () => {
    const context = await ownerContext()
    const reason = await createReason(context)

    const { reasons } = await fromSuccess(listBookmarkReasons)({}, context)

    expect(reasons).toContainEqual({
      reasonId: reason.reasonId,
      name: reason.name,
      description: reason.description,
      bookmarkCount: 0,
    })
  })

  it('counts the bookmarks currently carrying each reason', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)
    const sorted = await createBookmarkedMessage({ channelId: channel.id })
    await createBookmarkedMessage({ channelId: channel.id })

    await fromSuccess(setBookmarkReason)(
      { messageId: sorted.id, reasonId: reason.reasonId },
      context
    )

    const { reasons } = await fromSuccess(listBookmarkReasons)({}, context)
    const counted = reasons.find(({ reasonId }) => reasonId === reason.reasonId)
    const inbox = reasons.find(
      ({ reasonId }) => reasonId === inboxBookmarkReasonId
    )

    expect(counted?.bookmarkCount).toBe(1)
    expect(inbox?.bookmarkCount).toBe(1)
  })

  it('stops counting a bookmark once it is resolved', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)
    const message = await createBookmarkedMessage({ channelId: channel.id })

    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )
    await fromSuccess(resolveBookmark)({ messageId: message.id }, context)

    const { reasons } = await fromSuccess(listBookmarkReasons)({}, context)

    expect(
      reasons.find(({ reasonId }) => reasonId === reason.reasonId)
        ?.bookmarkCount
    ).toBe(0)
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const context = await ownerContext()

    const result = await listBookmarkReasons(
      {},
      { ...context, canManageBookmarks: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})

describe('setBookmarkReason', () => {
  it('appends the assignment that sorts a bookmark into a reason', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    const { bookmark } = await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    const assignments = await db()
      .selectFrom('bookmarkReasonAssignments')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(bookmark.messageId).toBe(message.id)
    expect(bookmark.reasonId).toBe(reason.reasonId)
    expect(bookmark.reasonName).toBe(reason.name)
    expect(assignments).toHaveLength(1)
    expect(assignments[0].reasonId).toBe(reason.reasonId)
  })

  it('sends a bookmark back to Inbox on purpose', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    const { bookmark } = await fromSuccess(setBookmarkReason)(
      { messageId: message.id, reasonId: inboxBookmarkReasonId },
      context
    )

    const { bookmarks } = await fromSuccess(listBookmarks)({}, context)

    expect(bookmark.reasonName).toBe('Inbox')
    expect(bookmarks[0].reasonId).toBe(inboxBookmarkReasonId)
  })

  it('fails when the message is not bookmarked', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    const result = await setBookmarkReason(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    const assignments = await db()
      .selectFrom('bookmarkReasonAssignments')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to sort'
    )
    expect(assignments).toHaveLength(0)
  })

  it('fails when the bookmark was already resolved', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2020-01-01T00:00:00.000Z',
    })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(resolveBookmark)({ messageId: message.id }, context)

    const result = await setBookmarkReason(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      'That message is not bookmarked, so there is nothing to sort'
    )
  })

  it('fails when no reason carries that id', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })

    const result = await setBookmarkReason(
      { messageId: message.id, reasonId: newId() },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No bookmark reason with that id exists. List your bookmark reasons to pick one.'
    )
  })

  it('fails when the reason is retired', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    await fromSuccess(retireBookmarkReason)(
      { reasonId: reason.reasonId },
      context
    )

    const result = await setBookmarkReason(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    const assignments = await db()
      .selectFrom('bookmarkReasonAssignments')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That bookmark reason is retired, so nothing new can be given it. Pick an active reason, or add one.'
    )
    expect(assignments).toHaveLength(0)
  })

  it('fails when the message belongs to another Discord server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: otherGuild.id })
    const message = await createBookmarkedMessage({ channelId: channel.id })
    const context = await ownerContext({ guildId: guild.id })
    const reason = await createReason(context)

    const result = await setBookmarkReason(
      { messageId: message.id, reasonId: reason.reasonId },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No message with that id has been ingested. List your bookmarks or catch up to pick one.'
    )
  })
})
