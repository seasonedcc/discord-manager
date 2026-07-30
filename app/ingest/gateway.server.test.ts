import { randomUUID } from 'node:crypto'
import { type Client, Collection, Events } from 'discord.js'
import { ownerContext } from '~/business/auth.server'
import { backfillIngestedChannels } from '~/business/ingestion.server'
import { newId } from '~/framework/db.server'
import { db, describe, expect, it, vi } from '~/test/prelude'
import {
  type ObservedChannel,
  handleChannelRemoval,
  handleChannelSnapshot,
  handleGatewayConnected,
  handleGatewayDisconnected,
  handleIncomingMessage,
  handleMessageDeletion,
  handleMessageEdit,
  handleReactionAdded,
  handleReactionRemoved,
  registerGatewayListeners,
} from './gateway.server'

const configuredGuildId = ownerContext().owner.guildId
const configuredOwnerId = ownerContext().owner.discordUserId

async function configuredGuild() {
  await db()
    .insertInto('guilds')
    .values({ discordGuildId: configuredGuildId, id: newId() })
    .onConflict((oc) => oc.doNothing())
    .execute()

  return await db()
    .selectFrom('guilds')
    .selectAll()
    .where('discordGuildId', '=', configuredGuildId)
    .executeTakeFirstOrThrow()
}

function observedChannel(
  overrides: Partial<ObservedChannel> = {}
): ObservedChannel {
  return {
    category: `category-${randomUUID()}`,
    discordChannelId: randomUUID(),
    discordGuildId: configuredGuildId,
    isThread: false,
    name: `channel-${randomUUID()}`,
    position: 1,
    topic: `topic-${randomUUID()}`,
    ...overrides,
  }
}

function observedMessage(
  channel: ObservedChannel,
  mentionedDiscordUserIds: string[] = []
) {
  return {
    author: {
      discordUserId: randomUUID(),
      displayName: `display-name-${randomUUID()}`,
      username: `username-${randomUUID()}`,
    },
    channel,
    content: `content-${randomUUID()}`,
    discordCreatedAt: '2026-07-30T11:00:00.000Z',
    discordMessageId: randomUUID(),
    mentionedDiscordUserIds,
  }
}

function storedMessage(discordMessageId: string) {
  return db()
    .selectFrom('messages')
    .selectAll()
    .where('discordMessageId', '=', discordMessageId)
    .executeTakeFirst()
}

async function ingest(message: ReturnType<typeof observedMessage>) {
  const result = await handleIncomingMessage(message)

  if (!result?.success)
    throw new Error('the fake gateway feed failed to ingest')

  return result.data
}

describe('handleIncomingMessage', () => {
  it('records a message posted in the configured server', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())

    await ingest(message)

    const stored = await storedMessage(message.discordMessageId)

    expect(stored).toBeDefined()
  })

  it('ignores a message posted in another server', async () => {
    const message = observedMessage(
      observedChannel({ discordGuildId: randomUUID() })
    )

    const result = await handleIncomingMessage(message)

    expect(result).toBeUndefined()
    expect(await storedMessage(message.discordMessageId)).toBeUndefined()
  })
})

describe('handleMessageEdit', () => {
  it('records the edited snapshot of an ingested message', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleMessageEdit({
      content: 'the corrected wording',
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      mentionedDiscordUserIds: [],
    })

    const revisions = await db()
      .selectFrom('messageRevisions')
      .select('content')
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(revisions).toHaveLength(2)
    expect(revisions.map((revision) => revision.content)).toContain(
      'the corrected wording'
    )
  })
})

describe('handleMessageDeletion', () => {
  it('records the deletion of an ingested message', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleMessageDeletion({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
    })

    const deletions = await db()
      .selectFrom('messageDeletions')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(deletions).toHaveLength(1)
  })
})

function channelArchivingsOf(discordChannelId: string) {
  return db()
    .selectFrom('channelArchivings')
    .innerJoin('channels', 'channels.id', 'channelArchivings.channelId')
    .selectAll('channelArchivings')
    .where('channels.discordChannelId', '=', discordChannelId)
    .execute()
}

function channelUnarchivingsOf(discordChannelId: string) {
  return db()
    .selectFrom('channelUnarchivings')
    .innerJoin('channels', 'channels.id', 'channelUnarchivings.channelId')
    .selectAll('channelUnarchivings')
    .where('channels.discordChannelId', '=', discordChannelId)
    .execute()
}

describe('handleChannelSnapshot', () => {
  it('records that Discord archived a thread the bot watches', async () => {
    await configuredGuild()
    const thread = observedChannel({ isThread: true })

    await handleChannelSnapshot(thread)
    await handleChannelSnapshot({ ...thread, archived: true })

    expect(await channelArchivingsOf(thread.discordChannelId)).toHaveLength(1)
  })

  it('records the revival when an archived thread reports itself active', async () => {
    await configuredGuild()
    const thread = observedChannel({ archived: true, isThread: true })

    await handleChannelSnapshot(thread)
    await handleChannelSnapshot({ ...thread, archived: false })

    expect(await channelUnarchivingsOf(thread.discordChannelId)).toHaveLength(1)
  })

  it('records no archived state for a channel Discord says nothing about', async () => {
    await configuredGuild()
    const channel = observedChannel()

    await handleChannelSnapshot(channel)

    expect(await channelArchivingsOf(channel.discordChannelId)).toHaveLength(0)
    expect(await channelUnarchivingsOf(channel.discordChannelId)).toHaveLength(
      0
    )
  })
})

describe('handleChannelRemoval', () => {
  it('records that a channel is gone from the server', async () => {
    await configuredGuild()
    const channel = observedChannel()

    await ingest(observedMessage(channel))
    await handleChannelRemoval(channel)

    const removals = await db()
      .selectFrom('channelRemovals')
      .innerJoin('channels', 'channels.id', 'channelRemovals.channelId')
      .selectAll('channelRemovals')
      .where('channels.discordChannelId', '=', channel.discordChannelId)
      .execute()

    expect(removals).toHaveLength(1)
  })
})

describe('handleReactionAdded', () => {
  it('bookmarks the message when the owner reacts with the bookmark emoji', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: '🔖',
      reactorDiscordUserId: configuredOwnerId,
    })

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(additions).toHaveLength(1)
    expect(additions[0].source).toBe('reaction')
  })

  it('records nothing when a teammate reacts with the bookmark emoji', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: '🔖',
      reactorDiscordUserId: randomUUID(),
    })

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(additions).toHaveLength(0)
  })
})

describe('handleReactionRemoved', () => {
  it('removes the bookmark when the owner takes the reaction back', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: '🔖',
      reactorDiscordUserId: configuredOwnerId,
    })
    await handleReactionRemoved({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: '🔖',
      reactorDiscordUserId: configuredOwnerId,
    })

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(removals).toHaveLength(1)
  })
})

describe('handleGatewayConnected', () => {
  it('records the link, snapshots what it can see and asks for a backfill', async () => {
    await configuredGuild()
    const channel = observedChannel()
    const channelOfAnotherServer = observedChannel({
      discordGuildId: randomUUID(),
    })
    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})
    const fetchChannelHistory = async () => []

    const result = await handleGatewayConnected({
      channels: [channel, channelOfAnotherServer],
      fetchChannelHistory,
    })

    if (!result.success)
      throw new Error('expected the connection to be recorded')

    const connections = await db()
      .selectFrom('gatewayConnections')
      .selectAll()
      .where('id', '=', result.data.gatewayConnectionId)
      .execute()

    expect(connections).toHaveLength(1)

    const snapshots = await db()
      .selectFrom('channels')
      .selectAll()
      .where('discordChannelId', '=', channel.discordChannelId)
      .execute()

    expect(snapshots).toHaveLength(1)

    const ignored = await db()
      .selectFrom('channels')
      .selectAll()
      .where('discordChannelId', '=', channelOfAnotherServer.discordChannelId)
      .execute()

    expect(ignored).toHaveLength(0)
    expect(enqueue).toHaveBeenCalledWith({ fetchChannelHistory })

    enqueue.mockRestore()
  })

  it('archives the threads the server no longer lists as active before the sweep', async () => {
    await configuredGuild()
    const thread = observedChannel({ isThread: true })

    await handleChannelSnapshot(thread)

    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {
        throw new Error('the sweep was asked for')
      })

    await expect(
      handleGatewayConnected({
        activeThreadDiscordChannelIds: [],
        channels: [],
        fetchChannelHistory: async () => [],
      })
    ).rejects.toThrow('the sweep was asked for')

    expect(await channelArchivingsOf(thread.discordChannelId)).toHaveLength(1)

    enqueue.mockRestore()
  })

  it('still sweeps and marks nothing archived when the active threads are unknown', async () => {
    await configuredGuild()
    const thread = observedChannel({ isThread: true })

    await handleChannelSnapshot(thread)

    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})
    const fetchChannelHistory = async () => []

    await handleGatewayConnected({ channels: [], fetchChannelHistory })

    expect(enqueue).toHaveBeenCalledWith({ fetchChannelHistory })
    expect(await channelArchivingsOf(thread.discordChannelId)).toHaveLength(0)

    enqueue.mockRestore()
  })
})

type GatewayHandler = (...args: never[]) => Promise<void>

function fire(
  handlers: Map<string, GatewayHandler>,
  event: string,
  ...args: unknown[]
) {
  return handlers.get(event)?.(...(args as never[]))
}

function deliveredMessage({
  content = `content-${randomUUID()}`,
  discordMessageId = randomUUID(),
  mentions = [],
}: {
  content?: string
  discordMessageId?: string
  mentions?: string[]
} = {}) {
  return {
    author: {
      displayName: `display-name-${randomUUID()}`,
      id: randomUUID(),
      username: `username-${randomUUID()}`,
    },
    channel: {
      guildId: configuredGuildId,
      id: randomUUID(),
      isTextBased: () => true,
      isThread: () => false,
      name: `channel-${randomUUID()}`,
      parent: null,
    },
    content,
    createdAt: new Date('2026-07-30T11:00:00.000Z'),
    guildId: configuredGuildId,
    id: discordMessageId,
    inGuild: () => true,
    mentions: {
      users: new Collection(mentions.map((userId) => [userId, { id: userId }])),
    },
    partial: false,
  }
}

function mentionedUserIdsOf(discordMessageId: string) {
  return db()
    .selectFrom('messages')
    .innerJoin('messageRevisions', 'messageRevisions.messageId', 'messages.id')
    .innerJoin(
      'messageRevisionUserMentions',
      'messageRevisionUserMentions.messageRevisionId',
      'messageRevisions.id'
    )
    .select('messageRevisionUserMentions.mentionedDiscordUserId')
    .where('messages.discordMessageId', '=', discordMessageId)
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .execute()
    .then((rows) => rows.map((row) => row.mentionedDiscordUserId))
}

function fakeGatewayClient({
  fetchActiveThreads,
  handlers,
}: {
  fetchActiveThreads: () => Promise<{ threads: Collection<string, unknown> }>
  handlers: Map<string, GatewayHandler>
}) {
  return {
    channels: { cache: new Collection() },
    guilds: {
      cache: new Collection([
        [configuredGuildId, { channels: { fetchActiveThreads } }],
      ]),
    },
    on: (event: string, handler: GatewayHandler) => {
      handlers.set(event, handler)
    },
  } as unknown as Client
}

describe('registerGatewayListeners', () => {
  it('treats a fresh identify like a resume, so the gaps still close', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})
    const fetchChannelHistory = async () => []

    registerGatewayListeners(client, { fetchChannelHistory })

    await fire(handlers, Events.ShardReady, client)

    expect(handlers.has(Events.ShardResume)).toBe(true)
    expect(enqueue).toHaveBeenCalledWith({ fetchChannelHistory })

    enqueue.mockRestore()
  })

  it('reads the active threads from Discord on every reconnect', async () => {
    await configuredGuild()
    const stillActive = observedChannel({ isThread: true })
    const goneQuiet = observedChannel({ isThread: true })

    await handleChannelSnapshot(stillActive)
    await handleChannelSnapshot(goneQuiet)

    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({
        threads: new Collection([[stillActive.discordChannelId, {}]]),
      }),
      handlers,
    })
    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.ShardResume, client)

    expect(await channelArchivingsOf(goneQuiet.discordChannelId)).toHaveLength(
      1
    )
    expect(
      await channelArchivingsOf(stillActive.discordChannelId)
    ).toHaveLength(0)

    enqueue.mockRestore()
  })

  it('sweeps without marking anything archived when Discord refuses the active threads', async () => {
    await configuredGuild()
    const thread = observedChannel({ isThread: true })

    await handleChannelSnapshot(thread)

    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => {
        throw new Error('Missing Access')
      },
      handlers,
    })
    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})
    const fetchChannelHistory = async () => []

    registerGatewayListeners(client, { fetchChannelHistory })

    await fire(handlers, Events.ShardReady, client)

    expect(enqueue).toHaveBeenCalledWith({ fetchChannelHistory })
    expect(await channelArchivingsOf(thread.discordChannelId)).toHaveLength(0)

    enqueue.mockRestore()
  })

  it('records the users Discord itself says a live message mentions', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const pinged = randomUUID()
    const delivered = deliveredMessage({ mentions: [pinged] })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)

    expect(await mentionedUserIdsOf(delivered.id)).toEqual([pinged])
  })

  it('reads a live mention set from Discord, never from the message text', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const quoted = randomUUID()
    const delivered = deliveredMessage({
      content: `a reply to <@${quoted}> with the ping suppressed`,
      mentions: [],
    })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)

    expect(await mentionedUserIdsOf(delivered.id)).toHaveLength(0)
  })

  it('records the mention set Discord stamped on an edited message', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const pinged = randomUUID()
    const delivered = deliveredMessage({ mentions: [] })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageUpdate,
      delivered,
      deliveredMessage({
        content: 'now it pings somebody',
        discordMessageId: delivered.id,
        mentions: [pinged],
      })
    )

    expect(await mentionedUserIdsOf(delivered.id)).toEqual([pinged])
  })
})

describe('handleGatewayDisconnected', () => {
  it('records that the bot lost its link to Discord', async () => {
    const result = await handleGatewayDisconnected()

    if (!result.success) throw new Error('expected the drop to be recorded')

    const disconnections = await db()
      .selectFrom('gatewayDisconnections')
      .selectAll()
      .where('id', '=', result.data.gatewayDisconnectionId)
      .execute()

    expect(disconnections).toHaveLength(1)
  })
})
