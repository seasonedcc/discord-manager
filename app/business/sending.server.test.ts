import { fromSuccess, isContextError, isInputError } from 'composable-functions'
import type { MessageSendTransport } from '~/business/sending.common'
import {
  messageSendSkipCopy,
  messageSendStallThresholdMinutes,
  messageSendStatusCopy,
} from '~/business/sending.common'
import { readMessageSendStatus, sendMessage } from '~/business/sending.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'
import {
  createChannel,
  createGuild,
  createMessage,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

function recordingTransport(discordMessageId = snowflake()) {
  const requests: Parameters<MessageSendTransport>[0][] = []

  const transport: MessageSendTransport = async (request) => {
    requests.push(request)

    return { discordMessageId }
  }

  return { discordMessageId, requests, transport }
}

function refusingTransport(message: string) {
  const transport: MessageSendTransport = async () => {
    throw new Error(message)
  }

  return transport
}

describe('sendMessage', () => {
  it('posts through the transport and records the delivery', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const { discordMessageId, requests, transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: 'shipping the release notes' },
      await ownerContext({ guildId: guild.id })
    )

    const deliveries = await db()
      .selectFrom('messageSendDeliveries')
      .selectAll()
      .where('messageSendRequestId', '=', send.requestId)
      .execute()

    expect(requests).toEqual([
      {
        content: 'shipping the release notes',
        discordChannelId: channel.discordChannelId,
        replyToDiscordMessageId: null,
      },
    ])
    expect(send.status).toBe('delivered')
    expect(send.summary).toBe(messageSendStatusCopy.delivered.summary)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].discordMessageId).toBe(discordMessageId)
  })

  it('records the reply target and passes it to the transport', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const replyTo = await createMessage({ channelId: channel.id })
    const { requests, transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      {
        channelId: channel.id,
        content: 'answering that',
        replyToMessageId: replyTo.id,
      },
      await ownerContext({ guildId: guild.id })
    )

    const replyTargets = await db()
      .selectFrom('messageSendRequestReplyTargets')
      .selectAll()
      .where('requestId', '=', send.requestId)
      .execute()

    expect(requests[0].replyToDiscordMessageId).toBe(replyTo.discordMessageId)
    expect(replyTargets).toHaveLength(1)
    expect(replyTargets[0].replyToMessageId).toBe(replyTo.id)
  })

  it('skips a message with no visible text', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const { requests, transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: '   ' },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('messageSendSkips')
      .selectAll()
      .where('messageSendRequestId', '=', send.requestId)
      .execute()

    expect(requests).toHaveLength(0)
    expect(send.status).toBe('skipped')
    expect(send).toMatchObject({
      reason: 'empty_content',
      ...messageSendSkipCopy.empty_content,
    })
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('empty_content')
  })

  it('skips a channel that belongs to another Discord server', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: otherGuild.id })
    const { requests, transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: 'wrong server' },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('messageSendSkips')
      .selectAll()
      .where('messageSendRequestId', '=', send.requestId)
      .execute()

    expect(requests).toHaveLength(0)
    expect(send).toMatchObject({
      reason: 'channel_not_in_guild',
      ...messageSendSkipCopy.channel_not_in_guild,
    })
    expect(skips[0].reason).toBe('channel_not_in_guild')
  })

  it('skips a channel the bot no longer sees', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const { requests, transport } = recordingTransport()

    await db()
      .insertInto('channelRemovals')
      .values({ id: newId(), channelId: channel.id })
      .execute()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: 'anybody there' },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('messageSendSkips')
      .selectAll()
      .where('messageSendRequestId', '=', send.requestId)
      .execute()

    expect(requests).toHaveLength(0)
    expect(send).toMatchObject({
      reason: 'channel_not_found',
      ...messageSendSkipCopy.channel_not_found,
    })
    expect(skips[0].reason).toBe('channel_not_found')
  })

  it('records the failure and surfaces it when Discord refuses', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const result = await sendMessage(refusingTransport('Missing Permissions'))(
      { channelId: channel.id, content: 'this will not land' },
      await ownerContext({ guildId: guild.id })
    )

    const failures = await db()
      .selectFrom('messageSendFailures')
      .innerJoin(
        'messageSendRequests',
        'messageSendRequests.id',
        'messageSendFailures.messageSendRequestId'
      )
      .selectAll('messageSendFailures')
      .where('messageSendRequests.channelId', '=', channel.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe('Missing Permissions')
    expect(failures).toHaveLength(1)
    expect(failures[0].errorMessage).toBe('Missing Permissions')
  })

  it('fails when no channel with that id was ever ingested', async () => {
    const guild = await createGuild()
    const { transport } = recordingTransport()

    const result = await sendMessage(transport)(
      { channelId: newId(), content: 'nowhere to go' },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No channel with that id has been ingested. List the channels to pick one.'
    )
  })

  it('fails when the message being replied to was never ingested', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const { transport } = recordingTransport()

    const result = await sendMessage(transport)(
      {
        channelId: channel.id,
        content: 'answering a ghost',
        replyToMessageId: newId(),
      },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No message with that id has been ingested, so there is nothing to reply to.'
    )
  })

  it('refuses a context that cannot send messages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const { transport } = recordingTransport()

    const result = await sendMessage(transport)(
      { channelId: channel.id, content: 'not allowed' },
      { ...context, canSendMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})

describe('readMessageSendStatus', () => {
  it('reads a delivered send with the Discord message id', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const { discordMessageId, transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: 'a delivered message' },
      context
    )

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: send.requestId },
      context
    )

    expect(status.send).toMatchObject({
      requestId: send.requestId,
      status: 'delivered',
      discordMessageId,
      reason: null,
      ...messageSendStatusCopy.delivered,
    })
  })

  it('reads a skipped send with the reason and its guidance', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const { transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: '   ' },
      context
    )

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: send.requestId },
      context
    )

    expect(status.send).toMatchObject({
      status: 'skipped',
      reason: 'empty_content',
      ...messageSendSkipCopy.empty_content,
    })
  })

  it('never repeats what Discord said about a failed send', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await sendMessage(refusingTransport('Missing Permissions'))(
      { channelId: channel.id, content: 'this will not land' },
      context
    )

    const request = await db()
      .selectFrom('messageSendRequests')
      .select('id')
      .where('channelId', '=', channel.id)
      .executeTakeFirstOrThrow()

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: request.id },
      context
    )

    expect(status.send).toMatchObject({
      status: 'failed',
      ...messageSendStatusCopy.failed,
    })
    expect(JSON.stringify(status)).not.toContain('errorMessage')
    expect(JSON.stringify(status)).not.toContain('Missing Permissions')
  })

  it('reads a request with no outcome yet as pending', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const request = await db()
      .insertInto('messageSendRequests')
      .values({ id: newId(), channelId: channel.id, content: 'still going' })
      .returning('id')
      .executeTakeFirstOrThrow()

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: request.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(status.send).toMatchObject({
      status: 'pending',
      ...messageSendStatusCopy.pending,
    })
  })

  it('reads a long-silent request as stalled', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const requestedAt = new Date(
      Date.now() - (messageSendStallThresholdMinutes + 1) * 60_000
    ).toISOString()
    const request = await db()
      .insertInto('messageSendRequests')
      .values({
        id: newId(),
        channelId: channel.id,
        content: 'nobody ever finished this',
        createdAt: requestedAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: request.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(status.send).toMatchObject({
      status: 'stalled',
      requestedAt,
      ...messageSendStatusCopy.stalled,
    })
  })

  it('fails when no send was ever issued under that request id', async () => {
    const guild = await createGuild()

    const result = await readMessageSendStatus(
      { requestId: newId() },
      await ownerContext({ guildId: guild.id })
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'No send with that request id was ever issued'
    )
  })

  it('refuses a context that cannot send messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await readMessageSendStatus(
      { requestId: newId() },
      { ...context, canSendMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})
