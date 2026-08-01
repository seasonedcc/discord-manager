import { randomUUID } from 'node:crypto'
import { ContextError, InputError, fromSuccess } from 'composable-functions'
import {
  MessageFetchGoneError,
  MessageFetchRejectedError,
  type MessageFetchTransport,
  messageFetchFailureCopy,
  messageFetchRetrievalCopy,
  messageFetchSkipCopy,
} from '~/business/messages.common'
import { fetchMessage } from '~/business/messages.server'
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

type LiveMessage = Awaited<ReturnType<MessageFetchTransport>>

function answeringTransport(live: Partial<LiveMessage> = {}) {
  const requests: Parameters<MessageFetchTransport>[0][] = []

  const transport: MessageFetchTransport = async (request) => {
    requests.push(request)

    return { attachments: [], content: '', embeds: [], reactions: [], ...live }
  }

  return { requests, transport }
}

function throwingTransport(error: Error) {
  const transport: MessageFetchTransport = async () => {
    throw error
  }

  return transport
}

function isRetrieved<Message extends { status: string }>(
  message: Message
): message is Extract<Message, { status: 'retrieved' }> {
  return message.status === 'retrieved'
}

function retrieved<Message extends { status: string }>(message: Message) {
  if (!isRetrieved(message)) {
    throw new Error(`expected a retrieved fetch, got ${message.status}`)
  }

  return message
}

async function fetchGround() {
  const guild = await createGuild()
  const context = await ownerContext({ guildId: guild.id })
  const channel = await createChannel({ guildId: guild.id })
  const message = await createMessage({ channelId: channel.id })

  return { channel, context, guild, message }
}

function telemetryOf(messageId: string) {
  return {
    async failures() {
      return await db()
        .selectFrom('messageFetchFailures')
        .innerJoin(
          'messageFetchRequests',
          'messageFetchRequests.id',
          'messageFetchFailures.messageFetchRequestId'
        )
        .selectAll('messageFetchFailures')
        .where('messageFetchRequests.messageId', '=', messageId)
        .execute()
    },
    async requests() {
      return await db()
        .selectFrom('messageFetchRequests')
        .selectAll()
        .where('messageId', '=', messageId)
        .execute()
    },
    async retrievals() {
      return await db()
        .selectFrom('messageFetchRetrievals')
        .innerJoin(
          'messageFetchRequests',
          'messageFetchRequests.id',
          'messageFetchRetrievals.messageFetchRequestId'
        )
        .selectAll('messageFetchRetrievals')
        .where('messageFetchRequests.messageId', '=', messageId)
        .execute()
    },
    async skips() {
      return await db()
        .selectFrom('messageFetchSkips')
        .innerJoin(
          'messageFetchRequests',
          'messageFetchRequests.id',
          'messageFetchSkips.messageFetchRequestId'
        )
        .selectAll('messageFetchSkips')
        .where('messageFetchRequests.messageId', '=', messageId)
        .execute()
    },
  }
}

describe('fetchMessage', () => {
  it('answers with the text, embeds and attachments Discord has right now', async () => {
    const { channel, context, guild, message } = await fetchGround()
    const attachment = {
      filename: 'checkout-errors.png',
      size: 20480,
      url: `https://cdn.example.test/${randomUUID()}.png?ex=fresh`,
    }
    const { requests, transport } = answeringTransport({
      attachments: [attachment],
      content: 'the wording it carries now',
      embeds: [
        {
          description: 'Checkout answered 502 five times in a row.',
          title: 'Checkout is failing',
          url: 'https://status.example.test/incidents/412',
        },
      ],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )
    const telemetry = telemetryOf(message.id)

    expect(requests).toEqual([
      {
        discordChannelId: channel.discordChannelId,
        discordMessageId: message.discordMessageId,
      },
    ])
    expect(answered.message).toMatchObject({
      attachments: [attachment],
      channelId: channel.id,
      content: 'the wording it carries now',
      discordChannelId: channel.discordChannelId,
      discordMessageId: message.discordMessageId,
      embeds: [
        'Checkout is failing (https://status.example.test/incidents/412)\nCheckout answered 502 five times in a row.',
      ],
      jumpUrl: `https://discord.com/channels/${guild.discordGuildId}/${channel.discordChannelId}/${message.discordMessageId}`,
      messageId: message.id,
      reactions: [],
      status: 'retrieved',
      ...messageFetchRetrievalCopy,
    })
    expect(await telemetry.requests()).toHaveLength(1)
    expect(await telemetry.retrievals()).toHaveLength(1)
    expect(retrieved(answered.message).fetchedAt).toBe(
      (await telemetry.retrievals())[0].createdAt
    )
  })

  it('leaves out an embed that renders to nothing readable', async () => {
    const { context, message } = await fetchGround()
    const { transport } = answeringTransport({
      embeds: [{ description: '   ', fields: [] }, { title: 'Build passed' }],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )

    expect(retrieved(answered.message).embeds).toEqual(['Build passed'])
  })

  it('counts the owner among the reactors when a reactor page names them', async () => {
    const { context, message } = await fetchGround()
    const { transport } = answeringTransport({
      reactions: [
        {
          count: 2,
          emoji: '🔥',
          reactorDiscordUserIds: [snowflake(), context.owner.discordUserId],
        },
        {
          count: 1,
          emoji: 'partyparrot:41',
          reactorDiscordUserIds: [snowflake()],
        },
      ],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )

    expect(retrieved(answered.message).reactions).toEqual([
      { count: 2, emoji: '🔥', ownerReacted: true },
      { count: 1, emoji: 'partyparrot:41', ownerReacted: false },
    ])
  })

  it('keeps the owner reacted when their reaction sits past the first hundred reactors', async () => {
    const { context, message } = await fetchGround()
    const reactorDiscordUserIds = [
      ...Array.from({ length: 149 }, () => snowflake()),
      context.owner.discordUserId,
    ]
    const { transport } = answeringTransport({
      reactions: [{ count: 150, emoji: '👍', reactorDiscordUserIds }],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )

    expect(retrieved(answered.message).reactions).toEqual([
      { count: 150, emoji: '👍', ownerReacted: true },
    ])
  })

  it('never hands out the reactor ids it read to decide that', async () => {
    const { context, message } = await fetchGround()
    const reactor = snowflake()
    const { transport } = answeringTransport({
      reactions: [{ count: 1, emoji: '👀', reactorDiscordUserIds: [reactor] }],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )

    expect(JSON.stringify(answered)).not.toContain(reactor)
  })

  it('skips the fetch when the store already recorded the message as deleted', async () => {
    const { context, message } = await fetchGround()
    const { requests, transport } = answeringTransport()

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: message.id })
      .execute()

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )
    const telemetry = telemetryOf(message.id)
    const skips = await telemetry.skips()

    expect(requests).toEqual([])
    expect(answered.message).toMatchObject({
      messageId: message.id,
      reason: 'message_deleted',
      status: 'skipped',
      ...messageFetchSkipCopy.message_deleted,
    })
    expect(await telemetry.requests()).toHaveLength(1)
    expect(await telemetry.retrievals()).toHaveLength(0)
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('message_deleted')
  })

  it('records a message Discord no longer has as a gone failure', async () => {
    const { context, message } = await fetchGround()

    const answered = await fromSuccess(
      fetchMessage(
        throwingTransport(new MessageFetchGoneError('Unknown Message'))
      )
    )({ messageId: message.id }, context)
    const failures = await telemetryOf(message.id).failures()

    expect(answered.message).toMatchObject({
      messageId: message.id,
      status: 'failed',
      ...messageFetchFailureCopy.gone,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('gone')
  })

  it('records a Discord that refused the read as a rejected failure', async () => {
    const { context, message } = await fetchGround()

    const answered = await fromSuccess(
      fetchMessage(
        throwingTransport(new MessageFetchRejectedError('Missing Access'))
      )
    )({ messageId: message.id }, context)
    const failures = await telemetryOf(message.id).failures()

    expect(answered.message).toMatchObject({
      messageId: message.id,
      status: 'failed',
      ...messageFetchFailureCopy.rejected,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('rejected')
  })

  it('records a Discord that never answered as an unreachable failure', async () => {
    const { context, message } = await fetchGround()

    const answered = await fromSuccess(
      fetchMessage(throwingTransport(new Error('fetch failed')))
    )({ messageId: message.id }, context)
    const failures = await telemetryOf(message.id).failures()

    expect(answered.message).toMatchObject({
      messageId: message.id,
      status: 'failed',
      ...messageFetchFailureCopy.unreachable,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('unreachable')
  })

  it('keeps what Discord said on the failure row and out of the answer', async () => {
    const { context, message } = await fetchGround()
    const vendorText = `Missing Access ${randomUUID()}`

    const answered = await fromSuccess(
      fetchMessage(throwingTransport(new MessageFetchRejectedError(vendorText)))
    )({ messageId: message.id }, context)
    const failures = await telemetryOf(message.id).failures()

    expect(failures[0].errorMessage).toBe(vendorText)
    expect(JSON.stringify(answered)).not.toContain('errorMessage')
    expect(JSON.stringify(answered)).not.toContain(vendorText)
  })

  it('fails on a message id the store never ingested', async () => {
    const { context } = await fetchGround()
    const { transport } = answeringTransport()

    const result = await fetchMessage(transport)(
      { messageId: newId() },
      context
    )

    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.message).toBe(
      'No message with that id has been ingested. Catch up on a channel to pick one.'
    )
    expect(error.path).toEqual(['messageId'])
  })

  it('fails on a message that belongs to another Discord server', async () => {
    const { context } = await fetchGround()
    const elsewhere = await createChannel()
    const stranger = await createMessage({ channelId: elsewhere.id })
    const { requests, transport } = answeringTransport()

    const result = await fetchMessage(transport)(
      { messageId: stranger.id },
      context
    )

    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.path).toEqual(['messageId'])
    expect(requests).toEqual([])
    expect(await telemetryOf(stranger.id).requests()).toHaveLength(0)
  })

  it('fails a context that cannot read messages', async () => {
    const { context, message } = await fetchGround()
    const { transport } = answeringTransport()

    const result = await fetchMessage(transport)(
      { messageId: message.id },
      { ...context, canReadMessages: false }
    )

    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof ContextError)) {
      throw new Error('expected a context error')
    }
    expect(error.path).toEqual(['canReadMessages'])
    expect(await telemetryOf(message.id).requests()).toHaveLength(0)
  })
})
