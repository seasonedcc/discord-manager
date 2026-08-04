import {
  InputError,
  fromSuccess,
  isContextError,
  isInputError,
} from 'composable-functions'
import type { MessageSendTransport } from '~/business/sending.common'
import {
  TransportRejectedError,
  messageSendFailureCopy,
  messageSendRetryChainRefusalCopy,
  messageSendRetryRefusalCopy,
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
    throw new TransportRejectedError(message)
  }

  return transport
}

function unreachableTransport(message: string) {
  const transport: MessageSendTransport = async () => {
    throw new Error(message)
  }

  return transport
}

async function sendingGround() {
  const guild = await createGuild()
  const context = await ownerContext({ guildId: guild.id })
  const channel = await createChannel({ guildId: guild.id })

  return { channel, context, guild }
}

async function issueRequestWithoutOutcome({
  channelId,
  createdAt,
}: {
  channelId: string
  createdAt?: string
}) {
  return await db()
    .insertInto('messageSendRequests')
    .values({
      id: newId(),
      channelId,
      content: 'nobody ever finished this',
      ...(createdAt === undefined ? {} : { createdAt }),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

async function sendsInEveryState() {
  const { channel, context, guild } = await sendingGround()
  const lostChannel = await createChannel({ guildId: guild.id })
  const foreignChannel = await createChannel()

  await db()
    .insertInto('channelRemovals')
    .values({ id: newId(), channelId: lostChannel.id })
    .execute()

  const issue = async (
    transport: MessageSendTransport,
    content: string,
    channelId = channel.id
  ) => {
    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId, content },
      context
    )

    return send.requestId
  }

  const stalledAt = new Date(
    Date.now() - (messageSendStallThresholdMinutes + 1) * 60_000
  ).toISOString()

  return {
    channel,
    context,
    sends: {
      delivered: await issue(recordingTransport().transport, 'this one landed'),
      pending: (await issueRequestWithoutOutcome({ channelId: channel.id })).id,
      refused: await issue(
        refusingTransport('Missing Permissions'),
        'Discord said no'
      ),
      'skipped for a channel in another server': await issue(
        recordingTransport().transport,
        'wrong server',
        foreignChannel.id
      ),
      'skipped for a channel the bot lost': await issue(
        recordingTransport().transport,
        'anybody there',
        lostChannel.id
      ),
      'skipped for empty content': await issue(
        recordingTransport().transport,
        '   '
      ),
      stalled: (
        await issueRequestWithoutOutcome({
          channelId: channel.id,
          createdAt: stalledAt,
        })
      ).id,
      unanswered: await issue(
        unreachableTransport('socket hang up'),
        'nobody answered'
      ),
    },
  }
}

const retryableStates = ['refused', 'skipped for empty content']

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
    expect(send).toMatchObject({
      status: 'delivered',
      jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${discordMessageId}`,
      requestedAt: expect.any(String),
      ...messageSendStatusCopy.delivered,
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].discordMessageId).toBe(discordMessageId)
  })

  it('never calls a delivered message a send failure when the store refuses it', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const transport: MessageSendTransport = async () => ({
      discordMessageId: {} as unknown as string,
    })

    const result = await sendMessage(transport)(
      { channelId: channel.id, content: 'delivered, then unrecordable' },
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
    expect(failures).toHaveLength(0)
  })

  it('classifies an unreachable Discord apart from a refusal', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const { send } = await fromSuccess(
      sendMessage(unreachableTransport('fetch failed'))
    )(
      { channelId: channel.id, content: 'nobody answered' },
      await ownerContext({ guildId: guild.id })
    )

    const failures = await db()
      .selectFrom('messageSendFailures')
      .selectAll()
      .where('messageSendRequestId', '=', send.requestId)
      .execute()

    expect(send).toMatchObject({
      status: 'failed',
      ...messageSendFailureCopy.unreachable,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('unreachable')
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

  it('fails when the message being replied to is in another channel', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const elsewhere = await createChannel({ guildId: guild.id })
    const replyTo = await createMessage({ channelId: elsewhere.id })
    const { requests, transport } = recordingTransport()

    const result = await sendMessage(transport)(
      {
        channelId: channel.id,
        content: 'answering from the wrong room',
        replyToMessageId: replyTo.id,
      },
      await ownerContext({ guildId: guild.id })
    )

    const issued = await db()
      .selectFrom('messageSendRequests')
      .selectAll()
      .where('channelId', '=', channel.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    const [error] = result.errors
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.message).toBe(
      'That message is in a different channel, and Discord only attaches a reply to a message in the same channel. Send to the `channelId` that message came with, or leave out `replyToMessageId` to post on its own.'
    )
    expect(error.path).toEqual(['replyToMessageId'])
    expect(requests).toHaveLength(0)
    expect(issued).toHaveLength(0)
  })

  it('fails when the message being replied to belongs to another server', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const formerGuild = await createGuild()
    const formerChannel = await createChannel({ guildId: formerGuild.id })
    const replyTo = await createMessage({ channelId: formerChannel.id })
    const { requests, transport } = recordingTransport()

    const result = await sendMessage(transport)(
      {
        channelId: channel.id,
        content: 'answering from the wrong server',
        replyToMessageId: replyTo.id,
      },
      await ownerContext({ guildId: guild.id })
    )

    const issued = await db()
      .selectFrom('messageSendRequests')
      .selectAll()
      .where('channelId', '=', channel.id)
      .execute()

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    const [error] = result.errors
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.message).toBe(
      'That message is in a different channel, and Discord only attaches a reply to a message in the same channel. Send to the `channelId` that message came with, or leave out `replyToMessageId` to post on its own.'
    )
    expect(error.path).toEqual(['replyToMessageId'])
    expect(requests).toHaveLength(0)
    expect(issued).toHaveLength(0)
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

  it('reports a refused send as failed without repeating what Discord said', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const result = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )(
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

    expect(result.send).toMatchObject({
      requestId: failures[0].messageSendRequestId,
      status: 'failed',
      ...messageSendFailureCopy.rejected,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('rejected')
    expect(failures[0].errorMessage).toBe('Missing Permissions')
    expect(JSON.stringify(result)).not.toContain('Missing Permissions')
    expect(JSON.stringify(result)).not.toContain('errorMessage')
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

  it('links a retry to the send Discord refused', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    const { send } = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )(
      {
        channelId: channel.id,
        content: 'this will land',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    const links = await db()
      .selectFrom('messageSendRequestRetries')
      .selectAll()
      .where('retriedRequestId', '=', refused.send.requestId)
      .execute()

    expect(send.status).toBe('delivered')
    expect(links).toHaveLength(1)
    expect(links[0].requestId).toBe(send.requestId)
  })

  it('retries a send that was skipped for having no visible text', async () => {
    const { channel, context } = await sendingGround()

    const skipped = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: channel.id, content: '   ' }, context)

    const { send } = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )(
      {
        channelId: channel.id,
        content: 'the text I meant to write',
        retryOfRequestId: skipped.send.requestId,
      },
      context
    )

    expect(send.status).toBe('delivered')
  })

  it('refuses to retry a message that is already live in the channel', async () => {
    const { channel, context } = await sendingGround()

    const delivered = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: channel.id, content: 'this one landed' }, context)

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'this one landed',
        retryOfRequestId: delivered.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    const [error] = result.errors
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.message).toBe(messageSendRetryRefusalCopy.delivered)
    expect(error.path).toEqual(['retryOfRequestId'])
  })

  it('refuses to retry a send Discord never answered', async () => {
    const { channel, context } = await sendingGround()

    const unanswered = await fromSuccess(
      sendMessage(unreachableTransport('socket hang up'))
    )({ channelId: channel.id, content: 'nobody answered' }, context)

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'nobody answered',
        retryOfRequestId: unanswered.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      messageSendRetryRefusalCopy.unreachable
    )
  })

  it('refuses to retry a send nothing was ever recorded for', async () => {
    const { channel, context } = await sendingGround()
    const stalled = await issueRequestWithoutOutcome({
      channelId: channel.id,
      createdAt: new Date(
        Date.now() - (messageSendStallThresholdMinutes + 1) * 60_000
      ).toISOString(),
    })

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'nobody ever finished this',
        retryOfRequestId: stalled.id,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(messageSendRetryRefusalCopy.stalled)
  })

  it('refuses to retry a send that is still on its way', async () => {
    const { channel, context } = await sendingGround()
    const pending = await issueRequestWithoutOutcome({ channelId: channel.id })

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'still going',
        retryOfRequestId: pending.id,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(messageSendRetryRefusalCopy.pending)
  })

  it('refuses to retry a send skipped for a channel the bot lost', async () => {
    const { channel, context, guild } = await sendingGround()
    const lostChannel = await createChannel({ guildId: guild.id })

    await db()
      .insertInto('channelRemovals')
      .values({ id: newId(), channelId: lostChannel.id })
      .execute()

    const skipped = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: lostChannel.id, content: 'anybody there' }, context)

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'anybody there',
        retryOfRequestId: skipped.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      messageSendRetryRefusalCopy.channel_not_found
    )
  })

  it('refuses to retry a send skipped for a channel in another server', async () => {
    const { channel, context } = await sendingGround()
    const foreignChannel = await createChannel()

    const skipped = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: foreignChannel.id, content: 'wrong server' }, context)

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'wrong server',
        retryOfRequestId: skipped.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      messageSendRetryRefusalCopy.channel_not_in_guild
    )
  })

  it('refuses a second retry once the first retry is live in the channel', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    await fromSuccess(sendMessage(recordingTransport().transport))(
      {
        channelId: channel.id,
        content: 'this will land',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'this will land',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      messageSendRetryChainRefusalCopy.delivered
    )
  })

  it('refuses a second retry while the first retry is still on its way', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    const inFlight = await issueRequestWithoutOutcome({ channelId: channel.id })

    await db()
      .insertInto('messageSendRequestRetries')
      .values({
        id: newId(),
        requestId: inFlight.id,
        retriedRequestId: refused.send.requestId,
      })
      .execute()

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'this will land',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe(
      messageSendRetryChainRefusalCopy.pending
    )
  })

  it('lets the chain continue when the first retry was refused too', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    await fromSuccess(sendMessage(refusingTransport('Missing Permissions')))(
      {
        channelId: channel.id,
        content: 'this will not land either',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    const { send } = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )(
      {
        channelId: channel.id,
        content: 'third time lucky',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    expect(send.status).toBe('delivered')
  })

  it('fails when the send being retried was never issued', async () => {
    const { channel, context } = await sendingGround()

    const result = await sendMessage(recordingTransport().transport)(
      {
        channelId: channel.id,
        content: 'retrying a ghost',
        retryOfRequestId: newId(),
      },
      context
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    const [error] = result.errors
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.message).toBe(
      'No send with that request id was ever issued, so there is nothing to retry.'
    )
    expect(error.path).toEqual(['retryOfRequestId'])
  })

  it('records no send request at all when it refuses the retry', async () => {
    const { channel, context } = await sendingGround()
    const retryChannel = await createChannel({ guildId: channel.guildId })

    const delivered = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: channel.id, content: 'this one landed' }, context)

    const { requests, transport } = recordingTransport()

    await sendMessage(transport)(
      {
        channelId: retryChannel.id,
        content: 'this one landed',
        retryOfRequestId: delivered.send.requestId,
      },
      context
    )

    const recorded = await db()
      .selectFrom('messageSendRequests')
      .selectAll()
      .where('channelId', '=', retryChannel.id)
      .execute()

    expect(requests).toHaveLength(0)
    expect(recorded).toHaveLength(0)
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
      jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${discordMessageId}`,
      reason: null,
      ...messageSendStatusCopy.delivered,
    })
  })

  it('reads a send issued before the configured server changed', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })
    const { transport } = recordingTransport()

    const { send } = await fromSuccess(sendMessage(transport))(
      { channelId: channel.id, content: 'issued before the change' },
      context
    )

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: send.requestId },
      await ownerContext({ guildId: otherGuild.id })
    )

    expect(status.send.requestId).toBe(send.requestId)
    expect(status.send.status).toBe('delivered')
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
      canRetry: true,
      retryOfRequestId: null,
      retries: [],
      ...messageSendFailureCopy.rejected,
    })
    expect(JSON.stringify(status)).toContain('canRetry')
    expect(JSON.stringify(status)).not.toContain('errorMessage')
    expect(JSON.stringify(status)).not.toContain('Missing Permissions')
  })

  it('reads an unreachable Discord with its own guidance', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    const { send } = await fromSuccess(
      sendMessage(unreachableTransport('socket hang up'))
    )({ channelId: channel.id, content: 'nobody answered' }, context)

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: send.requestId },
      context
    )

    expect(status.send).toMatchObject({
      status: 'failed',
      ...messageSendFailureCopy.unreachable,
    })
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

  it('offers no retry for a message already live in the channel', async () => {
    const { channel, context } = await sendingGround()

    const delivered = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )({ channelId: channel.id, content: 'this one landed' }, context)

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: delivered.send.requestId },
      context
    )

    expect(status.send.canRetry).toBe(false)
  })

  it('offers no retry for a send nothing was ever recorded for', async () => {
    const { channel, context } = await sendingGround()
    const stalled = await issueRequestWithoutOutcome({
      channelId: channel.id,
      createdAt: new Date(
        Date.now() - (messageSendStallThresholdMinutes + 1) * 60_000
      ).toISOString(),
    })

    const status = await fromSuccess(readMessageSendStatus)(
      { requestId: stalled.id },
      context
    )

    expect(status.send.status).toBe('stalled')
    expect(status.send.canRetry).toBe(false)
  })

  it('shows the send a retry was made for and the retries made for a send', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    const retry = await fromSuccess(
      sendMessage(recordingTransport().transport)
    )(
      {
        channelId: channel.id,
        content: 'this will land',
        retryOfRequestId: refused.send.requestId,
      },
      context
    )

    const retried = await fromSuccess(readMessageSendStatus)(
      { requestId: refused.send.requestId },
      context
    )
    const retrying = await fromSuccess(readMessageSendStatus)(
      { requestId: retry.send.requestId },
      context
    )

    expect(retried.send.retryOfRequestId).toBe(null)
    expect(retried.send.retries).toEqual([
      { requestId: retry.send.requestId, status: 'delivered' },
    ])
    expect(retried.send.canRetry).toBe(false)
    expect(retrying.send.retryOfRequestId).toBe(refused.send.requestId)
    expect(retrying.send.retries).toEqual([])
  })

  it('stops offering a retry while a retry of that send is still on its way', async () => {
    const { channel, context } = await sendingGround()

    const refused = await fromSuccess(
      sendMessage(refusingTransport('Missing Permissions'))
    )({ channelId: channel.id, content: 'this will not land' }, context)

    const offered = await fromSuccess(readMessageSendStatus)(
      { requestId: refused.send.requestId },
      context
    )

    const inFlight = await issueRequestWithoutOutcome({ channelId: channel.id })

    await db()
      .insertInto('messageSendRequestRetries')
      .values({
        id: newId(),
        requestId: inFlight.id,
        retriedRequestId: refused.send.requestId,
      })
      .execute()

    const blocked = await fromSuccess(readMessageSendStatus)(
      { requestId: refused.send.requestId },
      context
    )

    expect(offered.send.canRetry).toBe(true)
    expect(offered.send.nextAction).toBe(
      messageSendFailureCopy.rejected.nextAction
    )
    expect(blocked.send.canRetry).toBe(false)
    expect(blocked.send.nextAction).toBe(
      messageSendRetryChainRefusalCopy.pending
    )
    expect(blocked.send.retries).toEqual([
      { requestId: inFlight.id, status: 'pending' },
    ])
  })

  it('never says a send can be retried when the guard would refuse it', async () => {
    const { channel, context, sends } = await sendsInEveryState()
    const readings: Record<string, boolean> = {}
    const guardVerdicts: Record<string, boolean> = {}

    for (const [state, requestId] of Object.entries(sends)) {
      const status = await fromSuccess(readMessageSendStatus)(
        { requestId },
        context
      )
      const guarded = await sendMessage(recordingTransport().transport)(
        {
          channelId: channel.id,
          content: `retrying the send that is ${state}`,
          retryOfRequestId: requestId,
        },
        context
      )

      readings[state] = status.send.canRetry
      guardVerdicts[state] = guarded.success
    }

    expect(readings).toEqual(guardVerdicts)
    expect(
      Object.entries(readings)
        .filter(([, canRetry]) => canRetry)
        .map(([state]) => state)
        .sort()
    ).toEqual(retryableStates)
  })
})
