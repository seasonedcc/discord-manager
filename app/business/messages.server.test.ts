import { randomUUID } from 'node:crypto'
import { ContextError, InputError, fromSuccess } from 'composable-functions'
import {
  MessageFetchGoneError,
  MessageFetchRejectedError,
  type MessageFetchTransport,
  countWindowMessage,
  messageFetchFailureCopy,
  messageFetchRetrievalCopy,
  messageFetchSkipCopy,
} from '~/business/messages.common'
import { countMessages, fetchMessage } from '~/business/messages.server'
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

async function deletionsOf(messageId: string) {
  return await db()
    .selectFrom('messageDeletions')
    .selectAll()
    .where('messageId', '=', messageId)
    .execute()
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

  it('says nothing about reactions when the transport could not read them', async () => {
    const { context, message } = await fetchGround()
    const transport: MessageFetchTransport = async () => ({
      attachments: [],
      content: 'the wording it carries now',
      embeds: [],
    })

    const answered = await fromSuccess(fetchMessage(transport))(
      { messageId: message.id },
      context
    )
    const telemetry = telemetryOf(message.id)

    expect(answered.message.status).toBe('retrieved')
    expect(JSON.parse(JSON.stringify(answered.message))).not.toHaveProperty(
      'reactions'
    )
    expect(await telemetry.retrievals()).toHaveLength(1)
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
    expect(await deletionsOf(message.id)).toHaveLength(1)
  })

  it('leaves one deletion behind when the store recorded it while the fetch was out', async () => {
    const { context, message } = await fetchGround()
    const racingTransport: MessageFetchTransport = async () => {
      await db()
        .insertInto('messageDeletions')
        .values({ id: newId(), messageId: message.id })
        .execute()

      throw new MessageFetchGoneError('Unknown Message')
    }

    const answered = await fromSuccess(fetchMessage(racingTransport))(
      { messageId: message.id },
      context
    )

    expect(answered.message).toMatchObject({
      status: 'failed',
      ...messageFetchFailureCopy.gone,
    })
    expect(await deletionsOf(message.id)).toHaveLength(1)
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
    expect(await deletionsOf(message.id)).toHaveLength(0)
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

async function countGround() {
  const guild = await createGuild()
  const context = await ownerContext({ guildId: guild.id })
  const channel = await createChannel({ guildId: guild.id })

  return { channel, context, guild }
}

async function appendRevision(
  messageId: string,
  content: string,
  embeds: string[] = []
) {
  const revision = await db()
    .insertInto('messageRevisions')
    .values({ id: newId(), messageId, content })
    .returning('id')
    .executeTakeFirstOrThrow()

  if (embeds.length === 0) return revision

  await db()
    .insertInto('messageRevisionEmbeds')
    .values(
      embeds.map((embed, position) => ({
        content: embed,
        id: newId(),
        messageRevisionId: revision.id,
        position,
      }))
    )
    .execute()

  return revision
}

describe('countMessages', () => {
  it('counts a message once however many revisions and embeds it carries', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()
    const message = await createMessage({
      channelId: channel.id,
      content: `first wording, ${needle}`,
      embeds: [`first embed, ${needle}`, `second embed, ${needle}`],
    })

    await appendRevision(message.id, `second wording, ${needle}`, [
      `third embed, ${needle}`,
      `fourth embed, ${needle}`,
    ])
    await appendRevision(message.id, `third wording, ${needle}`, [
      `fifth embed, ${needle}`,
      `sixth embed, ${needle}`,
    ])

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle },
      context
    )

    expect(counted.total).toBe(1)
  })

  it('leaves the messages Discord deleted out of the count', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()
    const standing = await createMessage({
      channelId: channel.id,
      content: `standing, ${needle}`,
    })
    const withdrawn = await createMessage({
      channelId: channel.id,
      content: `withdrawn, ${needle}`,
    })

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: withdrawn.id })
      .execute()

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle },
      context
    )

    expect(counted.total).toBe(1)
    expect(counted.oldestMatch).toBe(standing.discordCreatedAt)
    expect(counted.newestMatch).toBe(standing.discordCreatedAt)
  })

  it('matches the wording a message carries now, never the wording it replaced', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()
    const message = await createMessage({
      channelId: channel.id,
      content: `frozen until Thursday, ${needle}`,
    })

    await appendRevision(message.id, `frozen until Friday, ${needle}`)

    const replaced = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: `Thursday, ${needle}` },
      context
    )
    const current = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: `Friday, ${needle}` },
      context
    )

    expect(replaced.total).toBe(0)
    expect(replaced.oldestMatch).toBe(null)
    expect(replaced.newestMatch).toBe(null)
    expect(current.total).toBe(1)
    expect(current.oldestMatch).toBe(message.discordCreatedAt)
  })

  it('matches the text of an embed the message carries', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()

    await createMessage({
      channelId: channel.id,
      content: '',
      embeds: [`Checkout is failing, ${needle}`],
    })

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: `failing, ${needle}` },
      context
    )

    expect(counted.total).toBe(1)
  })

  it('stops matching an embed the latest revision no longer carries', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()
    const message = await createMessage({
      channelId: channel.id,
      content: '',
      embeds: [`Checkout is failing, ${needle}`],
    })

    await appendRevision(message.id, '')

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: `failing, ${needle}` },
      context
    )

    expect(counted.total).toBe(0)
  })

  it('matches without regard to case', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()

    await createMessage({
      channelId: channel.id,
      content: `CHECKOUT IS FAILING, ${needle}`,
    })
    await createMessage({
      channelId: channel.id,
      content: '',
      embeds: [`Checkout Is Failing, ${needle}`],
    })

    const counted = await fromSuccess(countMessages)(
      {
        channelId: channel.id,
        contentContains: `checkout is failing, ${needle}`,
      },
      context
    )

    expect(counted.total).toBe(2)
  })

  it('counts only what falls inside the window it was given', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()
    const outsideBefore = '2026-03-01T23:59:59.999Z'
    const since = '2026-03-02T00:00:00.000Z'
    const until = '2026-03-02T23:59:59.999Z'
    const outsideAfter = '2026-03-03T00:00:00.000Z'

    for (const discordCreatedAt of [
      outsideBefore,
      since,
      until,
      outsideAfter,
    ]) {
      await createMessage({
        channelId: channel.id,
        content: `alarm, ${needle}`,
        discordCreatedAt,
      })
    }

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle, since, until },
      context
    )
    const openEnded = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle, since },
      context
    )

    expect(counted.total).toBe(2)
    expect(counted.oldestMatch).toBe(since)
    expect(counted.newestMatch).toBe(until)
    expect(openEnded.total).toBe(3)
    expect(openEnded.newestMatch).toBe(outsideAfter)
  })

  it('reads a window given in another offset against the same clock the store keeps', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()

    await createMessage({
      channelId: channel.id,
      content: `alarm, ${needle}`,
      discordCreatedAt: '2026-03-02T00:30:00.000Z',
    })

    const counted = await fromSuccess(countMessages)(
      {
        channelId: channel.id,
        contentContains: needle,
        since: '2026-03-02T02:00:00+02:00',
      },
      context
    )

    expect(counted.total).toBe(1)
  })

  it('buckets the count by the UTC day each message was posted on', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()

    for (const discordCreatedAt of [
      '2026-03-01T23:59:59.999Z',
      '2026-03-02T00:00:00.000Z',
      '2026-03-02T12:00:00.000Z',
      '2026-03-04T08:00:00.000Z',
    ]) {
      await createMessage({
        channelId: channel.id,
        content: `alarm, ${needle}`,
        discordCreatedAt,
      })
    }

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle, groupBy: 'day' },
      context
    )

    expect(counted.total).toBe(4)
    expect(counted.days).toEqual([
      { date: '2026-03-01', count: 1 },
      { date: '2026-03-02', count: 2 },
      { date: '2026-03-04', count: 1 },
    ])
  })

  it('answers with no days and no timestamps when nothing matched', async () => {
    const { channel, context } = await countGround()

    await createMessage({
      channelId: channel.id,
      content: 'nothing to do with the search',
    })

    const counted = await fromSuccess(countMessages)(
      {
        channelId: channel.id,
        contentContains: randomUUID(),
        groupBy: 'day',
      },
      context
    )

    expect(counted.total).toBe(0)
    expect(counted.oldestMatch).toBe(null)
    expect(counted.newestMatch).toBe(null)
    expect(counted.days).toEqual([])
  })

  it('leaves days out of the answer when no grouping was asked for', async () => {
    const { channel, context } = await countGround()
    const needle = randomUUID()

    await createMessage({ channelId: channel.id, content: `alarm, ${needle}` })

    const counted = await fromSuccess(countMessages)(
      { channelId: channel.id, contentContains: needle },
      context
    )

    expect(counted.total).toBe(1)
    expect(counted.days).toBe(undefined)
  })

  it('counts the whole configured server when no channel is named', async () => {
    const { channel, context, guild } = await countGround()
    const alongside = await createChannel({ guildId: guild.id })
    const elsewhere = await createChannel()
    const needle = randomUUID()

    for (const channelId of [channel.id, alongside.id, elsewhere.id]) {
      await createMessage({ channelId, content: `alarm, ${needle}` })
    }

    const counted = await fromSuccess(countMessages)(
      { contentContains: needle },
      context
    )

    expect(counted.total).toBe(2)
  })

  it('refuses a channel the store never ingested', async () => {
    const { context } = await countGround()

    const result = await countMessages({ channelId: randomUUID() }, context)
    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.path).toEqual(['channelId'])
  })

  it('refuses a channel in another server', async () => {
    const { context } = await countGround()
    const elsewhere = await createChannel()

    const result = await countMessages({ channelId: elsewhere.id }, context)
    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof InputError)) {
      throw new Error('expected an input error')
    }
    expect(error.path).toEqual(['channelId'])
  })

  it('refuses a window that ends before it starts', async () => {
    const { context } = await countGround()

    const result = await countMessages(
      { since: '2026-03-04T00:00:00Z', until: '2026-03-02T00:00:00Z' },
      context
    )

    expect(result.success).toBe(false)
    expect(result.errors[0].message).toBe(countWindowMessage)
  })

  it('fails a context that cannot read messages', async () => {
    const { channel, context } = await countGround()

    const result = await countMessages(
      { channelId: channel.id },
      { ...context, canReadMessages: false }
    )
    const [error] = result.errors

    expect(result.success).toBe(false)
    if (!(error instanceof ContextError)) {
      throw new Error('expected a context error')
    }
    expect(error.path).toEqual(['canReadMessages'])
  })
})
