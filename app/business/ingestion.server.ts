import { InputError, applySchema, fromSuccess } from 'composable-functions'
import type { Transaction } from 'kysely'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContext, ownerContextSchema } from '~/business/auth.server'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'
import { newId } from '~/framework/db.server'
import { makeCronJob, makeJob } from '~/framework/scheduler.server'
import {
  type BackfilledMessage,
  type FetchChannelHistory,
  backfillPageLimit,
  backfillPageSize,
  bookmarkReactionEmoji,
  discordHistoryBeginningSnowflake,
  gatewayHeartbeatIntervalMinutes,
  skipped,
} from './ingestion.common'
import {
  type ObservedAttachment,
  type ObservedEmbed,
  observedAttachmentSchema,
  observedEmbedSchema,
  observedEmojiSchema,
  renderEmbed,
  renderEmoji,
} from './messages.common'

const pageLimitReachedMessage =
  'Stopped at the page limit before reaching the newest messages'

const ingestionContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

const bookmarkReactionContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
})

const mentionedDiscordUserIdsSchema = z.array(z.string().min(1))

const observedEmbedsSchema = z.array(observedEmbedSchema).default([])

const observedAttachmentsSchema = z.array(observedAttachmentSchema).default([])

const observedAuthorSchema = z.object({
  discordUserId: z.string().min(1),
  displayName: z.string().min(1),
  username: z.string().min(1),
})

const observedChannelSchema = z.object({
  category: z.string().optional(),
  discordChannelId: z.string().min(1),
  isThread: z.boolean(),
  name: z.string().min(1),
  position: z.number().int().optional(),
  topic: z.string().optional(),
})

const reconcileThreadArchivingsSchema = z.object({
  activeThreadDiscordChannelIds: z.array(z.string().min(1)),
})

const recordChannelArchivingSchema = z.object({
  discordChannelId: z.string().min(1),
})

const recordChannelRemovalSchema = z.object({
  discordChannelId: z.string().min(1),
})

const recordChannelSnapshotSchema = observedChannelSchema

const recordChannelUnarchivingSchema = z.object({
  discordChannelId: z.string().min(1),
})

const recordGatewayConnectionSchema = z.object({})

const recordGatewayDisconnectionSchema = z.object({})

const recordGatewayHeartbeatSchema = z.object({})

const recordIncomingMessageSchema = z.object({
  attachments: observedAttachmentsSchema,
  author: observedAuthorSchema,
  channel: observedChannelSchema,
  content: z.string(),
  discordCreatedAt: z.string().min(1),
  discordMessageId: z.string().min(1),
  embeds: observedEmbedsSchema,
  mentionedDiscordUserIds: mentionedDiscordUserIdsSchema,
})

const recordMessageDeletionSchema = z.object({
  discordMessageId: z.string().min(1),
})

const recordMessageEditSchema = z.object({
  attachments: observedAttachmentsSchema,
  content: z.string(),
  discordMessageId: z.string().min(1),
  embeds: observedEmbedsSchema,
  mentionedDiscordUserIds: mentionedDiscordUserIdsSchema,
})

const recordMessageReactionSchema = z.object({
  discordMessageId: z.string().min(1),
  emoji: observedEmojiSchema,
  reactorDiscordUserId: z.string().min(1),
})

const recordMessageReactionClearingSchema = z.object({
  discordMessageId: z.string().min(1),
  emoji: observedEmojiSchema.optional(),
})

const runChannelBackfillSchema = z.object({
  channelId: z.string().min(1),
  fetchChannelHistory: z.custom<FetchChannelHistory>(
    (value) => typeof value === 'function',
    { message: 'A Discord history transport is required' }
  ),
})

type ObservedAuthor = z.output<typeof observedAuthorSchema>
type ObservedChannel = z.output<typeof observedChannelSchema>

async function findOrCreateGuild(trx: Transaction<DB>, discordGuildId: string) {
  await trx
    .insertInto('guilds')
    .values({ discordGuildId, id: newId() })
    .onConflict((oc) => oc.doNothing())
    .execute()

  return await trx
    .selectFrom('guilds')
    .select('id')
    .where('discordGuildId', '=', discordGuildId)
    .executeTakeFirstOrThrow()
}

async function currentChannelTopic(trx: Transaction<DB>, channelId: string) {
  const events = trx
    .selectFrom('channelTopicChanges')
    .select((eb) => [
      'createdAt',
      'id',
      eb.ref('topic').$castTo<string | null>().as('topic'),
    ])
    .where('channelId', '=', channelId)
    .unionAll(
      trx
        .selectFrom('channelTopicClearings')
        .select(['createdAt', 'id', sql<string | null>`null`.as('topic')])
        .where('channelId', '=', channelId)
    )

  const newest = await trx
    .selectFrom(events.as('topicEvents'))
    .select('topic')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  return newest?.topic ?? null
}

async function currentChannelCategory(trx: Transaction<DB>, channelId: string) {
  const events = trx
    .selectFrom('channelCategoryChanges')
    .select((eb) => [
      'createdAt',
      'id',
      eb.ref('category').$castTo<string | null>().as('category'),
    ])
    .where('channelId', '=', channelId)
    .unionAll(
      trx
        .selectFrom('channelCategoryClearings')
        .select(['createdAt', 'id', sql<string | null>`null`.as('category')])
        .where('channelId', '=', channelId)
    )

  const newest = await trx
    .selectFrom(events.as('categoryEvents'))
    .select('category')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  return newest?.category ?? null
}

async function currentChannelPosition(trx: Transaction<DB>, channelId: string) {
  const events = trx
    .selectFrom('channelPositionChanges')
    .select((eb) => [
      'createdAt',
      'id',
      eb.ref('position').$castTo<number | null>().as('position'),
    ])
    .where('channelId', '=', channelId)
    .unionAll(
      trx
        .selectFrom('channelPositionClearings')
        .select(['createdAt', 'id', sql<number | null>`null`.as('position')])
        .where('channelId', '=', channelId)
    )

  const newest = await trx
    .selectFrom(events.as('positionEvents'))
    .select('position')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  return newest?.position ?? null
}

async function recordChannelTopic(
  trx: Transaction<DB>,
  channelId: string,
  topic: string | undefined
) {
  const current = await currentChannelTopic(trx, channelId)

  if (topic === undefined) {
    if (current === null) return

    await trx
      .insertInto('channelTopicClearings')
      .values({ channelId, id: newId() })
      .execute()

    return
  }

  if (current === topic) return

  await trx
    .insertInto('channelTopicChanges')
    .values({ channelId, id: newId(), topic })
    .execute()
}

async function recordChannelCategory(
  trx: Transaction<DB>,
  channelId: string,
  category: string | undefined
) {
  const current = await currentChannelCategory(trx, channelId)

  if (category === undefined) {
    if (current === null) return

    await trx
      .insertInto('channelCategoryClearings')
      .values({ channelId, id: newId() })
      .execute()

    return
  }

  if (current === category) return

  await trx
    .insertInto('channelCategoryChanges')
    .values({ category, channelId, id: newId() })
    .execute()
}

async function recordChannelPosition(
  trx: Transaction<DB>,
  channelId: string,
  position: number | undefined
) {
  const current = await currentChannelPosition(trx, channelId)

  if (position === undefined) {
    if (current === null) return

    await trx
      .insertInto('channelPositionClearings')
      .values({ channelId, id: newId() })
      .execute()

    return
  }

  if (current === position) return

  await trx
    .insertInto('channelPositionChanges')
    .values({ channelId, id: newId(), position })
    .execute()
}

async function findOrCreateChannel(
  trx: Transaction<DB>,
  guildId: string,
  channel: ObservedChannel
) {
  await trx
    .insertInto('channels')
    .values({
      discordChannelId: channel.discordChannelId,
      guildId,
      id: newId(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute()

  const record = await trx
    .selectFrom('channels')
    .select('id')
    .where('discordChannelId', '=', channel.discordChannelId)
    .executeTakeFirstOrThrow()

  const latestDetail = await trx
    .selectFrom('channelDetailRevisions')
    .select(['isThread', 'name'])
    .where('channelId', '=', record.id)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  const isThread = channel.isThread ? 1 : 0

  if (
    !latestDetail ||
    latestDetail.isThread !== isThread ||
    latestDetail.name !== channel.name
  ) {
    await trx
      .insertInto('channelDetailRevisions')
      .values({
        channelId: record.id,
        id: newId(),
        isThread,
        name: channel.name,
      })
      .execute()
  }

  await recordChannelTopic(trx, record.id, channel.topic)
  await recordChannelCategory(trx, record.id, channel.category)
  await recordChannelPosition(trx, record.id, channel.position)

  return record
}

async function findOrCreateMember(
  trx: Transaction<DB>,
  author: ObservedAuthor
) {
  await trx
    .insertInto('members')
    .values({ discordUserId: author.discordUserId, id: newId() })
    .onConflict((oc) => oc.doNothing())
    .execute()

  const record = await trx
    .selectFrom('members')
    .select('id')
    .where('discordUserId', '=', author.discordUserId)
    .executeTakeFirstOrThrow()

  const latestDetail = await trx
    .selectFrom('memberDetailRevisions')
    .select(['displayName', 'username'])
    .where('memberId', '=', record.id)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  const unchanged =
    latestDetail &&
    latestDetail.displayName === author.displayName &&
    latestDetail.username === author.username

  if (!unchanged) {
    await trx
      .insertInto('memberDetailRevisions')
      .values({
        displayName: author.displayName,
        id: newId(),
        memberId: record.id,
        username: author.username,
      })
      .execute()
  }

  return record
}

async function insertMessageRevision(
  trx: Transaction<DB>,
  values: {
    attachments: ObservedAttachment[]
    content: string
    embeds: ObservedEmbed[]
    mentionedDiscordUserIds: string[]
    messageId: string
  }
) {
  const revision = await trx
    .insertInto('messageRevisions')
    .values({
      content: values.content,
      id: newId(),
      messageId: values.messageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const mentioned = [...new Set(values.mentionedDiscordUserIds)]

  if (mentioned.length > 0) {
    await trx
      .insertInto('messageRevisionUserMentions')
      .values(
        mentioned.map((mentionedDiscordUserId) => ({
          id: newId(),
          mentionedDiscordUserId,
          messageRevisionId: revision.id,
        }))
      )
      .execute()
  }

  const readableEmbeds = values.embeds.flatMap((embed, position) => {
    const content = renderEmbed(embed)

    return content
      ? [{ content, id: newId(), messageRevisionId: revision.id, position }]
      : []
  })

  if (readableEmbeds.length > 0) {
    await trx
      .insertInto('messageRevisionEmbeds')
      .values(readableEmbeds)
      .execute()
  }

  if (values.attachments.length > 0) {
    await trx
      .insertInto('messageRevisionAttachments')
      .values(
        values.attachments.map(({ filename, size, url }, position) => ({
          filename,
          id: newId(),
          messageRevisionId: revision.id,
          position,
          size,
          url,
        }))
      )
      .execute()
  }
}

async function insertMessageWithFirstRevision(
  trx: Transaction<DB>,
  values: {
    attachments: ObservedAttachment[]
    authorMemberId: string
    channelId: string
    content: string
    discordCreatedAt: string
    discordMessageId: string
    embeds: ObservedEmbed[]
    mentionedDiscordUserIds: string[]
  }
) {
  const inserted = await trx
    .insertInto('messages')
    .values({
      authorMemberId: values.authorMemberId,
      channelId: values.channelId,
      discordCreatedAt: values.discordCreatedAt,
      discordMessageId: values.discordMessageId,
      id: newId(),
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst()

  if (!inserted) {
    const existing = await trx
      .selectFrom('messages')
      .select('id')
      .where('discordMessageId', '=', values.discordMessageId)
      .executeTakeFirstOrThrow()

    return { messageId: existing.id, outcome: 'already_ingested' as const }
  }

  await insertMessageRevision(trx, {
    attachments: values.attachments,
    content: values.content,
    embeds: values.embeds,
    mentionedDiscordUserIds: values.mentionedDiscordUserIds,
    messageId: inserted.id,
  })

  return { messageId: inserted.id, outcome: 'recorded' as const }
}

function findIngestedMessage(discordMessageId: string, discordGuildId: string) {
  return db()
    .selectFrom('messages')
    .innerJoin('channels', 'channels.id', 'messages.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .select('messages.id')
    .where('messages.discordMessageId', '=', discordMessageId)
    .where('guilds.discordGuildId', '=', discordGuildId)
    .executeTakeFirst()
}

function findIngestedChannel(discordChannelId: string, discordGuildId: string) {
  return db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .select('channels.id')
    .where('channels.discordChannelId', '=', discordChannelId)
    .where('guilds.discordGuildId', '=', discordGuildId)
    .executeTakeFirst()
}

function latestChannelArchivedStates() {
  const events = db()
    .selectFrom('channelArchivings')
    .select(['channelId', 'createdAt', 'id', sql<number>`1`.as('archived')])
    .unionAll(
      db()
        .selectFrom('channelUnarchivings')
        .select(['channelId', 'createdAt', 'id', sql<number>`0`.as('archived')])
    )

  const ranked = db()
    .selectFrom(events.as('archivedEvents'))
    .select((eb) => [
      'channelId',
      'archived',
      'createdAt',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('channelId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedArchivedStates')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'archived', 'createdAt'])
    .where('rowNumber', '=', 1)
    .as('channelArchivedStates')
}

function latestChannelThreadFlags() {
  const ranked = db()
    .selectFrom('channelDetailRevisions')
    .select((eb) => [
      'channelId',
      'isThread',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('channelId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedThreadFlags')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'isThread'])
    .where('rowNumber', '=', 1)
    .as('channelThreadFlags')
}

async function currentlyArchived(channelId: string) {
  const state = await db()
    .selectFrom(latestChannelArchivedStates())
    .select('archived')
    .where('channelArchivedStates.channelId', '=', channelId)
    .executeTakeFirst()

  return state?.archived === 1
}

const recordGatewayConnection = applySchema(
  recordGatewayConnectionSchema,
  ingestionContextSchema
)(async () => {
  const connection = await db()
    .insertInto('gatewayConnections')
    .values({ id: newId() })
    .returning('id')
    .executeTakeFirstOrThrow()

  return { gatewayConnectionId: connection.id, outcome: 'recorded' as const }
})

const recordGatewayDisconnection = applySchema(
  recordGatewayDisconnectionSchema,
  ingestionContextSchema
)(async () => {
  const disconnection = await db()
    .insertInto('gatewayDisconnections')
    .values({ id: newId() })
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    gatewayDisconnectionId: disconnection.id,
    outcome: 'recorded' as const,
  }
})

const recordGatewayHeartbeat = applySchema(
  recordGatewayHeartbeatSchema,
  ingestionContextSchema
)(async () => {
  const heartbeat = await db()
    .insertInto('gatewayHeartbeats')
    .values({ id: newId() })
    .returning('id')
    .executeTakeFirstOrThrow()

  return { gatewayHeartbeatId: heartbeat.id, outcome: 'recorded' as const }
})

const recordIncomingMessage = applySchema(
  recordIncomingMessageSchema,
  ingestionContextSchema
)(async (input, context) => {
  return await db()
    .transaction()
    .execute(async (trx) => {
      const guild = await findOrCreateGuild(trx, context.owner.guildId)
      const channel = await findOrCreateChannel(trx, guild.id, input.channel)
      const member = await findOrCreateMember(trx, input.author)

      return await insertMessageWithFirstRevision(trx, {
        attachments: input.attachments,
        authorMemberId: member.id,
        channelId: channel.id,
        content: input.content,
        discordCreatedAt: input.discordCreatedAt,
        discordMessageId: input.discordMessageId,
        embeds: input.embeds,
        mentionedDiscordUserIds: input.mentionedDiscordUserIds,
      })
    })
})

const recordMessageEdit = applySchema(
  recordMessageEditSchema,
  ingestionContextSchema
)(
  async (
    { attachments, content, discordMessageId, embeds, mentionedDiscordUserIds },
    context
  ) => {
    const message = await findIngestedMessage(
      discordMessageId,
      context.owner.guildId
    )

    if (!message) return skipped('message_not_ingested')

    await db()
      .transaction()
      .execute((trx) =>
        insertMessageRevision(trx, {
          attachments,
          content,
          embeds,
          mentionedDiscordUserIds,
          messageId: message.id,
        })
      )

    return { messageId: message.id, outcome: 'recorded' as const }
  }
)

const recordMessageDeletion = applySchema(
  recordMessageDeletionSchema,
  ingestionContextSchema
)(async ({ discordMessageId }, context) => {
  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  await db()
    .insertInto('messageDeletions')
    .values({ id: newId(), messageId: message.id })
    .execute()

  return { messageId: message.id, outcome: 'recorded' as const }
})

const recordChannelSnapshot = applySchema(
  recordChannelSnapshotSchema,
  ingestionContextSchema
)(async (channel, context) => {
  const record = await db()
    .transaction()
    .execute(async (trx) => {
      const guild = await findOrCreateGuild(trx, context.owner.guildId)

      return await findOrCreateChannel(trx, guild.id, channel)
    })

  return { channelId: record.id, outcome: 'recorded' as const }
})

const recordChannelRemoval = applySchema(
  recordChannelRemovalSchema,
  ingestionContextSchema
)(async ({ discordChannelId }, context) => {
  const channel = await findIngestedChannel(
    discordChannelId,
    context.owner.guildId
  )

  if (!channel) return skipped('channel_not_ingested')

  await db()
    .insertInto('channelRemovals')
    .values({ channelId: channel.id, id: newId() })
    .execute()

  return { channelId: channel.id, outcome: 'recorded' as const }
})

const recordChannelArchiving = applySchema(
  recordChannelArchivingSchema,
  ingestionContextSchema
)(async ({ discordChannelId }, context) => {
  const channel = await findIngestedChannel(
    discordChannelId,
    context.owner.guildId
  )

  if (!channel) return skipped('channel_not_ingested')

  if (await currentlyArchived(channel.id)) {
    return skipped('channel_is_already_archived')
  }

  await db()
    .insertInto('channelArchivings')
    .values({ channelId: channel.id, id: newId() })
    .execute()

  return { channelId: channel.id, outcome: 'recorded' as const }
})

const recordChannelUnarchiving = applySchema(
  recordChannelUnarchivingSchema,
  ingestionContextSchema
)(async ({ discordChannelId }, context) => {
  const channel = await findIngestedChannel(
    discordChannelId,
    context.owner.guildId
  )

  if (!channel) return skipped('channel_not_ingested')

  if (!(await currentlyArchived(channel.id))) {
    return skipped('channel_is_not_archived')
  }

  await db()
    .insertInto('channelUnarchivings')
    .values({ channelId: channel.id, id: newId() })
    .execute()

  return { channelId: channel.id, outcome: 'recorded' as const }
})

const reconcileThreadArchivings = applySchema(
  reconcileThreadArchivingsSchema,
  ingestionContextSchema
)(async ({ activeThreadDiscordChannelIds }, context) => {
  const threads = await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(
      latestChannelThreadFlags(),
      'channelThreadFlags.channelId',
      'channels.id'
    )
    .leftJoin(
      latestChannelArchivedStates(),
      'channelArchivedStates.channelId',
      'channels.id'
    )
    .select([
      'channels.id',
      'channels.discordChannelId',
      'channelArchivedStates.archived',
    ])
    .where('guilds.discordGuildId', '=', context.owner.guildId)
    .where('channelThreadFlags.isThread', '=', 1)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('channelRemovals')
            .select('channelRemovals.id')
            .whereRef('channelRemovals.channelId', '=', 'channels.id')
        )
      )
    )
    .orderBy('channels.createdAt', 'asc')
    .orderBy('channels.discordChannelId', 'asc')
    .orderBy('channels.id', 'asc')
    .execute()

  const stillActive = new Set(activeThreadDiscordChannelIds)
  const archivedChannelIds = threads
    .filter(
      (thread) =>
        thread.archived !== 1 && !stillActive.has(thread.discordChannelId)
    )
    .map((thread) => thread.id)
  const unarchivedChannelIds = threads
    .filter(
      (thread) =>
        thread.archived === 1 && stillActive.has(thread.discordChannelId)
    )
    .map((thread) => thread.id)

  if (archivedChannelIds.length === 0 && unarchivedChannelIds.length === 0) {
    return { archivedChannelIds, unarchivedChannelIds }
  }

  await db()
    .transaction()
    .execute(async (trx) => {
      if (archivedChannelIds.length > 0) {
        await trx
          .insertInto('channelArchivings')
          .values(
            archivedChannelIds.map((channelId) => ({ channelId, id: newId() }))
          )
          .execute()
      }

      if (unarchivedChannelIds.length > 0) {
        await trx
          .insertInto('channelUnarchivings')
          .values(
            unarchivedChannelIds.map((channelId) => ({
              channelId,
              id: newId(),
            }))
          )
          .execute()
      }
    })

  return { archivedChannelIds, unarchivedChannelIds }
})

const recordOwnerBookmarkReaction = applySchema(
  recordMessageReactionSchema,
  bookmarkReactionContextSchema
)(async ({ discordMessageId, emoji, reactorDiscordUserId }, context) => {
  if (reactorDiscordUserId !== context.owner.discordUserId) {
    return skipped('reactor_is_not_the_owner')
  }

  if (renderEmoji(emoji) !== bookmarkReactionEmoji) {
    return skipped('emoji_is_not_the_bookmark_reaction')
  }

  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  await db()
    .insertInto('bookmarkAdditions')
    .values({ id: newId(), messageId: message.id, source: 'reaction' })
    .execute()

  return { messageId: message.id, outcome: 'recorded' as const }
})

const recordOwnerBookmarkReactionRemoval = applySchema(
  recordMessageReactionSchema,
  bookmarkReactionContextSchema
)(async ({ discordMessageId, emoji, reactorDiscordUserId }, context) => {
  if (reactorDiscordUserId !== context.owner.discordUserId) {
    return skipped('reactor_is_not_the_owner')
  }

  if (renderEmoji(emoji) !== bookmarkReactionEmoji) {
    return skipped('emoji_is_not_the_bookmark_reaction')
  }

  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  await db()
    .insertInto('bookmarkRemovals')
    .values({ id: newId(), messageId: message.id, source: 'reaction' })
    .execute()

  return { messageId: message.id, outcome: 'recorded' as const }
})

function standingReactionsOf(messageId: string) {
  const reactionEvents = db()
    .selectFrom('messageReactionAdditions')
    .select([
      'id',
      'emoji',
      'reactorDiscordUserId',
      'createdAt',
      sql<number>`1`.as('reacted'),
    ])
    .where('messageId', '=', messageId)
    .unionAll(
      db()
        .selectFrom('messageReactionRemovals')
        .select([
          'id',
          'emoji',
          'reactorDiscordUserId',
          'createdAt',
          sql<number>`0`.as('reacted'),
        ])
        .where('messageId', '=', messageId)
    )

  const ranked = db()
    .selectFrom(reactionEvents.as('reactionEvents'))
    .select((eb) => [
      'emoji',
      'reactorDiscordUserId',
      'reacted',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy(['emoji', 'reactorDiscordUserId'])
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedReactionEvents')

  return db()
    .selectFrom(ranked)
    .select(['emoji', 'reactorDiscordUserId'])
    .where('rowNumber', '=', 1)
    .where('reacted', '=', 1)
    .orderBy('emoji', 'asc')
    .orderBy('reactorDiscordUserId', 'asc')
}

const recordMessageReaction = applySchema(
  recordMessageReactionSchema,
  ingestionContextSchema
)(async ({ discordMessageId, emoji, reactorDiscordUserId }, context) => {
  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  await db()
    .insertInto('messageReactionAdditions')
    .values({
      emoji: renderEmoji(emoji),
      id: newId(),
      messageId: message.id,
      reactorDiscordUserId,
    })
    .execute()

  return { messageId: message.id, outcome: 'recorded' as const }
})

const recordMessageReactionRemoval = applySchema(
  recordMessageReactionSchema,
  ingestionContextSchema
)(async ({ discordMessageId, emoji, reactorDiscordUserId }, context) => {
  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  await db()
    .insertInto('messageReactionRemovals')
    .values({
      emoji: renderEmoji(emoji),
      id: newId(),
      messageId: message.id,
      reactorDiscordUserId,
    })
    .execute()

  return { messageId: message.id, outcome: 'recorded' as const }
})

const recordMessageReactionClearing = applySchema(
  recordMessageReactionClearingSchema,
  ingestionContextSchema
)(async ({ discordMessageId, emoji }, context) => {
  const message = await findIngestedMessage(
    discordMessageId,
    context.owner.guildId
  )

  if (!message) return skipped('message_not_ingested')

  const standing = standingReactionsOf(message.id)
  const cleared = await (emoji
    ? standing.where('emoji', '=', renderEmoji(emoji))
    : standing
  ).execute()

  if (cleared.length > 0) {
    await db()
      .insertInto('messageReactionRemovals')
      .values(
        cleared.map((reaction) => ({
          emoji: reaction.emoji,
          id: newId(),
          messageId: message.id,
          reactorDiscordUserId: reaction.reactorDiscordUserId,
        }))
      )
      .execute()
  }

  return {
    clearedReactionCount: cleared.length,
    messageId: message.id,
    outcome: 'recorded' as const,
  }
})

function newestBackfillCursor(channelId: string) {
  return db()
    .selectFrom('messages')
    .select('discordMessageId')
    .where('channelId', '=', channelId)
    .orderBy('discordCreatedAt', 'desc')
    .orderBy(sql`cast(discord_message_id as integer)`, 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
}

function bySnowflake(one: string, other: string) {
  if (BigInt(one) === BigInt(other)) return 0

  return BigInt(one) < BigInt(other) ? -1 : 1
}

function lastMessageOfPage(page: BackfilledMessage[]) {
  return [...page].sort(
    (one, other) =>
      one.discordCreatedAt.localeCompare(other.discordCreatedAt) ||
      bySnowflake(one.discordMessageId, other.discordMessageId)
  )[page.length - 1]
}

async function insertMessageReactions(
  trx: Transaction<DB>,
  messageId: string,
  reactions: BackfilledMessage['reactions']
) {
  const rows = reactions.flatMap(({ emoji, reactorDiscordUserIds }) =>
    reactorDiscordUserIds.map((reactorDiscordUserId) => ({
      emoji: renderEmoji(emoji),
      id: newId(),
      messageId,
      reactorDiscordUserId,
    }))
  )

  if (rows.length === 0) return

  await trx.insertInto('messageReactionAdditions').values(rows).execute()
}

async function storeBackfilledPage(
  channelId: string,
  page: BackfilledMessage[]
) {
  return await db()
    .transaction()
    .execute(async (trx) => {
      let storedMessageCount = 0

      for (const message of page) {
        const member = await findOrCreateMember(trx, message.author)
        const stored = await insertMessageWithFirstRevision(trx, {
          attachments: message.attachments,
          authorMemberId: member.id,
          channelId,
          content: message.content,
          discordCreatedAt: message.discordCreatedAt,
          discordMessageId: message.discordMessageId,
          embeds: message.embeds,
          mentionedDiscordUserIds: message.mentionedDiscordUserIds,
        })

        if (stored.outcome !== 'recorded') continue

        storedMessageCount += 1

        await insertMessageReactions(trx, stored.messageId, message.reactions)
      }

      return storedMessageCount
    })
}

const runChannelBackfill = applySchema(
  runChannelBackfillSchema,
  ingestionContextSchema
)(async ({ channelId, fetchChannelHistory }, context) => {
  const channel = await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .select(['channels.discordChannelId', 'channels.id'])
    .where('channels.id', '=', channelId)
    .where('guilds.discordGuildId', '=', context.owner.guildId)
    .executeTakeFirst()

  if (!channel) {
    throw new InputError(
      'No channel with that id has been ingested. List the channels to pick one.',
      ['channelId']
    )
  }

  const run = await db()
    .insertInto('backfillRuns')
    .values({ channelId: channel.id, id: newId() })
    .returning('id')
    .executeTakeFirstOrThrow()

  let fetchedMessageCount = 0
  let storedMessageCount = 0
  let reachedTheNewestMessage = false

  try {
    const cursor = await newestBackfillCursor(channel.id)
    let afterDiscordMessageId =
      cursor?.discordMessageId ?? discordHistoryBeginningSnowflake

    for (let page = 0; page < backfillPageLimit; page += 1) {
      const messages = await fetchChannelHistory({
        afterDiscordMessageId,
        discordChannelId: channel.discordChannelId,
        limit: backfillPageSize,
      })

      if (messages.length === 0) {
        reachedTheNewestMessage = true
        break
      }

      fetchedMessageCount += messages.length
      storedMessageCount += await storeBackfilledPage(channel.id, messages)

      await db()
        .insertInto('backfillRunProgress')
        .values({
          backfillRunId: run.id,
          fetchedMessageCount,
          id: newId(),
          storedMessageCount,
        })
        .execute()

      const nextCursor = lastMessageOfPage(messages).discordMessageId

      if (nextCursor === afterDiscordMessageId) {
        reachedTheNewestMessage = true
        break
      }

      afterDiscordMessageId = nextCursor

      if (messages.length < backfillPageSize) {
        reachedTheNewestMessage = true
        break
      }
    }
  } catch (error) {
    await db()
      .insertInto('backfillRunFailures')
      .values({
        backfillRunId: run.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        id: newId(),
      })
      .execute()

    throw error
  }

  if (!reachedTheNewestMessage) {
    await db()
      .insertInto('backfillRunFailures')
      .values({
        backfillRunId: run.id,
        errorMessage: pageLimitReachedMessage,
        id: newId(),
      })
      .execute()

    return {
      backfillRunId: run.id,
      fetchedMessageCount,
      outcome: 'stopped_at_the_page_limit' as const,
      storedMessageCount,
    }
  }

  await db()
    .insertInto('backfillRunCompletions')
    .values({
      backfillRunId: run.id,
      fetchedMessageCount,
      id: newId(),
      storedMessageCount,
    })
    .execute()

  return {
    backfillRunId: run.id,
    fetchedMessageCount,
    outcome: 'completed' as const,
    storedMessageCount,
  }
})

const listBackfillableChannelsSchema = z.object({})

const listBackfillableChannels = applySchema(
  listBackfillableChannelsSchema,
  ingestionContextSchema
)(async (_input, context) => {
  return await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .leftJoin(
      latestChannelArchivedStates(),
      'channelArchivedStates.channelId',
      'channels.id'
    )
    .select('channels.id')
    .where('guilds.discordGuildId', '=', context.owner.guildId)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('channelRemovals')
            .select('channelRemovals.id')
            .whereRef('channelRemovals.channelId', '=', 'channels.id')
        )
      )
    )
    .where((eb) =>
      eb.or([
        eb('channelArchivedStates.archived', 'is', null),
        eb('channelArchivedStates.archived', '=', 0),
        eb.not(
          eb.exists(
            eb
              .selectFrom('backfillRuns')
              .select('backfillRuns.id')
              .whereRef('backfillRuns.channelId', '=', 'channels.id')
              .whereRef(
                'backfillRuns.createdAt',
                '>',
                'channelArchivedStates.createdAt'
              )
          )
        ),
      ])
    )
    .orderBy('channels.createdAt', 'asc')
    .orderBy('channels.discordChannelId', 'asc')
    .orderBy('channels.id', 'asc')
    .execute()
})

const backfillChannel = makeJob(
  'backfillChannel',
  async ({
    channelId,
    fetchChannelHistory,
  }: {
    channelId: string
    fetchChannelHistory: FetchChannelHistory
  }) => {
    await fromSuccess(runChannelBackfill)(
      { channelId, fetchChannelHistory },
      ownerContext()
    )
  }
)

const beatGatewayHeartbeat = makeCronJob(
  'beatGatewayHeartbeat',
  gatewayHeartbeatIntervalMinutes * 60_000,
  async () => {
    await fromSuccess(recordGatewayHeartbeat)({}, ownerContext())
  }
)

const backfillIngestedChannels = makeJob(
  'backfillIngestedChannels',
  async ({
    fetchChannelHistory,
  }: {
    fetchChannelHistory: FetchChannelHistory
  }) => {
    const channels = await fromSuccess(listBackfillableChannels)(
      {},
      ownerContext()
    )

    for (const channel of channels) {
      backfillChannel.enqueue({ channelId: channel.id, fetchChannelHistory })
    }
  },
  { dedupe: true }
)

export {
  backfillChannel,
  backfillIngestedChannels,
  beatGatewayHeartbeat,
  listBackfillableChannels,
  listBackfillableChannelsSchema,
  reconcileThreadArchivings,
  reconcileThreadArchivingsSchema,
  recordChannelArchiving,
  recordChannelArchivingSchema,
  recordChannelRemoval,
  recordChannelRemovalSchema,
  recordChannelSnapshot,
  recordChannelSnapshotSchema,
  recordChannelUnarchiving,
  recordChannelUnarchivingSchema,
  recordGatewayConnection,
  recordGatewayConnectionSchema,
  recordGatewayDisconnection,
  recordGatewayDisconnectionSchema,
  recordGatewayHeartbeat,
  recordGatewayHeartbeatSchema,
  recordIncomingMessage,
  recordIncomingMessageSchema,
  recordMessageDeletion,
  recordMessageDeletionSchema,
  recordMessageEdit,
  recordMessageEditSchema,
  recordMessageReaction,
  recordMessageReactionClearing,
  recordMessageReactionClearingSchema,
  recordMessageReactionRemoval,
  recordMessageReactionSchema,
  recordOwnerBookmarkReaction,
  recordOwnerBookmarkReactionRemoval,
  runChannelBackfill,
  runChannelBackfillSchema,
}
