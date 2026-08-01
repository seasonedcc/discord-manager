import { fromSuccess, isContextError, isInputError } from 'composable-functions'
import { digestMessageLimit } from '~/business/digests.common'
import { catchUpSince, listMentions } from '~/business/digests.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createChannel,
  createGuild,
  createMember,
  createMessage,
  createMessageReaction,
  createMessageReactionRemoval,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

describe('catchUpSince', () => {
  it('returns every message at or after the cutoff, oldest first', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-01-01T00:00:00.000Z',
    })
    const atCutoff = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-01-02T00:00:00.000Z',
    })
    const afterCutoff = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-01-03T00:00:00.000Z',
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-01-02T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages.map(({ messageId }) => messageId)).toEqual([
      atCutoff.id,
      afterCutoff.id,
    ])
    expect(digest.truncated).toBe(false)
  })

  it('reads the author, the channel, the newest content, and a jump link', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id, name: 'product' })
    const member = await createMember({ displayName: 'Ada Lovelace' })
    const message = await createMessage({
      channelId: channel.id,
      authorMemberId: member.id,
      content: 'as first ingested',
      discordCreatedAt: '2099-02-01T00:00:00.000Z',
    })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'after the edit',
        createdAt: '2099-02-02T00:00:00.000Z',
      })
      .execute()

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-02-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages).toEqual([
      {
        messageId: message.id,
        discordMessageId: message.discordMessageId,
        discordCreatedAt: '2099-02-01T00:00:00.000Z',
        channelId: channel.id,
        discordChannelId: channel.discordChannelId,
        channelName: 'product',
        authorDisplayName: 'Ada Lovelace',
        content: 'after the edit',
        attachments: [],
        embeds: [],
        jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
        reactions: [],
      },
    ])
  })

  it('reads what an alert message says in its embeds and attachments', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({
      attachments: [
        {
          filename: 'error-budget.png',
          size: 18422,
          url: 'https://cdn.example.test/error-budget.png',
        },
      ],
      channelId: channel.id,
      content: '',
      discordCreatedAt: '2099-06-01T00:00:00.000Z',
      embeds: [
        'Uptime watch\nCheckout is down',
        'Follow-up: the error budget is spent',
      ],
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )
    const alert = digest.messages.find(
      ({ messageId }) => messageId === message.id
    )

    expect(alert?.content).toBe('')
    expect(alert?.embeds).toEqual([
      'Uptime watch\nCheckout is down',
      'Follow-up: the error budget is spent',
    ])
    expect(alert?.attachments).toEqual([
      {
        filename: 'error-budget.png',
        size: 18422,
        url: 'https://cdn.example.test/error-budget.png',
      },
    ])
  })

  it('counts the reactions still standing on a message and flags the owner among them', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-06-05T00:00:00.000Z',
    })

    await createMessageReaction({
      emoji: '👍',
      messageId: message.id,
      reactedAt: '2099-06-05T00:00:01.000Z',
      reactorDiscordUserId: context.owner.discordUserId,
    })
    await createMessageReaction({
      emoji: '👍',
      messageId: message.id,
      reactedAt: '2099-06-05T00:00:02.000Z',
    })
    await createMessageReaction({
      emoji: '🎉',
      messageId: message.id,
      reactedAt: '2099-06-05T00:00:03.000Z',
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-05T00:00:00.000Z' },
      context
    )
    const reacted = digest.messages.find(
      ({ messageId }) => messageId === message.id
    )

    expect(reacted?.reactions).toEqual([
      { emoji: '👍', count: 2, ownerReacted: true },
      { emoji: '🎉', count: 1, ownerReacted: false },
    ])
  })

  it('leaves out a reaction the reactor took back, and counts it again when they react anew', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const undone = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-06-06T00:00:00.000Z',
    })
    const redone = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-06-06T00:00:00.000Z',
    })
    const fickle = snowflake()

    await createMessageReaction({
      emoji: '👀',
      messageId: undone.id,
      reactedAt: '2099-06-06T00:00:01.000Z',
      reactorDiscordUserId: fickle,
    })
    await createMessageReactionRemoval({
      emoji: '👀',
      messageId: undone.id,
      reactedAt: '2099-06-06T00:00:02.000Z',
      reactorDiscordUserId: fickle,
    })

    await createMessageReaction({
      emoji: '👀',
      messageId: redone.id,
      reactedAt: '2099-06-06T00:00:01.000Z',
      reactorDiscordUserId: fickle,
    })
    await createMessageReactionRemoval({
      emoji: '👀',
      messageId: redone.id,
      reactedAt: '2099-06-06T00:00:02.000Z',
      reactorDiscordUserId: fickle,
    })
    await createMessageReaction({
      emoji: '👀',
      messageId: redone.id,
      reactedAt: '2099-06-06T00:00:03.000Z',
      reactorDiscordUserId: fickle,
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-06T00:00:00.000Z' },
      context
    )

    expect(
      digest.messages.find(({ messageId }) => messageId === undone.id)
        ?.reactions
    ).toEqual([])
    expect(
      digest.messages.find(({ messageId }) => messageId === redone.id)
        ?.reactions
    ).toEqual([{ emoji: '👀', count: 1, ownerReacted: false }])
  })

  it('lets the newer of two same-instant reaction events decide whether one stands', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-06-07T00:00:00.000Z',
    })
    const reactor = snowflake()
    const sameInstant = '2099-06-07T00:00:01.000Z'

    await createMessageReactionRemoval({
      emoji: '🚀',
      messageId: message.id,
      reactedAt: sameInstant,
      reactorDiscordUserId: reactor,
    })
    await createMessageReaction({
      emoji: '🚀',
      messageId: message.id,
      reactedAt: sameInstant,
      reactorDiscordUserId: reactor,
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-07T00:00:00.000Z' },
      context
    )

    expect(
      digest.messages.find(({ messageId }) => messageId === message.id)
        ?.reactions
    ).toEqual([{ emoji: '🚀', count: 1, ownerReacted: false }])
  })

  it('reads the embeds of the newest revision only', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: 'the first wording',
      discordCreatedAt: '2099-06-02T00:00:00.000Z',
      embeds: ['A preview nobody kept'],
    })

    const newerRevision = await db()
      .insertInto('messageRevisions')
      .values({
        content: 'the wording that stuck',
        createdAt: '2099-06-03T00:00:00.000Z',
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

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-02T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )
    const edited = digest.messages.find(
      ({ messageId }) => messageId === message.id
    )

    expect(edited?.embeds).toEqual(['The preview that replaced it'])
  })

  it('leaves out messages that were deleted upstream', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const kept = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-03-01T00:00:00.000Z',
    })
    const deleted = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-03-02T00:00:00.000Z',
    })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: deleted.id })
      .execute()

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-03-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages.map(({ messageId }) => messageId)).toEqual([kept.id])
  })

  it('narrows the digest to one channel when asked', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const otherChannel = await createChannel({ guildId: guild.id })
    const wanted = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-04-01T00:00:00.000Z',
    })
    await createMessage({
      channelId: otherChannel.id,
      discordCreatedAt: '2099-04-01T00:00:00.000Z',
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-04-01T00:00:00.000Z', channelId: channel.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages.map(({ messageId }) => messageId)).toEqual([
      wanted.id,
    ])
  })

  it('only reads messages from the configured server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const otherChannel = await createChannel({ guildId: otherGuild.id })
    const wanted = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2099-05-01T00:00:00.000Z',
    })
    await createMessage({
      channelId: otherChannel.id,
      discordCreatedAt: '2099-05-01T00:00:00.000Z',
    })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-05-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages.map(({ messageId }) => messageId)).toEqual([
      wanted.id,
    ])
  })

  it('fails when the requested channel was never ingested', async () => {
    const guild = await createGuild()

    const result = await catchUpSince(
      { since: '2099-01-01T00:00:00.000Z', channelId: newId() },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No channel with that id has been ingested. List the channels to pick one.'
    )
  })

  it('fails when the requested channel belongs to another Discord server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const otherChannel = await createChannel({ guildId: otherGuild.id })

    const result = await catchUpSince(
      { since: '2099-01-01T00:00:00.000Z', channelId: otherChannel.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No channel with that id has been ingested. List the channels to pick one.'
    )
  })

  it('caps the digest and says it was truncated', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const member = await createMember()
    const messageIds = Array.from({ length: digestMessageLimit + 1 }, () =>
      newId()
    )

    await db()
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('messages')
          .values(
            messageIds.map((id, index) => ({
              id,
              channelId: channel.id,
              authorMemberId: member.id,
              discordMessageId: snowflake(),
              discordCreatedAt: `2099-06-01T00:00:${String(index).padStart(2, '0')}.000Z`,
            }))
          )
          .execute()

        await trx
          .insertInto('messageRevisions')
          .values(
            messageIds.map((messageId) => ({
              id: newId(),
              messageId,
              content: 'one of many',
            }))
          )
          .execute()
      })

    const digest = await fromSuccess(catchUpSince)(
      { since: '2099-06-01T00:00:00.000Z' },
      await ownerContext({ guildId: guild.id })
    )

    expect(digest.messages).toHaveLength(digestMessageLimit)
    expect(digest.truncated).toBe(true)
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await catchUpSince(
      { since: '2099-01-01T00:00:00.000Z' },
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})

describe('listMentions', () => {
  it('keeps only the messages that name the owner', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const plainMention = await createMessage({
      channelId: channel.id,
      content: `heads up <@${context.owner.discordUserId}> please review`,
      discordCreatedAt: '2099-07-01T00:00:00.000Z',
    })
    const nicknameMention = await createMessage({
      channelId: channel.id,
      content: `thanks <@!${context.owner.discordUserId}>`,
      discordCreatedAt: '2099-07-02T00:00:00.000Z',
    })
    await createMessage({
      channelId: channel.id,
      content: `hello <@${snowflake()}> somebody else`,
      discordCreatedAt: '2099-07-03T00:00:00.000Z',
    })

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-07-01T00:00:00.000Z' },
      context
    )

    expect(mentions.messages.map(({ messageId }) => messageId)).toEqual([
      plainMention.id,
      nicknameMention.id,
    ])
    expect(mentions.truncated).toBe(false)
  })

  it('keeps a reply Discord says pinged the owner even when its text names nobody', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const replyPing = await createMessage({
      channelId: channel.id,
      content: 'on it — shipping this afternoon',
      discordCreatedAt: '2099-10-01T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-10-01T00:00:00.000Z' },
      context
    )

    expect(mentions.messages.map(({ messageId }) => messageId)).toEqual([
      replyPing.id,
    ])
  })

  it('leaves out a reply whose sender suppressed the ping', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createMessage({
      channelId: channel.id,
      content: 'on it — shipping this afternoon',
      discordCreatedAt: '2099-10-02T00:00:00.000Z',
      mentionedDiscordUserIds: [],
    })

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-10-02T00:00:00.000Z' },
      context
    )

    expect(mentions.messages).toHaveLength(0)
  })

  it('answers once for a message both its mentions and its text name the owner', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const bothWays = await createMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> can you take this?`,
      discordCreatedAt: '2099-10-03T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-10-03T00:00:00.000Z' },
      context
    )

    expect(mentions.messages.map(({ messageId }) => messageId)).toEqual([
      bothWays.id,
    ])
  })

  it('drops a reply Discord says pinged the owner once the message is deleted', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const replyPing = await createMessage({
      channelId: channel.id,
      content: 'on it',
      discordCreatedAt: '2099-10-04T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: replyPing.id })
      .execute()

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-10-04T00:00:00.000Z' },
      context
    )

    expect(mentions.messages).toHaveLength(0)
  })

  it('forgets a ping once an edit took it out of the mention set', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: 'on it — shipping this afternoon',
      discordCreatedAt: '2099-10-05T00:00:00.000Z',
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'never mind, sorted it myself',
        createdAt: '2099-10-06T00:00:00.000Z',
      })
      .execute()

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-10-05T00:00:00.000Z' },
      context
    )

    expect(mentions.messages).toHaveLength(0)
  })

  it('follows the newest revision when an edit adds the mention', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: 'nobody is named here',
      discordCreatedAt: '2099-08-01T00:00:00.000Z',
    })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: `now it says <@${context.owner.discordUserId}>`,
        createdAt: '2099-08-02T00:00:00.000Z',
      })
      .execute()

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-08-01T00:00:00.000Z' },
      context
    )

    expect(mentions.messages.map(({ messageId }) => messageId)).toEqual([
      message.id,
    ])
  })

  it('drops a mention once the message is deleted', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: `ping <@${context.owner.discordUserId}>`,
      discordCreatedAt: '2099-09-01T00:00:00.000Z',
    })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: message.id })
      .execute()

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-09-01T00:00:00.000Z' },
      context
    )

    expect(mentions.messages).toHaveLength(0)
  })

  it('reads what a ping says in its embeds and attachments', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const paged = await createMessage({
      attachments: [
        {
          filename: 'incident-timeline.pdf',
          size: 90210,
          url: 'https://cdn.example.test/incident-timeline.pdf',
        },
      ],
      channelId: channel.id,
      content: '',
      discordCreatedAt: '2099-11-01T00:00:00.000Z',
      embeds: [
        'Pager\nCheckout is down (https://status.example.test/incidents/412)',
      ],
      mentionedDiscordUserIds: [context.owner.discordUserId],
    })

    const mentions = await fromSuccess(listMentions)(
      { since: '2099-11-01T00:00:00.000Z' },
      context
    )

    expect(mentions.messages.map(({ messageId }) => messageId)).toEqual([
      paged.id,
    ])
    expect(mentions.messages[0].embeds).toEqual([
      'Pager\nCheckout is down (https://status.example.test/incidents/412)',
    ])
    expect(mentions.messages[0].attachments).toEqual([
      {
        filename: 'incident-timeline.pdf',
        size: 90210,
        url: 'https://cdn.example.test/incident-timeline.pdf',
      },
    ])
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await listMentions(
      { since: '2099-01-01T00:00:00.000Z' },
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
