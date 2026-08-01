import { randomUUID } from 'node:crypto'
import {
  type Client,
  Collection,
  Events,
  type Message,
  MessageFlags,
  ReactionType,
} from 'discord.js'
import { ownerContext } from '~/business/auth.server'
import {
  gatewayHeartbeatIntervalMinutes,
  gatewaySilenceThresholdMinutes,
} from '~/business/ingestion.common'
import { backfillIngestedChannels } from '~/business/ingestion.server'
import { newId } from '~/framework/db.server'
import { makeJob, makeSchedulerRunner } from '~/framework/scheduler.server'
import { db, describe, expect, it, vi } from '~/test/prelude'
import {
  type ObservedChannel,
  handleChannelRemoval,
  handleChannelSnapshot,
  handleGatewayConnected,
  handleGatewayDisconnected,
  handleGatewayHeartbeat,
  handleIncomingMessage,
  handleMessageDeletion,
  handleMessageEdit,
  handleReactionAdded,
  handleReactionRemoved,
  handleReactionsCleared,
  observeReactions,
  registerGatewayListeners,
  startGatewayHeartbeat,
} from './gateway.server'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

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
      emoji: { name: '🔖' },
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

  it('bookmarks nothing when a teammate reacts with the bookmark emoji, and still records the reaction', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)
    const teammate = randomUUID()

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: teammate,
    })

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(additions).toHaveLength(0)
    expect(await reactionsOf(ingested.messageId)).toEqual([
      { emoji: '🔖', reactorDiscordUserId: teammate },
    ])
  })

  it('records a reaction nobody would bookmark with', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)
    const teammate = randomUUID()

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '👍' },
      reactorDiscordUserId: teammate,
    })

    expect(
      await db()
        .selectFrom('bookmarkAdditions')
        .selectAll()
        .where('messageId', '=', ingested.messageId)
        .execute()
    ).toHaveLength(0)
    expect(await reactionsOf(ingested.messageId)).toEqual([
      { emoji: '👍', reactorDiscordUserId: teammate },
    ])
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
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })
    await handleReactionRemoved({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', ingested.messageId)
      .execute()

    expect(removals).toHaveLength(1)
  })

  it('records the reaction leaving the message, whoever took it back', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)
    const teammate = randomUUID()

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
      reactorDiscordUserId: teammate,
    })
    await handleReactionRemoved({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
      reactorDiscordUserId: teammate,
    })

    expect(await reactionRemovalsOf(ingested.messageId)).toEqual([
      { emoji: '🎉', reactorDiscordUserId: teammate },
    ])
  })
})

describe('handleReactionsCleared', () => {
  it('takes every standing reaction off the message', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)
    const cheering = randomUUID()
    const agreeing = randomUUID()

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
      reactorDiscordUserId: cheering,
    })
    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '👍' },
      reactorDiscordUserId: agreeing,
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
    })

    expect(await reactionRemovalsOf(ingested.messageId)).toEqual([
      { emoji: '🎉', reactorDiscordUserId: cheering },
      { emoji: '👍', reactorDiscordUserId: agreeing },
    ])
  })

  it('takes only the named emoji off when Discord clears one of them', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)
    const cheering = randomUUID()
    const agreeing = randomUUID()

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
      reactorDiscordUserId: cheering,
    })
    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '👍' },
      reactorDiscordUserId: agreeing,
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
    })

    expect(await reactionRemovalsOf(ingested.messageId)).toEqual([
      { emoji: '🎉', reactorDiscordUserId: cheering },
    ])
  })

  it('takes the bookmark off before the clearing wipes the reaction that made it', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
    })

    const removals = await bookmarkRemovalsOf(ingested.messageId)

    expect(removals).toHaveLength(1)
    expect(removals[0].source).toBe('reaction')
    expect(await reactionRemovalsOf(ingested.messageId)).toEqual([
      { emoji: '🔖', reactorDiscordUserId: configuredOwnerId },
    ])
  })

  it('takes the bookmark off when Discord clears the bookmark emoji alone', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
    })

    expect(await bookmarkRemovalsOf(ingested.messageId)).toHaveLength(1)
  })

  it('leaves the bookmark standing when Discord clears another emoji', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })
    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
      reactorDiscordUserId: randomUUID(),
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🎉' },
    })

    expect(await bookmarkRemovalsOf(ingested.messageId)).toHaveLength(0)
  })

  it('leaves the bookmark alone when the owner had already taken the reaction back', async () => {
    await configuredGuild()
    const message = observedMessage(observedChannel())
    const ingested = await ingest(message)

    await handleReactionAdded({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })
    await handleReactionRemoved({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
      emoji: { name: '🔖' },
      reactorDiscordUserId: configuredOwnerId,
    })

    await handleReactionsCleared({
      discordGuildId: configuredGuildId,
      discordMessageId: message.discordMessageId,
    })

    expect(await bookmarkRemovalsOf(ingested.messageId)).toHaveLength(1)
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

function deliveredEmbed({
  authorName,
  description,
  fields = [],
  footerText,
  imageUrl,
  thumbnailUrl,
  timestamp,
  title,
  url,
}: {
  authorName?: string
  description?: string
  fields?: { name: string; value: string }[]
  footerText?: string
  imageUrl?: string
  thumbnailUrl?: string
  timestamp?: string
  title?: string
  url?: string
}) {
  return {
    author: authorName ? { name: authorName } : null,
    description: description ?? null,
    fields,
    footer: footerText ? { text: footerText } : null,
    image: imageUrl ? { url: imageUrl } : null,
    thumbnail: thumbnailUrl ? { url: thumbnailUrl } : null,
    timestamp: timestamp ?? null,
    title: title ?? null,
    url: url ?? null,
  }
}

function deliveredMessage({
  attachments = [],
  content = `content-${randomUUID()}`,
  discordMessageId = randomUUID(),
  embeds = [],
  mentions = [],
  suppressesEmbeds = false,
}: {
  attachments?: { name: string; size: number; url: string }[]
  content?: string
  discordMessageId?: string
  embeds?: ReturnType<typeof deliveredEmbed>[]
  mentions?: string[]
  suppressesEmbeds?: boolean
} = {}) {
  return {
    attachments: new Collection(
      attachments.map(({ name, size, url }) => {
        const id = randomUUID()

        return [id, { id, name, size, url }]
      })
    ),
    embeds,
    flags: {
      has: (flag: MessageFlags) =>
        suppressesEmbeds && flag === MessageFlags.SuppressEmbeds,
    },
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

function latestRevisionOf(discordMessageId: string) {
  return db()
    .selectFrom('messages')
    .innerJoin('messageRevisions', 'messageRevisions.messageId', 'messages.id')
    .select('messageRevisions.id')
    .where('messages.discordMessageId', '=', discordMessageId)
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow()
}

async function embedsOf(discordMessageId: string) {
  const revision = await latestRevisionOf(discordMessageId)

  return await db()
    .selectFrom('messageRevisionEmbeds')
    .select('content')
    .where('messageRevisionId', '=', revision.id)
    .orderBy('position', 'asc')
    .execute()
    .then((rows) => rows.map((row) => row.content))
}

async function attachmentsOf(discordMessageId: string) {
  const revision = await latestRevisionOf(discordMessageId)

  return await db()
    .selectFrom('messageRevisionAttachments')
    .select(['filename', 'position', 'size', 'url'])
    .where('messageRevisionId', '=', revision.id)
    .orderBy('position', 'asc')
    .execute()
}

function deliveredReaction({
  emoji,
  message,
  partial = false,
}: {
  emoji: { animated?: boolean; id?: string; name?: string | null }
  message: ReturnType<typeof deliveredMessage>
  partial?: boolean
}) {
  return {
    emoji: {
      animated: emoji.animated ?? null,
      id: emoji.id ?? null,
      name: emoji.name ?? null,
    },
    fetch: () => {
      throw new Error('a reaction handler asked Discord for the reaction')
    },
    message,
    partial,
  }
}

function messageIdOf(discordMessageId: string) {
  return db()
    .selectFrom('messages')
    .select('id')
    .where('discordMessageId', '=', discordMessageId)
    .executeTakeFirstOrThrow()
    .then(({ id }) => id)
}

function reactionsOf(messageId: string) {
  return db()
    .selectFrom('messageReactionAdditions')
    .select(['emoji', 'reactorDiscordUserId'])
    .where('messageId', '=', messageId)
    .orderBy('emoji', 'asc')
    .orderBy('reactorDiscordUserId', 'asc')
    .execute()
}

function reactionRemovalsOf(messageId: string) {
  return db()
    .selectFrom('messageReactionRemovals')
    .select(['emoji', 'reactorDiscordUserId'])
    .where('messageId', '=', messageId)
    .orderBy('emoji', 'asc')
    .orderBy('reactorDiscordUserId', 'asc')
    .execute()
}

function revisionsOf(discordMessageId: string) {
  return db()
    .selectFrom('messages')
    .innerJoin('messageRevisions', 'messageRevisions.messageId', 'messages.id')
    .select('messageRevisions.id')
    .where('messages.discordMessageId', '=', discordMessageId)
    .execute()
}

function bookmarkRemovalsOf(messageId: string) {
  return db()
    .selectFrom('bookmarkRemovals')
    .select(['id', 'source'])
    .where('messageId', '=', messageId)
    .execute()
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

  it('records what a live message carries in its embeds and attachments', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage({
      attachments: [
        {
          name: 'latency.png',
          size: 51200,
          url: 'https://cdn.example.test/latency.png',
        },
      ],
      content: '',
      embeds: [
        deliveredEmbed({
          description: 'Response times crossed the alert threshold',
          title: 'Checkout latency is high',
        }),
      ],
    })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)

    expect(await embedsOf(delivered.id)).toEqual([
      'Checkout latency is high\nResponse times crossed the alert threshold',
    ])
    expect(await attachmentsOf(delivered.id)).toEqual([
      {
        filename: 'latency.png',
        position: 0,
        size: 51200,
        url: 'https://cdn.example.test/latency.png',
      },
    ])
  })

  it('records both files of a message that attached the same filename twice', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage({
      attachments: [
        {
          name: 'screenshot.png',
          size: 12000,
          url: 'https://cdn.example.test/before/screenshot.png',
        },
        {
          name: 'screenshot.png',
          size: 13500,
          url: 'https://cdn.example.test/after/screenshot.png',
        },
      ],
      content: 'before and after',
    })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)

    expect(await attachmentsOf(delivered.id)).toEqual([
      {
        filename: 'screenshot.png',
        position: 0,
        size: 12000,
        url: 'https://cdn.example.test/before/screenshot.png',
      },
      {
        filename: 'screenshot.png',
        position: 1,
        size: 13500,
        url: 'https://cdn.example.test/after/screenshot.png',
      },
    ])
  })

  it('records nothing for the embeds Discord was told to suppress', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage({
      content: 'a link nobody wants previewed',
      embeds: [deliveredEmbed({ title: 'The preview Discord hid' })],
      suppressesEmbeds: true,
    })

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)

    expect(await embedsOf(delivered.id)).toHaveLength(0)
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

  it('keeps every part of a custom emoji Discord delivers, animated or not', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const shipping = randomUUID()
    const partying = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({
        emoji: { id: '1234567890123456789', name: 'shipit' },
        message: delivered,
      }),
      { id: shipping }
    )
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({
        emoji: { animated: true, id: '9876543210987654321', name: 'party' },
        message: delivered,
      }),
      { id: partying }
    )

    expect(await reactionsOf(await messageIdOf(delivered.id))).toEqual([
      {
        emoji: 'a:party:9876543210987654321',
        reactorDiscordUserId: partying,
      },
      {
        emoji: 'shipit:1234567890123456789',
        reactorDiscordUserId: shipping,
      },
    ])
  })

  it('takes every reaction off a message Discord cleared', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const cheering = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({ emoji: { name: '🎉' }, message: delivered }),
      { id: cheering }
    )
    await fire(handlers, Events.MessageReactionRemoveAll, delivered)

    expect(await reactionRemovalsOf(await messageIdOf(delivered.id))).toEqual([
      { emoji: '🎉', reactorDiscordUserId: cheering },
    ])
  })

  it('takes only the cleared emoji off when Discord clears one of them', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const cheering = randomUUID()
    const agreeing = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({ emoji: { name: '🎉' }, message: delivered }),
      { id: cheering }
    )
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({ emoji: { name: '👍' }, message: delivered }),
      { id: agreeing }
    )
    await fire(
      handlers,
      Events.MessageReactionRemoveEmoji,
      deliveredReaction({
        emoji: { name: '🎉' },
        message: delivered,
        partial: true,
      })
    )

    expect(await reactionRemovalsOf(await messageIdOf(delivered.id))).toEqual([
      { emoji: '🎉', reactorDiscordUserId: cheering },
    ])
  })

  it('records a reaction on a message it never cached, without asking Discord for it', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const agreeing = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({
        emoji: { name: '👍' },
        message: delivered,
        partial: true,
      }),
      { id: agreeing }
    )

    expect(await reactionsOf(await messageIdOf(delivered.id))).toEqual([
      { emoji: '👍', reactorDiscordUserId: agreeing },
    ])
  })

  it('records a reaction taken back off a message it never cached, without asking Discord for it', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const agreeing = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({ emoji: { name: '👍' }, message: delivered }),
      { id: agreeing }
    )
    await fire(
      handlers,
      Events.MessageReactionRemove,
      deliveredReaction({
        emoji: { name: '👍' },
        message: delivered,
        partial: true,
      }),
      { id: agreeing }
    )

    expect(await reactionRemovalsOf(await messageIdOf(delivered.id))).toEqual([
      { emoji: '👍', reactorDiscordUserId: agreeing },
    ])
  })

  it('names a custom emoji Discord has forgotten by its id alone', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()
    const reacting = randomUUID()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(
      handlers,
      Events.MessageReactionAdd,
      deliveredReaction({
        emoji: { id: '41771983429993937', name: null },
        message: delivered,
      }),
      { id: reacting }
    )

    expect(await reactionsOf(await messageIdOf(delivered.id))).toEqual([
      { emoji: ':41771983429993937', reactorDiscordUserId: reacting },
    ])
  })

  it('records nothing when Discord will not hand over the message that was edited', async () => {
    await configuredGuild()
    const handlers = new Map<string, GatewayHandler>()
    const client = fakeGatewayClient({
      fetchActiveThreads: async () => ({ threads: new Collection() }),
      handlers,
    })
    const delivered = deliveredMessage()

    registerGatewayListeners(client, { fetchChannelHistory: async () => [] })

    await fire(handlers, Events.MessageCreate, delivered)
    await fire(handlers, Events.MessageUpdate, delivered, {
      ...deliveredMessage({
        content: 'an edit nobody can read any more',
        discordMessageId: delivered.id,
      }),
      fetch: async () => {
        throw new Error('Unknown Message')
      },
      partial: true,
    })

    expect(await revisionsOf(delivered.id)).toHaveLength(1)
  })
})

describe('observeReactions', () => {
  it('counts the reactors who burst an emoji alongside those who simply left it', async () => {
    const reacting = randomUUID()
    const bursting = randomUUID()
    const message = {
      reactions: {
        cache: new Collection([
          [
            '🎉',
            {
              emoji: { animated: false, id: null, name: '🎉' },
              users: {
                fetch: async ({ type }: { type: ReactionType }) =>
                  type === ReactionType.Burst
                    ? new Collection([[bursting, { id: bursting }]])
                    : new Collection([[reacting, { id: reacting }]]),
              },
            },
          ],
        ]),
      },
    } as unknown as Message

    expect(await observeReactions(message)).toEqual([
      {
        emoji: { animated: false, id: undefined, name: '🎉' },
        reactorDiscordUserIds: [reacting, bursting],
      },
    ])
  })

  it('keeps a reactor who both left and burst the same emoji once', async () => {
    const enthusiastic = randomUUID()
    const message = {
      reactions: {
        cache: new Collection([
          [
            '🔥',
            {
              emoji: { animated: false, id: null, name: '🔥' },
              users: {
                fetch: async () =>
                  new Collection([[enthusiastic, { id: enthusiastic }]]),
              },
            },
          ],
        ]),
      },
    } as unknown as Message

    expect(await observeReactions(message)).toEqual([
      {
        emoji: { animated: false, id: undefined, name: '🔥' },
        reactorDiscordUserIds: [enthusiastic],
      },
    ])
  })
})

describe('startGatewayHeartbeat', () => {
  it('records the daemon liveness while a backfill occupies the work queue', async () => {
    const started = deferred()
    const released = deferred()
    const occupyTheQueue = makeJob('occupyTheQueue', async () => {
      started.resolve()
      await released.promise
    })
    const runner = makeSchedulerRunner([occupyTheQueue])

    runner.start()
    occupyTheQueue.enqueue(undefined)
    await started.promise

    const beaten = await handleGatewayHeartbeat()

    released.resolve()
    await runner.stop()

    if (!beaten.success)
      throw new Error('expected the heartbeat to be recorded')

    expect(
      await db()
        .selectFrom('gatewayHeartbeats')
        .selectAll()
        .where('id', '=', beaten.data.gatewayHeartbeatId)
        .execute()
    ).toHaveLength(1)
  })

  it('beats on a timer of its own, well inside the silence the status reads as quiet', () => {
    const startTimer = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as NodeJS.Timeout)

    startGatewayHeartbeat()()

    expect(startTimer).toHaveBeenCalledWith(
      expect.any(Function),
      gatewayHeartbeatIntervalMinutes * 60_000
    )
    expect(gatewayHeartbeatIntervalMinutes).toBeLessThan(
      gatewaySilenceThresholdMinutes
    )

    startTimer.mockRestore()
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
