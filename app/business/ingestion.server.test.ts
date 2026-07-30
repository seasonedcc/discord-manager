import { randomUUID } from 'node:crypto'
import { fromSuccess, isContextError, isInputError } from 'composable-functions'
import { ownerCaps, ownerContext } from '~/business/auth.server'
import { newId } from '~/framework/db.server'
import { createChannel, createGuild, createMessage } from '~/test/fixtures'
import { db, describe, expect, it, vi } from '~/test/prelude'
import type { BackfilledMessage, FetchChannelHistory } from './ingestion.common'
import {
  backfillChannel,
  backfillIngestedChannels,
  listBackfillableChannels,
  recordChannelRemoval,
  recordChannelSnapshot,
  recordGatewayConnection,
  recordGatewayDisconnection,
  recordGatewayHeartbeat,
  recordIncomingMessage,
  recordMessageDeletion,
  recordMessageEdit,
  recordOwnerBookmarkReaction,
  recordOwnerBookmarkReactionRemoval,
  runChannelBackfill,
} from './ingestion.server'

function ownerContextFor(
  guild: { discordGuildId: string },
  discordUserId = randomUUID()
) {
  return {
    ...ownerCaps(),
    owner: { discordUserId, guildId: guild.discordGuildId },
  }
}

function observedChannel(overrides: Record<string, unknown> = {}) {
  return {
    category: `category-${randomUUID()}`,
    discordChannelId: randomUUID(),
    isThread: false,
    name: `channel-${randomUUID()}`,
    position: 3,
    topic: `topic-${randomUUID()}`,
    ...overrides,
  }
}

function observedAuthor(overrides: Record<string, unknown> = {}) {
  return {
    discordUserId: randomUUID(),
    displayName: `display-name-${randomUUID()}`,
    username: `username-${randomUUID()}`,
    ...overrides,
  }
}

function backfilledMessage(
  overrides: Partial<BackfilledMessage> = {}
): BackfilledMessage {
  return {
    author: observedAuthor(),
    content: `content-${randomUUID()}`,
    discordCreatedAt: new Date().toISOString(),
    discordMessageId: randomUUID(),
    ...overrides,
  }
}

function fakeChannelHistory(pages: BackfilledMessage[][]) {
  const requests: Parameters<FetchChannelHistory>[0][] = []
  let nextPage = 0

  const fetchChannelHistory: FetchChannelHistory = async (request) => {
    requests.push(request)
    const page = pages[nextPage] ?? []
    nextPage += 1

    return page
  }

  return { fetchChannelHistory, requests }
}

async function configuredGuild() {
  const discordGuildId = ownerContext().owner.guildId

  await db()
    .insertInto('guilds')
    .values({ discordGuildId, id: newId() })
    .onConflict((oc) => oc.doNothing())
    .execute()

  return await db()
    .selectFrom('guilds')
    .selectAll()
    .where('discordGuildId', '=', discordGuildId)
    .executeTakeFirstOrThrow()
}

function messageRevisionsOf(messageId: string) {
  return db()
    .selectFrom('messageRevisions')
    .selectAll()
    .where('messageId', '=', messageId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute()
}

describe('recordIncomingMessage', () => {
  it('records the channel, the author and the first revision of a new message', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = observedChannel()
    const author = observedAuthor()
    const discordMessageId = randomUUID()

    const result = await fromSuccess(recordIncomingMessage)(
      {
        author,
        channel,
        content: 'the first thing said',
        discordCreatedAt: '2026-07-30T10:00:00.000Z',
        discordMessageId,
      },
      context
    )

    expect(result.outcome).toBe('recorded')

    const stored = await db()
      .selectFrom('messages')
      .innerJoin('channels', 'channels.id', 'messages.channelId')
      .innerJoin('members', 'members.id', 'messages.authorMemberId')
      .select([
        'messages.discordCreatedAt',
        'channels.discordChannelId',
        'members.discordUserId',
      ])
      .where('messages.id', '=', result.messageId)
      .executeTakeFirstOrThrow()

    expect(stored.discordChannelId).toBe(channel.discordChannelId)
    expect(stored.discordUserId).toBe(author.discordUserId)
    expect(stored.discordCreatedAt).toBe('2026-07-30T10:00:00.000Z')

    const revisions = await messageRevisionsOf(result.messageId)

    expect(revisions).toHaveLength(1)
    expect(revisions[0].content).toBe('the first thing said')
  })

  it('re-observes an already ingested message without adding a revision', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const message = {
      author: observedAuthor(),
      channel: observedChannel(),
      content: 'said once',
      discordCreatedAt: '2026-07-30T10:00:00.000Z',
      discordMessageId: randomUUID(),
    }

    const first = await fromSuccess(recordIncomingMessage)(message, context)
    const second = await fromSuccess(recordIncomingMessage)(
      { ...message, content: 'a redelivery claiming something else' },
      context
    )

    expect(second.outcome).toBe('already_ingested')
    expect(second.messageId).toBe(first.messageId)

    const revisions = await messageRevisionsOf(first.messageId)

    expect(revisions).toHaveLength(1)
    expect(revisions[0].content).toBe('said once')
  })

  it('records a member revision only when the author changed their name', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = observedChannel()
    const author = observedAuthor()

    await fromSuccess(recordIncomingMessage)(
      {
        author,
        channel,
        content: 'one',
        discordCreatedAt: '2026-07-30T10:00:00.000Z',
        discordMessageId: randomUUID(),
      },
      context
    )
    await fromSuccess(recordIncomingMessage)(
      {
        author,
        channel,
        content: 'two',
        discordCreatedAt: '2026-07-30T10:01:00.000Z',
        discordMessageId: randomUUID(),
      },
      context
    )
    await fromSuccess(recordIncomingMessage)(
      {
        author: { ...author, displayName: 'The Renamed One' },
        channel,
        content: 'three',
        discordCreatedAt: '2026-07-30T10:02:00.000Z',
        discordMessageId: randomUUID(),
      },
      context
    )

    const member = await db()
      .selectFrom('members')
      .select('id')
      .where('discordUserId', '=', author.discordUserId)
      .executeTakeFirstOrThrow()

    const revisions = await db()
      .selectFrom('memberDetailRevisions')
      .select('displayName')
      .where('memberId', '=', member.id)
      .execute()

    expect(revisions).toHaveLength(2)
    expect(revisions.map((revision) => revision.displayName)).toContain(
      'The Renamed One'
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const result = await recordIncomingMessage(
      {
        author: observedAuthor(),
        channel: observedChannel(),
        content: 'nothing lands',
        discordCreatedAt: '2026-07-30T10:00:00.000Z',
        discordMessageId: randomUUID(),
      },
      { ...ownerContextFor(guild), canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })
})

describe('recordMessageEdit', () => {
  it('appends a full snapshot of the edited message', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: 'before the edit',
    })

    const result = await fromSuccess(recordMessageEdit)(
      { content: 'after the edit', discordMessageId: message.discordMessageId },
      context
    )

    expect(result.outcome).toBe('recorded')

    const revisions = await messageRevisionsOf(message.id)

    expect(revisions).toHaveLength(2)
    expect(revisions.map((revision) => revision.content)).toEqual(
      expect.arrayContaining(['before the edit', 'after the edit'])
    )
  })

  it('skips an edit of a message this deployment never ingested', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordMessageEdit)(
      { content: 'nowhere to land', discordMessageId: randomUUID() },
      ownerContextFor(guild)
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'message_not_ingested',
    })
  })

  it('skips an edit of a message ingested for another guild', async () => {
    const channel = await createChannel()
    const message = await createMessage({ channelId: channel.id })
    const anotherGuild = await createGuild()

    const result = await fromSuccess(recordMessageEdit)(
      {
        content: 'from the wrong server',
        discordMessageId: message.discordMessageId,
      },
      ownerContextFor(anotherGuild)
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'message_not_ingested',
    })

    const revisions = await messageRevisionsOf(message.id)

    expect(revisions).toHaveLength(1)
  })
})

describe('recordMessageDeletion', () => {
  it('records the deletion of an ingested message', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    await fromSuccess(recordMessageDeletion)(
      { discordMessageId: message.discordMessageId },
      ownerContextFor(guild)
    )

    const deletions = await db()
      .selectFrom('messageDeletions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(deletions).toHaveLength(1)
  })

  it('skips a deletion of a message this deployment never ingested', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordMessageDeletion)(
      { discordMessageId: randomUUID() },
      ownerContextFor(guild)
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'message_not_ingested',
    })
  })
})

function channelAttributeRowsOf(channelId: string) {
  return Promise.all([
    db()
      .selectFrom('channelTopicChanges')
      .select('topic')
      .where('channelId', '=', channelId)
      .execute(),
    db()
      .selectFrom('channelTopicClearings')
      .select('id')
      .where('channelId', '=', channelId)
      .execute(),
    db()
      .selectFrom('channelCategoryChanges')
      .select('category')
      .where('channelId', '=', channelId)
      .execute(),
    db()
      .selectFrom('channelCategoryClearings')
      .select('id')
      .where('channelId', '=', channelId)
      .execute(),
    db()
      .selectFrom('channelPositionChanges')
      .select('position')
      .where('channelId', '=', channelId)
      .execute(),
  ]).then(
    ([topics, topicClearings, categories, categoryClearings, positions]) => ({
      categories,
      categoryClearings,
      positions,
      topicClearings,
      topics,
    })
  )
}

describe('recordChannelSnapshot', () => {
  it('records no attribute event for a channel that carries none', async () => {
    const guild = await createGuild()
    const channel = observedChannel({
      category: undefined,
      position: undefined,
      topic: undefined,
    })

    const result = await fromSuccess(recordChannelSnapshot)(
      channel,
      ownerContextFor(guild)
    )

    const revisions = await db()
      .selectFrom('channelDetailRevisions')
      .selectAll()
      .where('channelId', '=', result.channelId)
      .execute()
    const attributes = await channelAttributeRowsOf(result.channelId)

    expect(revisions).toHaveLength(1)
    expect(revisions[0].isThread).toBe(0)
    expect(attributes.topics).toHaveLength(0)
    expect(attributes.topicClearings).toHaveLength(0)
    expect(attributes.categories).toHaveLength(0)
    expect(attributes.categoryClearings).toHaveLength(0)
    expect(attributes.positions).toHaveLength(0)
  })

  it('records the attributes the channel does carry', async () => {
    const guild = await createGuild()
    const channel = observedChannel({
      category: 'Company',
      position: 4,
      topic: 'where it happens',
    })

    const result = await fromSuccess(recordChannelSnapshot)(
      channel,
      ownerContextFor(guild)
    )

    const attributes = await channelAttributeRowsOf(result.channelId)

    expect(attributes.topics.map(({ topic }) => topic)).toEqual([
      'where it happens',
    ])
    expect(attributes.categories.map(({ category }) => category)).toEqual([
      'Company',
    ])
    expect(attributes.positions.map(({ position }) => position)).toEqual([4])
  })

  it('appends a revision only when the name or the thread flag changed', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = observedChannel()

    const first = await fromSuccess(recordChannelSnapshot)(channel, context)
    await fromSuccess(recordChannelSnapshot)(channel, context)
    await fromSuccess(recordChannelSnapshot)(
      { ...channel, name: 'renamed-channel' },
      context
    )

    const revisions = await db()
      .selectFrom('channelDetailRevisions')
      .select('name')
      .where('channelId', '=', first.channelId)
      .execute()

    expect(revisions).toHaveLength(2)
    expect(revisions.map((revision) => revision.name)).toContain(
      'renamed-channel'
    )
  })

  it('appends an attribute event only when that attribute changed', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = observedChannel({ category: 'Company', topic: 'first' })

    const first = await fromSuccess(recordChannelSnapshot)(channel, context)
    await fromSuccess(recordChannelSnapshot)(channel, context)
    await fromSuccess(recordChannelSnapshot)(
      { ...channel, topic: 'second' },
      context
    )

    const attributes = await channelAttributeRowsOf(first.channelId)

    expect(attributes.topics.map(({ topic }) => topic).sort()).toEqual([
      'first',
      'second',
    ])
    expect(attributes.categories).toHaveLength(1)
  })

  it('records a clearing when an attribute the channel had is gone', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = observedChannel({ category: 'Company', topic: 'for now' })

    const first = await fromSuccess(recordChannelSnapshot)(channel, context)
    await fromSuccess(recordChannelSnapshot)(
      { ...channel, category: undefined, topic: undefined },
      context
    )
    await fromSuccess(recordChannelSnapshot)(
      { ...channel, category: undefined, topic: undefined },
      context
    )

    const attributes = await channelAttributeRowsOf(first.channelId)

    expect(attributes.topics).toHaveLength(1)
    expect(attributes.topicClearings).toHaveLength(1)
    expect(attributes.categoryClearings).toHaveLength(1)
  })

  it('records a thread as a channel of its own, with no position', async () => {
    const guild = await createGuild()
    const thread = observedChannel({ isThread: true, position: undefined })

    const result = await fromSuccess(recordChannelSnapshot)(
      thread,
      ownerContextFor(guild)
    )

    const revision = await db()
      .selectFrom('channelDetailRevisions')
      .selectAll()
      .where('channelId', '=', result.channelId)
      .executeTakeFirstOrThrow()
    const attributes = await channelAttributeRowsOf(result.channelId)

    expect(revision.isThread).toBe(1)
    expect(attributes.positions).toHaveLength(0)
  })
})

describe('recordChannelRemoval', () => {
  it('records the removal of an ingested channel', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await fromSuccess(recordChannelRemoval)(
      { discordChannelId: channel.discordChannelId },
      ownerContextFor(guild)
    )

    const removals = await db()
      .selectFrom('channelRemovals')
      .selectAll()
      .where('channelId', '=', channel.id)
      .execute()

    expect(removals).toHaveLength(1)
  })

  it('skips the removal of a channel this deployment never ingested', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordChannelRemoval)(
      { discordChannelId: randomUUID() },
      ownerContextFor(guild)
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'channel_not_ingested',
    })
  })
})

describe('recordGatewayConnection', () => {
  it('records that the bot linked to Discord', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordGatewayConnection)(
      {},
      ownerContextFor(guild)
    )

    const connections = await db()
      .selectFrom('gatewayConnections')
      .selectAll()
      .where('id', '=', result.gatewayConnectionId)
      .execute()

    expect(connections).toHaveLength(1)
  })
})

describe('recordGatewayDisconnection', () => {
  it('records that the bot lost its link to Discord', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordGatewayDisconnection)(
      {},
      ownerContextFor(guild)
    )

    const disconnections = await db()
      .selectFrom('gatewayDisconnections')
      .selectAll()
      .where('id', '=', result.gatewayDisconnectionId)
      .execute()

    expect(disconnections).toHaveLength(1)
  })
})

describe('recordGatewayHeartbeat', () => {
  it('records that the daemon is still alive', async () => {
    const guild = await createGuild()

    const result = await fromSuccess(recordGatewayHeartbeat)(
      {},
      ownerContextFor(guild)
    )

    const heartbeats = await db()
      .selectFrom('gatewayHeartbeats')
      .selectAll()
      .where('id', '=', result.gatewayHeartbeatId)
      .execute()

    expect(heartbeats).toHaveLength(1)
  })
})

describe('recordOwnerBookmarkReaction', () => {
  it('bookmarks the message when the owner reacts with the bookmark emoji', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await fromSuccess(recordOwnerBookmarkReaction)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🔖',
        reactorDiscordUserId: context.owner.discordUserId,
      },
      context
    )

    expect(result.outcome).toBe('recorded')

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(additions).toHaveLength(1)
    expect(additions[0].source).toBe('reaction')
  })

  it('records nothing when someone other than the owner reacts', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await fromSuccess(recordOwnerBookmarkReaction)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🔖',
        reactorDiscordUserId: randomUUID(),
      },
      context
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'reactor_is_not_the_owner',
    })

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(additions).toHaveLength(0)
  })

  it('records nothing when the owner reacts with another emoji', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await fromSuccess(recordOwnerBookmarkReaction)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🎉',
        reactorDiscordUserId: context.owner.discordUserId,
      },
      context
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'emoji_is_not_the_bookmark_reaction',
    })

    const additions = await db()
      .selectFrom('bookmarkAdditions')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(additions).toHaveLength(0)
  })

  it('skips a bookmark on a message this deployment never ingested', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)

    const result = await fromSuccess(recordOwnerBookmarkReaction)(
      {
        discordMessageId: randomUUID(),
        emoji: '🔖',
        reactorDiscordUserId: context.owner.discordUserId,
      },
      context
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'message_not_ingested',
    })
  })
})

describe('recordOwnerBookmarkReactionRemoval', () => {
  it('removes the bookmark when the owner takes the reaction back', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    await fromSuccess(recordOwnerBookmarkReaction)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🔖',
        reactorDiscordUserId: context.owner.discordUserId,
      },
      context
    )
    await fromSuccess(recordOwnerBookmarkReactionRemoval)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🔖',
        reactorDiscordUserId: context.owner.discordUserId,
      },
      context
    )

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(removals).toHaveLength(1)
    expect(removals[0].source).toBe('reaction')
  })

  it('records nothing when someone other than the owner takes a reaction back', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({ channelId: channel.id })

    const result = await fromSuccess(recordOwnerBookmarkReactionRemoval)(
      {
        discordMessageId: message.discordMessageId,
        emoji: '🔖',
        reactorDiscordUserId: randomUUID(),
      },
      context
    )

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'reactor_is_not_the_owner',
    })

    const removals = await db()
      .selectFrom('bookmarkRemovals')
      .selectAll()
      .where('messageId', '=', message.id)
      .execute()

    expect(removals).toHaveLength(0)
  })
})

async function backfillTelemetryOf(backfillRunId: string) {
  const [completions, failures, progress] = await Promise.all([
    db()
      .selectFrom('backfillRunCompletions')
      .selectAll()
      .where('backfillRunId', '=', backfillRunId)
      .execute(),
    db()
      .selectFrom('backfillRunFailures')
      .selectAll()
      .where('backfillRunId', '=', backfillRunId)
      .execute(),
    db()
      .selectFrom('backfillRunProgress')
      .selectAll()
      .where('backfillRunId', '=', backfillRunId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute(),
  ])

  return { completions, failures, progress }
}

describe('runChannelBackfill', () => {
  it('stores fetched history and closes the run with a single completion', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const history = fakeChannelHistory([
      [
        backfilledMessage({ discordCreatedAt: '2026-07-30T09:00:00.000Z' }),
        backfilledMessage({ discordCreatedAt: '2026-07-30T09:01:00.000Z' }),
      ],
    ])

    const result = await fromSuccess(runChannelBackfill)(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      context
    )

    expect(result.outcome).toBe('completed')
    expect(result.fetchedMessageCount).toBe(2)
    expect(result.storedMessageCount).toBe(2)

    const stored = await db()
      .selectFrom('messages')
      .selectAll()
      .where('channelId', '=', channel.id)
      .execute()

    expect(stored).toHaveLength(2)

    const telemetry = await backfillTelemetryOf(result.backfillRunId)

    expect(telemetry.completions).toHaveLength(1)
    expect(telemetry.failures).toHaveLength(0)
    expect(telemetry.progress).toHaveLength(1)
    expect(telemetry.progress[0].fetchedMessageCount).toBe(2)
    expect(telemetry.progress[0].storedMessageCount).toBe(2)
    expect(telemetry.completions[0].fetchedMessageCount).toBe(2)
    expect(telemetry.completions[0].storedMessageCount).toBe(2)
  })

  it('asks Discord for history after the newest message already stored', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const newest = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2026-07-30T08:00:00.000Z',
    })
    const history = fakeChannelHistory([[]])

    await fromSuccess(runChannelBackfill)(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      ownerContextFor(guild)
    )

    expect(history.requests[0]).toEqual({
      afterDiscordMessageId: newest.discordMessageId,
      discordChannelId: channel.discordChannelId,
      limit: 100,
    })
  })

  it('starts from the beginning of the channel when nothing is stored yet', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const history = fakeChannelHistory([[]])

    const result = await fromSuccess(runChannelBackfill)(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      ownerContextFor(guild)
    )

    expect(history.requests[0].afterDiscordMessageId).toBe('0')

    const telemetry = await backfillTelemetryOf(result.backfillRunId)

    expect(telemetry.progress).toHaveLength(0)
    expect(telemetry.completions).toHaveLength(1)
    expect(telemetry.completions[0].fetchedMessageCount).toBe(0)
  })

  it('counts a message it had already ingested as fetched but not stored', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const channel = await createChannel({ guildId: guild.id })
    const alreadyStored = await createMessage({
      channelId: channel.id,
      discordCreatedAt: '2026-07-30T08:00:00.000Z',
    })
    const history = fakeChannelHistory([
      [
        backfilledMessage({ discordMessageId: alreadyStored.discordMessageId }),
        backfilledMessage(),
      ],
    ])

    const result = await fromSuccess(runChannelBackfill)(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      context
    )

    expect(result.fetchedMessageCount).toBe(2)
    expect(result.storedMessageCount).toBe(1)
  })

  it('records exactly one failure and lets the error reach the scheduler', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const fetchChannelHistory: FetchChannelHistory = async () => {
      throw new Error('Discord answered 500')
    }

    const result = await runChannelBackfill(
      { channelId: channel.id, fetchChannelHistory },
      ownerContextFor(guild)
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(result.errors[0].message).toBe('Discord answered 500')

    const run = await db()
      .selectFrom('backfillRuns')
      .select('id')
      .where('channelId', '=', channel.id)
      .executeTakeFirstOrThrow()

    const telemetry = await backfillTelemetryOf(run.id)

    expect(telemetry.failures).toHaveLength(1)
    expect(telemetry.failures[0].errorMessage).toBe('Discord answered 500')
    expect(telemetry.completions).toHaveLength(0)
  })

  it('refuses a channel this deployment has not ingested', async () => {
    const guild = await createGuild()
    const channel = await createChannel()
    const history = fakeChannelHistory([[]])

    const result = await runChannelBackfill(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      ownerContextFor(guild)
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isInputError(result.errors[0])).toBe(true)
    expect(result.errors[0].message).toBe(
      'That channel has not been ingested yet'
    )

    const runs = await db()
      .selectFrom('backfillRuns')
      .selectAll()
      .where('channelId', '=', channel.id)
      .execute()

    expect(runs).toHaveLength(0)
  })

  it('walks page after page until Discord runs out of history', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const firstPage = Array.from({ length: 100 }).map((_message, index) =>
      backfilledMessage({
        discordCreatedAt: new Date(
          Date.parse('2026-07-30T09:00:00.000Z') + index * 1000
        ).toISOString(),
      })
    )
    const history = fakeChannelHistory([firstPage, [backfilledMessage()]])

    const result = await fromSuccess(runChannelBackfill)(
      {
        channelId: channel.id,
        fetchChannelHistory: history.fetchChannelHistory,
      },
      ownerContextFor(guild)
    )

    expect(history.requests).toHaveLength(2)
    expect(history.requests[1].afterDiscordMessageId).toBe(
      firstPage[99].discordMessageId
    )
    expect(result.fetchedMessageCount).toBe(101)

    const telemetry = await backfillTelemetryOf(result.backfillRunId)

    expect(
      telemetry.progress
        .map((row) => row.fetchedMessageCount)
        .sort((one, other) => one - other)
    ).toEqual([100, 101])
    expect(telemetry.completions).toHaveLength(1)
  })
})

describe('listBackfillableChannels', () => {
  it('leaves out the channels the bot can no longer see', async () => {
    const guild = await createGuild()
    const context = ownerContextFor(guild)
    const visible = await createChannel({ guildId: guild.id })
    const removed = await createChannel({ guildId: guild.id })

    await fromSuccess(recordChannelRemoval)(
      { discordChannelId: removed.discordChannelId },
      context
    )

    const channels = await fromSuccess(listBackfillableChannels)({}, context)

    expect(channels.map((channel) => channel.id)).toEqual([visible.id])
  })
})

describe('backfillIngestedChannels', () => {
  it('enqueues one backfill per channel the bot still sees', async () => {
    const guild = await configuredGuild()
    const channel = await createChannel({ guildId: guild.id })
    const history = fakeChannelHistory([[]])
    const enqueue = vi
      .spyOn(backfillChannel, 'enqueue')
      .mockImplementation(() => {})

    await backfillIngestedChannels.run({
      fetchChannelHistory: history.fetchChannelHistory,
    })

    expect(enqueue).toHaveBeenCalledWith({
      channelId: channel.id,
      fetchChannelHistory: history.fetchChannelHistory,
    })

    enqueue.mockRestore()
  })
})
