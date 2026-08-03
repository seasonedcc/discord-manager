import {
  InputError,
  fromSuccess,
  isContextError,
  isInputError,
} from 'composable-functions'
import { readActivitySince } from '~/business/activity.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createBookmarkedMessage,
  createChannel,
  createGatewayIdentification,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { afterEach, describe, expect, it, vi } from '~/test/prelude'

describe('readActivitySince', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts only the messages the store recorded strictly after the cutoff', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      recordedAt: '2100-01-01T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      recordedAt: '2100-01-02T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      recordedAt: '2100-01-03T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-01-02T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(activity.messages).toEqual({
      count: 1,
      newestAt: '2100-01-03T00:00:00.000Z',
    })
  })

  it('counts a message Discord stamped long ago that the store only recorded now', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> this thread never got an answer`,
      discordCreatedAt: '2019-03-04T09:00:00.000Z',
      recordedAt: '2100-01-20T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-01-19T00:00:00.000Z' },
      context
    )

    expect(activity.messages).toEqual({
      count: 1,
      newestAt: '2100-01-20T00:00:00.000Z',
    })
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: '2100-01-20T00:00:00.000Z',
    })
  })

  it('leaves a deleted message out of both the message and the mention counts', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      recordedAt: '2100-02-01T00:00:00.000Z',
    })
    const deleted = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      recordedAt: '2100-02-02T00:00:00.000Z',
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
      newestAt: '2100-02-01T00:00:00.000Z',
    })
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('counts a ping Discord recorded on the latest revision', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: 'reading it now — comments before lunch',
      recordedAt: '2100-03-01T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })
    await createMessage({
      channelId: channel.id,
      content: 'comments are in, nothing blocking',
      recordedAt: '2100-03-02T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-02-28T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(2)
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: '2100-03-01T00:00:00.000Z',
    })
  })

  it('counts a ping written into the message text and ignores one aimed at somebody else', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: `heads up <@${context.owner.discordUserId}> please review`,
      recordedAt: '2100-04-01T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      content: `thanks <@!${context.owner.discordUserId}>`,
      recordedAt: '2100-04-02T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      content: `hello <@${snowflake()}> somebody else`,
      recordedAt: '2100-04-03T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-03-31T00:00:00.000Z' },
      context
    )

    expect(activity.mentions).toEqual({
      count: 2,
      newestAt: '2100-04-02T00:00:00.000Z',
    })
  })

  it('forgets a ping that survives only in a superseded revision', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      recordedAt: '2100-05-01T00:00:00.000Z',
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

  it('forgets a ping the edit written in the same instant took away', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      recordedAt: '2100-05-11T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })
    const written = await db()
      .selectFrom('messageRevisions')
      .select('createdAt')
      .where('messageId', '=', message.id)
      .executeTakeFirstOrThrow()

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'never mind, sorted it myself',
        createdAt: written.createdAt,
      })
      .execute()

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-05-10T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(1)
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('counts a reply that pinged the bot the owner sends through', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const bot = await createGatewayIdentification({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: 'that worked, thank you',
      recordedAt: '2100-05-21T00:00:00.000Z',
      mentionedDiscordUserIds: [bot.botDiscordUserId],
    })
    await createMessage({
      channelId: channel.id,
      content: 'unrelated chatter',
      recordedAt: '2100-05-22T00:00:00.000Z',
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-05-20T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(2)
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: '2100-05-21T00:00:00.000Z',
    })
  })

  it('leaves out a message the bot posted naming the bot', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const bot = await createGatewayIdentification({ guildId: guild.id })
    const botMember = await createMember({
      discordUserId: bot.botDiscordUserId,
    })

    await createMessage({
      authorMemberId: botMember.id,
      channelId: channel.id,
      content: `<@${bot.botDiscordUserId}> here is the summary you asked for`,
      recordedAt: '2100-05-31T00:00:00.000Z',
      mentionedDiscordUserIds: [bot.botDiscordUserId],
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-05-30T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(1)
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('leaves out a message the owner posted naming the owner', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const ownerMember = await createMember({
      discordUserId: context.owner.discordUserId,
    })

    await createMessage({
      authorMemberId: ownerMember.id,
      channelId: channel.id,
      content: `noting for myself <@${context.owner.discordUserId}>`,
      recordedAt: '2100-06-11T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-06-10T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(1)
    expect(activity.mentions).toEqual({ count: 0, newestAt: null })
  })

  it('counts the owner alone while no gateway has said which bot it is', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const unidentifiedBot = snowflake()

    await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      recordedAt: '2100-06-21T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      content: `<@${unidentifiedBot}> can you repost that?`,
      recordedAt: '2100-06-22T00:00:00.000Z',
      mentionedDiscordUserIds: [unidentifiedBot],
    })

    const { activity } = await fromSuccess(readActivitySince)(
      { since: '2100-06-20T00:00:00.000Z' },
      context
    )

    expect(activity.messages.count).toBe(2)
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: '2100-06-21T00:00:00.000Z',
    })
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

  it('answers zeros and null instants once the cutoff passes everything the store recorded', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createBookmarkedMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> one last thing`,
      recordedAt: '2100-07-01T00:00:00.000Z',
      bookmarkedAt: '2100-07-01T00:05:00.000Z',
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
      bookmarkAdditions: { count: 1, newestAt: '2100-07-01T00:05:00.000Z' },
    })
  })

  it('answers straight away when the caller asked for no wait', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    vi.useFakeTimers()

    let answered = false
    const answering = fromSuccess(readActivitySince)(
      { since: '2110-01-01T00:00:00.000Z' },
      context
    ).then((answer) => {
      answered = true

      return answer
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(answered).toBe(true)

    const { activity } = await answering

    expect(activity.messages).toEqual({ count: 0, newestAt: null })
  })

  it('holds a waiting answer back until the wait runs out while the store stays quiet', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    vi.useFakeTimers()

    let answered = false
    const answering = fromSuccess(readActivitySince)(
      { since: '2111-01-01T00:00:00.000Z', waitSeconds: 3 },
      context
    ).then((answer) => {
      answered = true

      return answer
    })

    await vi.advanceTimersByTimeAsync(2000)

    expect(answered).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)

    const { activity } = await answering

    expect(answered).toBe(true)
    expect(activity).toEqual({
      messages: { count: 0, newestAt: null },
      mentions: { count: 0, newestAt: null },
      bookmarkAdditions: { count: 0, newestAt: null },
    })
  })

  it('comes back the moment a message lands, without seeing the wait out', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    vi.useFakeTimers()

    let answered = false
    const answering = fromSuccess(readActivitySince)(
      { since: '2112-01-01T00:00:00.000Z', waitSeconds: 55 },
      context
    ).then((answer) => {
      answered = true

      return answer
    })

    await vi.advanceTimersByTimeAsync(2000)

    expect(answered).toBe(false)

    await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> the staging deploy is stuck`,
      recordedAt: '2112-01-02T00:00:00.000Z',
    })
    await vi.advanceTimersByTimeAsync(1000)

    const { activity } = await answering

    expect(answered).toBe(true)
    expect(activity.messages).toEqual({
      count: 1,
      newestAt: '2112-01-02T00:00:00.000Z',
    })
    expect(activity.mentions).toEqual({
      count: 1,
      newestAt: '2112-01-02T00:00:00.000Z',
    })
  })

  it('comes back the moment a bookmark lands, even with no new message behind it', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    vi.useFakeTimers()

    let answered = false
    const answering = fromSuccess(readActivitySince)(
      { since: '2113-01-02T00:00:00.000Z', waitSeconds: 55 },
      context
    ).then((answer) => {
      answered = true

      return answer
    })

    await vi.advanceTimersByTimeAsync(2000)

    expect(answered).toBe(false)

    await createBookmarkedMessage({
      channelId: channel.id,
      recordedAt: '2113-01-01T00:00:00.000Z',
      bookmarkedAt: '2113-01-03T00:00:00.000Z',
    })
    await vi.advanceTimersByTimeAsync(1000)

    const { activity } = await answering

    expect(answered).toBe(true)
    expect(activity.messages).toEqual({ count: 0, newestAt: null })
    expect(activity.bookmarkAdditions).toEqual({
      count: 1,
      newestAt: '2113-01-03T00:00:00.000Z',
    })
  })

  it('refuses a wait outside the one to fifty-five second range', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    for (const waitSeconds of [0, -5, 56]) {
      const result = await readActivitySince(
        { since: '2100-01-01T00:00:00.000Z', waitSeconds },
        context
      )

      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected a failure')

      const [error] = result.errors

      if (!(error instanceof InputError)) {
        throw new Error('expected an input error')
      }

      expect(error.message).toBe('Wait a whole number of seconds, from 1 to 55')
      expect(error.path).toEqual(['waitSeconds'])
    }
  })

  it('refuses a wait that is not a whole number of seconds', async () => {
    const guild = await createGuild()

    const result = await readActivitySince(
      { since: '2100-01-01T00:00:00.000Z', waitSeconds: 1.5 },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')

    const [error] = result.errors

    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }

    expect(error.message).toBe('Wait a whole number of seconds, from 1 to 55')
    expect(error.path).toEqual(['waitSeconds'])
  })

  it('reads only the activity of the Discord server this deployment manages', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const otherChannel = await createChannel({ guildId: otherGuild.id })

    await createBookmarkedMessage({
      channelId: otherChannel.id,
      recordedAt: '2100-08-01T00:00:00.000Z',
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
