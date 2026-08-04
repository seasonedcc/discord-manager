import { randomUUID } from 'node:crypto'
import { ContextError, InputError, fromSuccess } from 'composable-functions'
import { listChannels } from '~/business/channels.server'
import {
  ThreadCreateGoneError,
  ThreadCreateRejectedError,
  type ThreadCreateTransport,
  oneAnchorMessage,
  threadAutoArchiveMinutes,
  threadCreationCopy,
  threadCreationFailureCopy,
  threadCreationSkipCopy,
} from '~/business/threads.common'
import { createThread } from '~/business/threads.server'
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

function openingTransport(discordChannelId = snowflake()) {
  const requests: Parameters<ThreadCreateTransport>[0][] = []

  const transport: ThreadCreateTransport = async (request) => {
    requests.push(request)

    return { discordChannelId }
  }

  return { discordChannelId, requests, transport }
}

function throwingTransport(error: Error) {
  const requests: Parameters<ThreadCreateTransport>[0][] = []

  const transport: ThreadCreateTransport = async (request) => {
    requests.push(request)

    throw error
  }

  return { requests, transport }
}

function created<Thread extends { status: string }>(thread: Thread) {
  if (thread.status !== 'created') {
    throw new Error(`expected a created thread, got ${thread.status}`)
  }

  return thread as Extract<Thread, { status: 'created' }>
}

async function threadGround() {
  const guild = await createGuild()
  const context = await ownerContext({ guildId: guild.id })
  const channel = await createChannel({
    guildId: guild.id,
    name: `channel-${randomUUID()}`,
  })

  return { channel, context, guild }
}

function telemetryOf(requestId: string) {
  return {
    async anchors() {
      return await db()
        .selectFrom('threadCreationRequestAnchors')
        .selectAll()
        .where('threadCreationRequestId', '=', requestId)
        .execute()
    },
    async creations() {
      return await db()
        .selectFrom('threadCreations')
        .selectAll()
        .where('threadCreationRequestId', '=', requestId)
        .execute()
    },
    async failures() {
      return await db()
        .selectFrom('threadCreationFailures')
        .selectAll()
        .where('threadCreationRequestId', '=', requestId)
        .execute()
    },
    async request() {
      return await db()
        .selectFrom('threadCreationRequests')
        .selectAll()
        .where('id', '=', requestId)
        .executeTakeFirstOrThrow()
    },
    async skips() {
      return await db()
        .selectFrom('threadCreationSkips')
        .selectAll()
        .where('threadCreationRequestId', '=', requestId)
        .execute()
    },
  }
}

async function channelOnTheList(
  context: Awaited<ReturnType<typeof ownerContext>>,
  channelId: string
) {
  const { channels } = await fromSuccess(listChannels)({}, context)

  return channels.find((channel) => channel.channelId === channelId)
}

describe('createThread', () => {
  it('creates a thread of its own in a channel and lists it right away', async () => {
    const { channel, context } = await threadGround()
    const parent = await db()
      .selectFrom('channelDetailRevisions')
      .select('name')
      .where('channelId', '=', channel.id)
      .executeTakeFirstOrThrow()
    const { discordChannelId, requests, transport } = openingTransport()
    const name = `incident-${randomUUID()}`

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name },
      context
    )
    const opened = created(thread)
    const listed = await channelOnTheList(context, opened.channelId)
    const telemetry = telemetryOf(opened.requestId)

    expect(requests).toEqual([
      {
        anchorDiscordMessageId: null,
        autoArchiveMinutes: threadAutoArchiveMinutes,
        discordChannelId: channel.discordChannelId,
        name,
      },
    ])
    expect(opened).toMatchObject({
      name,
      status: 'created',
      ...threadCreationCopy,
    })
    expect(listed).toMatchObject({
      category: parent.name,
      discordChannelId,
      isThread: true,
      name,
    })
    expect(await telemetry.anchors()).toEqual([])
    expect((await telemetry.request()).name).toBe(name)
    expect(await telemetry.creations()).toHaveLength(1)
  })

  it('answers a created thread with the link that opens it in Discord', async () => {
    const { channel, context, guild } = await threadGround()
    const { discordChannelId, transport } = openingTransport()

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name: `release-${randomUUID()}` },
      context
    )

    expect(created(thread).jumpUrl).toBe(
      `https://discord.com/channels/${guild.discordGuildId}/${discordChannelId}`
    )
  })

  it('anchors a thread on an ingested message and records the anchor', async () => {
    const { channel, context } = await threadGround()
    const message = await createMessage({ channelId: channel.id })
    const { requests, transport } = openingTransport()
    const name = `answers-${randomUUID()}`

    const { thread } = await fromSuccess(createThread(transport))(
      { messageId: message.id, name },
      context
    )
    const opened = created(thread)
    const listed = await channelOnTheList(context, opened.channelId)

    expect(requests).toEqual([
      {
        anchorDiscordMessageId: message.discordMessageId,
        autoArchiveMinutes: threadAutoArchiveMinutes,
        discordChannelId: channel.discordChannelId,
        name,
      },
    ])
    expect(listed).toMatchObject({ isThread: true, name })
    expect(await telemetryOf(opened.requestId).anchors()).toMatchObject([
      { messageId: message.id },
    ])
  })

  it('leaves the thread to the channel row the daemon already wrote', async () => {
    const { channel, context } = await threadGround()
    const alreadyIngested = await createChannel({
      guildId: channel.guildId,
      isThread: 1,
      name: 'the name the daemon recorded',
    })
    const { transport } = openingTransport(alreadyIngested.discordChannelId)

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name: 'the name we asked for' },
      context
    )
    const opened = created(thread)
    const revisions = await db()
      .selectFrom('channelDetailRevisions')
      .selectAll()
      .where('channelId', '=', alreadyIngested.id)
      .execute()

    expect(opened.channelId).toBe(alreadyIngested.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0].name).toBe('the name the daemon recorded')
  })

  it('skips a channel that belongs to another Discord server', async () => {
    const { context } = await threadGround()
    const foreign = await createChannel()
    const { requests, transport } = openingTransport()

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: foreign.id, name: 'nowhere near here' },
      context
    )

    expect(thread).toMatchObject({
      reason: 'channel_not_in_guild',
      status: 'skipped',
      ...threadCreationSkipCopy.channel_not_in_guild,
    })
    expect(await telemetryOf(thread.requestId).skips()).toMatchObject([
      { reason: 'channel_not_in_guild' },
    ])
    expect(requests).toEqual([])
  })

  it('skips a channel the bot has lost', async () => {
    const { channel, context } = await threadGround()
    const { requests, transport } = openingTransport()

    await db()
      .insertInto('channelRemovals')
      .values({ channelId: channel.id, id: newId() })
      .execute()

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name: 'anybody there' },
      context
    )

    expect(thread).toMatchObject({
      reason: 'channel_not_found',
      status: 'skipped',
      ...threadCreationSkipCopy.channel_not_found,
    })
    expect(await telemetryOf(thread.requestId).skips()).toMatchObject([
      { reason: 'channel_not_found' },
    ])
    expect(requests).toEqual([])
  })

  it('skips a channel that is itself a thread', async () => {
    const { context, guild } = await threadGround()
    const thread = await createChannel({ guildId: guild.id, isThread: 1 })
    const { requests, transport } = openingTransport()

    const answer = await fromSuccess(createThread(transport))(
      { channelId: thread.id, name: 'a thread inside a thread' },
      context
    )

    expect(answer.thread).toMatchObject({
      reason: 'channel_is_a_thread',
      status: 'skipped',
      ...threadCreationSkipCopy.channel_is_a_thread,
    })
    expect(await telemetryOf(answer.thread.requestId).skips()).toMatchObject([
      { reason: 'channel_is_a_thread' },
    ])
    expect(requests).toEqual([])
  })

  it('skips a message the store already knows was deleted', async () => {
    const { channel, context } = await threadGround()
    const message = await createMessage({ channelId: channel.id })
    const { requests, transport } = openingTransport()

    await db()
      .insertInto('messageDeletions')
      .values({ id: newId(), messageId: message.id })
      .execute()

    const { thread } = await fromSuccess(createThread(transport))(
      { messageId: message.id, name: 'about that message' },
      context
    )

    expect(thread).toMatchObject({
      reason: 'anchor_message_deleted',
      status: 'skipped',
      ...threadCreationSkipCopy.anchor_message_deleted,
    })
    expect(await telemetryOf(thread.requestId).skips()).toMatchObject([
      { reason: 'anchor_message_deleted' },
    ])
    expect(requests).toEqual([])
  })

  it('skips a message that already carries a thread', async () => {
    const { channel, context } = await threadGround()
    const message = await createMessage({ channelId: channel.id })
    const { requests, transport } = openingTransport()

    await db()
      .insertInto('channels')
      .values({
        discordChannelId: message.discordMessageId,
        guildId: channel.guildId,
        id: newId(),
      })
      .execute()

    const { thread } = await fromSuccess(createThread(transport))(
      { messageId: message.id, name: 'a second thread on one message' },
      context
    )

    expect(thread).toMatchObject({
      reason: 'thread_already_exists',
      status: 'skipped',
      ...threadCreationSkipCopy.thread_already_exists,
    })
    expect(await telemetryOf(thread.requestId).skips()).toMatchObject([
      { reason: 'thread_already_exists' },
    ])
    expect(requests).toEqual([])
  })

  it('records a message Discord no longer has as gone', async () => {
    const { channel, context } = await threadGround()
    const message = await createMessage({ channelId: channel.id })
    const vendorText = `Unknown Message ${randomUUID()}`
    const { transport } = throwingTransport(
      new ThreadCreateGoneError(vendorText)
    )

    const { thread } = await fromSuccess(createThread(transport))(
      { messageId: message.id, name: 'too late' },
      context
    )

    expect(thread).toMatchObject({
      status: 'failed',
      ...threadCreationFailureCopy.gone,
    })
    expect(await telemetryOf(thread.requestId).failures()).toMatchObject([
      { errorMessage: vendorText, kind: 'gone' },
    ])
    expect(JSON.stringify(thread)).not.toContain(vendorText)
  })

  it('records a creation Discord refused as rejected', async () => {
    const { channel, context } = await threadGround()
    const vendorText = `Missing Permissions ${randomUUID()}`
    const { transport } = throwingTransport(
      new ThreadCreateRejectedError(vendorText)
    )

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name: 'not allowed there' },
      context
    )

    expect(thread).toMatchObject({
      status: 'failed',
      ...threadCreationFailureCopy.rejected,
    })
    expect(await telemetryOf(thread.requestId).failures()).toMatchObject([
      { errorMessage: vendorText, kind: 'rejected' },
    ])
    expect(JSON.stringify(thread)).not.toContain(vendorText)
  })

  it('records a Discord it could not reach as unreachable', async () => {
    const { channel, context } = await threadGround()
    const vendorText = `getaddrinfo ENOTFOUND ${randomUUID()}`
    const { transport } = throwingTransport(new Error(vendorText))

    const { thread } = await fromSuccess(createThread(transport))(
      { channelId: channel.id, name: 'nobody answered' },
      context
    )

    expect(thread).toMatchObject({
      status: 'failed',
      ...threadCreationFailureCopy.unreachable,
    })
    expect(await telemetryOf(thread.requestId).failures()).toMatchObject([
      { errorMessage: vendorText, kind: 'unreachable' },
    ])
    expect(JSON.stringify(thread)).not.toContain(vendorText)
  })

  it('refuses a request naming both a channel and a message', async () => {
    const { channel, context } = await threadGround()
    const message = await createMessage({ channelId: channel.id })
    const { requests, transport } = openingTransport()

    const result = await createThread(transport)(
      { channelId: channel.id, messageId: message.id, name: 'which one' },
      context
    )

    expect(result.success).toBe(false)
    expect(result.errors[0].message).toBe(oneAnchorMessage)
    expect(requests).toEqual([])
  })

  it('refuses a request naming neither a channel nor a message', async () => {
    const { context } = await threadGround()
    const { requests, transport } = openingTransport()

    const result = await createThread(transport)({ name: 'where' }, context)

    expect(result.success).toBe(false)
    expect(result.errors[0].message).toBe(oneAnchorMessage)
    expect(requests).toEqual([])
  })

  it('refuses a channel id nothing has ingested', async () => {
    const { context } = await threadGround()
    const { transport } = openingTransport()

    const result = await createThread(transport)(
      { channelId: newId(), name: 'made up' },
      context
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]).toBeInstanceOf(InputError)
    expect(result.errors[0].message).toBe(
      'No channel with that id has been ingested. List the channels to pick one.'
    )
  })

  it('refuses a message id nothing has ingested', async () => {
    const { context } = await threadGround()
    const { transport } = openingTransport()

    const result = await createThread(transport)(
      { messageId: newId(), name: 'made up' },
      context
    )

    expect(result.success).toBe(false)
    expect(result.errors[0]).toBeInstanceOf(InputError)
    expect(result.errors[0].message).toBe(
      'No message with that id has been ingested, so there is nothing to anchor a thread on. Catch up on a channel to pick one.'
    )
  })

  it('refuses a context that cannot send messages', async () => {
    const { channel, context } = await threadGround()
    const { requests, transport } = openingTransport()

    const result = await createThread(transport)(
      { channelId: channel.id, name: 'not allowed' },
      { ...context, canSendMessages: false }
    )

    const [error] = result.errors

    expect(result.success).toBe(false)

    if (!(error instanceof ContextError)) {
      throw new Error('expected a context error')
    }

    expect(error.path).toEqual(['canSendMessages'])
    expect(requests).toEqual([])
  })
})
