import { randomUUID } from 'node:crypto'
import { type Client, Collection, Events } from 'discord.js'
import { ownerContext } from '~/business/auth.server'
import { backfillIngestedChannels } from '~/business/ingestion.server'
import { newId } from '~/framework/db.server'
import { db, describe, expect, it, vi } from '~/test/prelude'
import {
  type ObservedChannel,
  handleChannelRemoval,
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

function observedMessage(channel: ObservedChannel) {
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
})

describe('registerGatewayListeners', () => {
  it('treats a fresh identify like a resume, so the gaps still close', async () => {
    await configuredGuild()
    const handlers = new Map<string, () => Promise<void>>()
    const client = {
      channels: { cache: new Collection() },
      on: (event: string, handler: () => Promise<void>) => {
        handlers.set(event, handler)
      },
    } as unknown as Client
    const enqueue = vi
      .spyOn(backfillIngestedChannels, 'enqueue')
      .mockImplementation(() => {})
    const fetchChannelHistory = async () => []

    registerGatewayListeners(client, { fetchChannelHistory })

    await handlers.get(Events.ShardReady)?.()

    expect(handlers.has(Events.ShardResume)).toBe(true)
    expect(enqueue).toHaveBeenCalledWith({ fetchChannelHistory })

    enqueue.mockRestore()
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
