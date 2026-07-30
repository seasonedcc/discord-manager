import { fromSuccess, isContextError } from 'composable-functions'
import { digestMessageLimit } from '~/business/digests.common'
import { catchUpSince, listMentions } from '~/business/digests.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createChannel,
  createGuild,
  createMember,
  createMessage,
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

    expect(digest.messages.map(({ id }) => id)).toEqual([
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
        id: message.id,
        discordMessageId: message.discordMessageId,
        discordCreatedAt: '2099-02-01T00:00:00.000Z',
        channelId: channel.id,
        discordChannelId: channel.discordChannelId,
        channelName: 'product',
        authorDisplayName: 'Ada Lovelace',
        content: 'after the edit',
        jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
      },
    ])
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

    expect(digest.messages.map(({ id }) => id)).toEqual([kept.id])
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

    expect(digest.messages.map(({ id }) => id)).toEqual([wanted.id])
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

    expect(digest.messages.map(({ id }) => id)).toEqual([wanted.id])
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

    expect(mentions.messages.map(({ id }) => id)).toEqual([
      plainMention.id,
      nicknameMention.id,
    ])
    expect(mentions.truncated).toBe(false)
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

    expect(mentions.messages.map(({ id }) => id)).toEqual([message.id])
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
