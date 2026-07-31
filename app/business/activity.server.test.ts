import { fromSuccess, isContextError, isInputError } from 'composable-functions'
import { readActivitySince } from '~/business/activity.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createBookmarkedMessage,
  createChannel,
  createGuild,
  createMessage,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

describe('readActivitySince', () => {
  it('counts only the messages that arrived strictly after the cutoff', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2100-01-01T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2100-01-02T00:00:00.000Z',
    })
    const afterTheCutoff = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2100-01-03T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-01-02T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(activity.messages).toEqual({
      count: 1,
      newestAt: afterTheCutoff.discordCreatedAt,
    })
  })

  it('leaves a deleted message out of both the message and the mention counts', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const kept = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2100-02-01T00:00:00.000Z',
    })
    const deleted = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      discordCreatedAt: '2100-02-02T00:00:00.000Z',
    })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: deleted.id })
      .execute()

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-01-31T00:00:00.000Z' },
      context
    )

    expect(activity.messages).toEqual({
      count: 1,
      newestAt: kept.discordCreatedAt,
    })
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('counts a ping Discord recorded on the latest revision', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const pinged = await createMessage({
      channelId: channel.id,
      content: 'reading it now — comments before lunch',
      discordCreatedAt: '2100-03-01T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })
    await createMessage({
      channelId: channel.id,
      content: 'comments are in, nothing blocking',
      discordCreatedAt: '2100-03-02T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-02-28T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(2)
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: pinged.discordCreatedAt,
    })
  })

  it('counts a ping written into the message text and ignores one aimed at somebody else', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: `heads up <@${context.owner.discordUserId}> please review`,
      discordCreatedAt: '2100-04-01T00:00:00.000Z',
    })
    const nicknamed = await createMessage({
      channelId: channel.id,
      content: `thanks <@!${context.owner.discordUserId}>`,
      discordCreatedAt: '2100-04-02T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      content: `hello <@${snowflake()}> somebody else`,
      discordCreatedAt: '2100-04-03T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-03-31T00:00:00.000Z' },
      context
    )

    expect(activity.mentions).toEqual({
      count: 2,
      newestAt: nicknamed.discordCreatedAt,
    })
  })

  it('forgets a ping that survives only in a superseded revision', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      discordCreatedAt: '2100-05-01T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'never mind, sorted it myself',
        createdAt: '2100-05-02T00:00:00.000Z',
      })
      .execute()

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-04-30T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(1)
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('counts a bookmark addition after the cutoff, even one a later removal undid', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2100-06-02T00:00:00.000Z',
    })
    await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2100-06-03T00:00:00.000Z',
    })
    const undone = await createBookmarkedMessage({
      channelId: channel.id,
      bookmarkedAt: '2100-06-04T00:00:00.000Z',
    })

    await db()
      .insertInto('bookmarkRemovals')
      .values({
        id: newId(),
        messageId: undone.id,
        source: 'mcp',
        createdAt: '2100-06-05T00:00:00.000Z',
      })
      .execute()

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-06-02T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(activity.bookmarkAdditions).toEqual({
      count: 2,
      newestAt: '2100-06-04T00:00:00.000Z',
    })
  })

  it('answers zeros and null instants once the cutoff passes everything that happened', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createBookmarkedMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> one last thing`,
      discordCreatedAt: '2100-07-01T00:00:00.000Z',
      bookmarkedAt: '2100-07-01T00:00:00.000Z',
    })

    const quiet = await fromSuccess(readActivitySince)(
      { since: '2100-07-02T00:00:00.000Z' },
      context
    )
    const busy = await fromSuccess(readActivitySince)(
      { since: '2100-06-30T00:00:00.000Z' },
      context
    )

    expect(quiet.activity).toEqual({
      messages: { count: 0, newestAt: null },
      mentions: { count: 0, newestAt: null },
      bookmarkAdditions: { count: 0, newestAt: null },
    })
    expect(busy.activity).toEqual({
      messages: { count: 1, newestAt: '2100-07-01T00:00:00.000Z' },
      mentions: { count: 1, newestAt: '2100-07-01T00:00:00.000Z' },
      bookmarkAdditions: { count: 1, newestAt: '2100-07-01T00:00:00.000Z' },
    })
  })

  it('reads only the activity of the Discord server this deployment manages', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const otherChannel = await createChannel({ guildId: otherGuild.id })

    await createBookmarkedMessage({
      channelId: otherChannel.id,
      discordCreatedAt: '2100-08-01T00:00:00.000Z',
      bookmarkedAt: '2100-08-01T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-07-31T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(activity).toEqual({
      messages: { count: 0, newestAt: null },
      mentions: { count: 0, newestAt: null },
      bookmarkAdditions: { count: 0, newestAt: null },
    })
  })

  it('refuses a since that is not an ISO-8601 instant', async () => {
    const guild = await createGuild()

    const result = await readActivitySince(
      { since: 'yesterday' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await readActivitySince(
      { since: '2100-01-01T00:00:00.000Z' },
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })

  it('refuses a context that cannot manage bookmarks', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await readActivitySince(
      { since: '2100-01-01T00:00:00.000Z' },
      { ...context, canManageBookmarks: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
