import { randomBytes, randomUUID } from 'node:crypto'
import { ownerCaps } from '~/business/auth.server'
import type {
  ObservedAttachment,
  ObservedReplyReference,
} from '~/business/messages.common'
import { db } from '~/db/db.server'
import { env } from '~/env.server'
import { newId } from '~/framework/db.server'

type ChannelAttributes = {
  guildId?: string
  name?: string
  topic?: string
  category?: string
  isThread?: number
  position?: number
  archived?: boolean
}

type MemberAttributes = {
  discordUserId?: string
  username?: string
  displayName?: string
}

type GatewayIdentificationAttributes = {
  guildId: string
  botDiscordUserId?: string
  identifiedAt?: string
}

type MessageAttributes = {
  channelId?: string
  authorMemberId?: string
  content?: string
  discordMessageId?: string
  discordCreatedAt?: string
  recordedAt?: string
  mentionedDiscordUserIds?: string[]
  embeds?: string[]
  attachments?: ObservedAttachment[]
  repliedTo?: ObservedReplyReference
}

type BookmarkedMessageAttributes = MessageAttributes & {
  source?: 'reaction' | 'mcp'
  bookmarkedAt?: string
}

type MessageReactionAttributes = {
  messageId: string
  emoji?: string
  reactorDiscordUserId?: string
  reactedAt?: string
}

type BusyGuildAttributes = {
  channelCount?: number
  memberCount?: number
  messageCount?: number
}

type BusyChannelHistoryAttributes = {
  channelIds: string[]
  runsPerChannel?: number
}

type OwnerContextAttributes = {
  guildId?: string
  discordUserId?: string
}

const smallestSnowflake = 100000000000000000n
const snowflakeRange = 900000000000000000n

function snowflake() {
  const entropy = randomBytes(8).readBigUInt64BE() % snowflakeRange

  return (smallestSnowflake + entropy).toString()
}

async function createGuild() {
  return await db()
    .insertInto('guilds')
    .values({ id: newId(), discordGuildId: snowflake() })
    .returningAll()
    .executeTakeFirstOrThrow()
}

async function configuredGuild() {
  const discordGuildId = env().discordGuildId

  await db()
    .insertInto('guilds')
    .values({ id: newId(), discordGuildId })
    .onConflict((oc) => oc.doNothing())
    .execute()

  return await db()
    .selectFrom('guilds')
    .selectAll()
    .where('discordGuildId', '=', discordGuildId)
    .executeTakeFirstOrThrow()
}

async function createChannel({
  guildId,
  name = `channel-${randomUUID()}`,
  topic,
  category,
  isThread = 0,
  position,
  archived = false,
}: ChannelAttributes = {}) {
  const resolvedGuildId = guildId ?? (await createGuild()).id

  return await db()
    .transaction()
    .execute(async (trx) => {
      const channel = await trx
        .insertInto('channels')
        .values({
          id: newId(),
          guildId: resolvedGuildId,
          discordChannelId: snowflake(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('channelDetailRevisions')
        .values({ id: newId(), channelId: channel.id, name, isThread })
        .execute()

      if (topic !== undefined) {
        await trx
          .insertInto('channelTopicChanges')
          .values({ id: newId(), channelId: channel.id, topic })
          .execute()
      }

      if (category !== undefined) {
        await trx
          .insertInto('channelCategoryChanges')
          .values({ id: newId(), channelId: channel.id, category })
          .execute()
      }

      if (position !== undefined) {
        await trx
          .insertInto('channelPositionChanges')
          .values({ id: newId(), channelId: channel.id, position })
          .execute()
      }

      if (archived) {
        await trx
          .insertInto('channelArchivings')
          .values({ id: newId(), channelId: channel.id })
          .execute()
      }

      return channel
    })
}

async function createGatewayIdentification({
  guildId,
  botDiscordUserId = snowflake(),
  identifiedAt,
}: GatewayIdentificationAttributes) {
  return await db()
    .insertInto('gatewayIdentifications')
    .values({
      id: newId(),
      guildId,
      botDiscordUserId,
      ...(identifiedAt === undefined ? {} : { createdAt: identifiedAt }),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

async function createMember({
  discordUserId = snowflake(),
  username = `username-${randomUUID()}`,
  displayName = `display-name-${randomUUID()}`,
}: MemberAttributes = {}) {
  return await db()
    .transaction()
    .execute(async (trx) => {
      const member = await trx
        .insertInto('members')
        .values({ id: newId(), discordUserId })
        .returningAll()
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('memberDetailRevisions')
        .values({ id: newId(), memberId: member.id, username, displayName })
        .execute()

      return member
    })
}

async function createMessage({
  channelId,
  authorMemberId,
  content = `content-${randomUUID()}`,
  discordMessageId = snowflake(),
  discordCreatedAt = new Date().toISOString(),
  recordedAt,
  mentionedDiscordUserIds = [],
  embeds = [],
  attachments = [],
  repliedTo,
}: MessageAttributes = {}) {
  const resolvedChannelId = channelId ?? (await createChannel()).id
  const resolvedAuthorMemberId = authorMemberId ?? (await createMember()).id

  return await db()
    .transaction()
    .execute(async (trx) => {
      const message = await trx
        .insertInto('messages')
        .values({
          id: newId(),
          channelId: resolvedChannelId,
          authorMemberId: resolvedAuthorMemberId,
          discordMessageId,
          discordCreatedAt,
          ...(recordedAt === undefined ? {} : { createdAt: recordedAt }),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      const revision = await trx
        .insertInto('messageRevisions')
        .values({ id: newId(), messageId: message.id, content })
        .returning('id')
        .executeTakeFirstOrThrow()

      if (mentionedDiscordUserIds.length > 0) {
        await trx
          .insertInto('messageRevisionUserMentions')
          .values(
            mentionedDiscordUserIds.map((mentionedDiscordUserId) => ({
              id: newId(),
              mentionedDiscordUserId,
              messageRevisionId: revision.id,
            }))
          )
          .execute()
      }

      if (embeds.length > 0) {
        await trx
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
      }

      if (attachments.length > 0) {
        await trx
          .insertInto('messageRevisionAttachments')
          .values(
            attachments.map(({ filename, size, url }, position) => ({
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

      if (repliedTo) {
        await trx
          .insertInto('messageReplyReferences')
          .values({
            id: newId(),
            messageId: message.id,
            repliedToDiscordChannelId: repliedTo.discordChannelId,
            repliedToDiscordGuildId: repliedTo.discordGuildId,
            repliedToDiscordMessageId: repliedTo.discordMessageId,
          })
          .execute()
      }

      return message
    })
}

async function createBookmarkedMessage({
  source = 'reaction',
  bookmarkedAt,
  ...messageAttributes
}: BookmarkedMessageAttributes = {}) {
  const message = await createMessage(messageAttributes)

  await db()
    .insertInto('bookmarkAdditions')
    .values({
      id: newId(),
      messageId: message.id,
      source,
      ...(bookmarkedAt === undefined ? {} : { createdAt: bookmarkedAt }),
    })
    .execute()

  return message
}

async function createMessageReaction({
  messageId,
  emoji = '👍',
  reactorDiscordUserId = snowflake(),
  reactedAt,
}: MessageReactionAttributes) {
  return await db()
    .insertInto('messageReactionAdditions')
    .values({
      id: newId(),
      messageId,
      emoji,
      reactorDiscordUserId,
      ...(reactedAt === undefined ? {} : { createdAt: reactedAt }),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

async function createMessageReactionRemoval({
  messageId,
  emoji = '👍',
  reactorDiscordUserId = snowflake(),
  reactedAt,
}: MessageReactionAttributes) {
  return await db()
    .insertInto('messageReactionRemovals')
    .values({
      id: newId(),
      messageId,
      emoji,
      reactorDiscordUserId,
      ...(reactedAt === undefined ? {} : { createdAt: reactedAt }),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

const busyGuildOpenedAt = Date.UTC(2031, 0, 1)
const minutesBetweenBusyGuildMessages = 37

function busyGuildInstant(minutes: number) {
  return new Date(busyGuildOpenedAt + minutes * 60_000).toISOString()
}

function inBatches<Row>(rows: Row[], size = 1000) {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) =>
    rows.slice(index * size, (index + 1) * size)
  )
}

async function createBusyGuild({
  channelCount = 120,
  memberCount = 12,
  messageCount = 24_000,
}: BusyGuildAttributes = {}) {
  const guild = await createGuild()
  const ownerDiscordUserId = snowflake()

  const channels = Array.from({ length: channelCount }, () => ({
    id: newId(),
    guildId: guild.id,
    discordChannelId: snowflake(),
  }))
  const channelDetailRevisions = channels.flatMap((channel, index) => [
    {
      id: newId(),
      channelId: channel.id,
      name: `channel-${index}`,
      isThread: 0,
      createdAt: busyGuildInstant(-1440),
    },
    ...(index % 10 === 0
      ? [
          {
            id: newId(),
            channelId: channel.id,
            name: `renamed-channel-${index}`,
            isThread: 0,
            createdAt: busyGuildInstant(index * 60),
          },
        ]
      : []),
  ])

  const members = Array.from({ length: memberCount }, () => ({
    id: newId(),
    discordUserId: snowflake(),
  }))
  const memberDetailRevisions = members.flatMap((member, index) =>
    [0, 1, 2].map((take) => ({
      id: newId(),
      memberId: member.id,
      username: `member-${index}`,
      displayName: `Member ${index}, take ${take}`,
      createdAt: busyGuildInstant(take * 100_000 - 1440),
    }))
  )

  const messages = Array.from({ length: messageCount }, (_, index) => ({
    id: newId(),
    channelId: channels[(index * 7919) % channelCount].id,
    authorMemberId: members[index % memberCount].id,
    discordMessageId: snowflake(),
    discordCreatedAt: busyGuildInstant(index * minutesBetweenBusyGuildMessages),
  }))
  const messageRevisions = messages.flatMap((message, index) => {
    const content =
      index % 50 === 0
        ? `<@${ownerDiscordUserId}> message ${index}`
        : `message ${index}`

    return [
      {
        id: newId(),
        messageId: message.id,
        content,
        createdAt: message.discordCreatedAt,
      },
      ...(index % 25 === 0
        ? [
            {
              id: newId(),
              messageId: message.id,
              content: `${content}, edited`,
              createdAt: busyGuildInstant(
                index * minutesBetweenBusyGuildMessages + 5
              ),
            },
          ]
        : []),
    ]
  })
  const messageRevisionUserMentions = messageRevisions
    .filter(({ content }) => content.startsWith(`<@${ownerDiscordUserId}>`))
    .map((revision) => ({
      id: newId(),
      messageRevisionId: revision.id,
      mentionedDiscordUserId: ownerDiscordUserId,
    }))
  const messageDeletions = messages
    .filter((_, index) => index % 97 === 0)
    .map((message) => ({ id: newId(), messageId: message.id }))
  const botDiscordUserId = snowflake()
  const gatewayIdentifications = Array.from(
    { length: Math.ceil(messageCount / 80) },
    (_, index) => ({
      id: newId(),
      guildId: guild.id,
      botDiscordUserId,
      createdAt: busyGuildInstant(index * 80 * minutesBetweenBusyGuildMessages),
    })
  )

  await db()
    .transaction()
    .execute(async (trx) => {
      await trx.insertInto('channels').values(channels).execute()
      await trx
        .insertInto('channelDetailRevisions')
        .values(channelDetailRevisions)
        .execute()
      await trx.insertInto('members').values(members).execute()
      await trx
        .insertInto('memberDetailRevisions')
        .values(memberDetailRevisions)
        .execute()

      for (const batch of inBatches(messages)) {
        await trx.insertInto('messages').values(batch).execute()
      }

      for (const batch of inBatches(messageRevisions)) {
        await trx.insertInto('messageRevisions').values(batch).execute()
      }

      await trx
        .insertInto('messageRevisionUserMentions')
        .values(messageRevisionUserMentions)
        .execute()
      await trx
        .insertInto('messageDeletions')
        .values(messageDeletions)
        .execute()
      await trx
        .insertInto('gatewayIdentifications')
        .values(gatewayIdentifications)
        .execute()
    })

  return {
    channelIds: channels.map(({ id }) => id),
    messageIds: messages.map(({ id }) => id),
    context: await ownerContext({
      guildId: guild.id,
      discordUserId: ownerDiscordUserId,
    }),
    firstMessageAt: busyGuildInstant(0),
    lastMessageAt: busyGuildInstant(
      (messageCount - 1) * minutesBetweenBusyGuildMessages
    ),
  }
}

async function createBusyBookmarks({
  messageIds,
  reasonCount = 6,
}: {
  messageIds: string[]
  reasonCount?: number
}) {
  const reasons = Array.from({ length: reasonCount }, () => ({ id: newId() }))
  const reasonDetailRevisions = reasons.flatMap((reason, index) =>
    [0, 1].map((take) => ({
      id: newId(),
      reasonId: reason.id,
      name: `busy reason ${index}, take ${take}`,
      description: `What busy reason ${index} is for`,
      createdAt: busyGuildInstant(take * 1440),
    }))
  )

  const bookmarked = messageIds
    .map((messageId, index) => ({
      messageId,
      minutes: index * minutesBetweenBusyGuildMessages,
    }))
    .filter((_, index) => index % 20 === 0)
  const bookmarkAdditions = bookmarked.flatMap(
    ({ messageId, minutes }, index) => [
      {
        id: newId(),
        messageId,
        source: index % 2 === 0 ? 'reaction' : 'mcp',
        createdAt: busyGuildInstant(minutes + 10),
      },
      ...(index % 9 === 0
        ? [
            {
              id: newId(),
              messageId,
              source: 'mcp',
              createdAt: busyGuildInstant(minutes + 30),
            },
          ]
        : []),
    ]
  )
  const bookmarkRemovals = bookmarked
    .filter((_, index) => index % 3 === 0)
    .map(({ messageId, minutes }, index) => ({
      id: newId(),
      messageId,
      source: index % 2 === 0 ? 'reaction' : 'mcp',
      createdAt: busyGuildInstant(minutes + 20),
    }))
  const bookmarkReasonAssignments = bookmarked
    .filter((_, index) => index % 4 === 0)
    .flatMap(({ messageId, minutes }, index) =>
      [11, ...(index % 2 === 0 ? [12] : [])].map((offset) => ({
        id: newId(),
        messageId,
        reasonId: reasons[(index + offset) % reasonCount].id,
        createdAt: busyGuildInstant(minutes + offset),
      }))
    )
  const bookmarkSnoozes = bookmarked
    .filter((_, index) => index % 5 === 0)
    .map(({ messageId, minutes }, index) => ({
      id: newId(),
      messageId,
      until:
        index % 2 === 0
          ? '2020-01-01T00:00:00.000Z'
          : '2999-01-01T00:00:00.000Z',
      createdAt: busyGuildInstant(minutes + 13),
    }))

  await db()
    .transaction()
    .execute(async (trx) => {
      await trx.insertInto('bookmarkReasons').values(reasons).execute()
      await trx
        .insertInto('bookmarkReasonDetailRevisions')
        .values(reasonDetailRevisions)
        .execute()
      await trx
        .insertInto('bookmarkAdditions')
        .values(bookmarkAdditions)
        .execute()
      await trx
        .insertInto('bookmarkRemovals')
        .values(bookmarkRemovals)
        .execute()
      await trx
        .insertInto('bookmarkReasonAssignments')
        .values(bookmarkReasonAssignments)
        .execute()
      await trx.insertInto('bookmarkSnoozes').values(bookmarkSnoozes).execute()
    })

  return { reasonIds: reasons.map(({ id }) => id) }
}

async function createBusyChannelHistory({
  channelIds,
  runsPerChannel = 40,
}: BusyChannelHistoryAttributes) {
  const channels = await db()
    .selectFrom('channels')
    .select(['id', 'discordChannelId'])
    .where('id', 'in', channelIds)
    .execute()
  const discordChannelIdOf = (channelId: string) => {
    const channel = channels.find(({ id }) => id === channelId)

    if (!channel) throw new Error(`No busy guild channel ${channelId}`)

    return channel.discordChannelId
  }
  const eventAt = (channelIndex: number, step: number) =>
    busyGuildInstant(channelIndex * 60 + step)

  const backfillRuns = channelIds.flatMap((channelId, channelIndex) =>
    Array.from({ length: runsPerChannel }, (_, runIndex) => ({
      id: newId(),
      channelId,
      createdAt: busyGuildInstant(runIndex * 1440 + channelIndex),
    }))
  )
  const backfillRunProgress = backfillRuns.flatMap((run) =>
    [1, 2].map((page) => ({
      id: newId(),
      backfillRunId: run.id,
      fetchedMessageCount: page * 100,
      storedMessageCount: page * 90,
      createdAt: run.createdAt,
    }))
  )
  const newestRuns = backfillRuns.filter(
    (_, index) => index % runsPerChannel === runsPerChannel - 1
  )
  const backfillRunCompletions = newestRuns
    .filter((_, channelIndex) => channelIndex % 3 === 0)
    .map((run) => ({
      id: newId(),
      backfillRunId: run.id,
      fetchedMessageCount: 200,
      storedMessageCount: 180,
    }))
  const backfillRunFailures = newestRuns
    .filter((_, channelIndex) => channelIndex % 3 === 1)
    .map((run) => ({
      id: newId(),
      backfillRunId: run.id,
      errorMessage: 'Missing Access',
    }))

  const channelTopicChanges = channelIds.flatMap((channelId, channelIndex) =>
    [0, ...(channelIndex % 2 === 0 ? [2] : [])].map((step) => ({
      id: newId(),
      channelId,
      topic: `topic ${channelIndex}, take ${step}`,
      createdAt: eventAt(channelIndex, step),
    }))
  )
  const channelTopicClearings = channelIds.map((channelId, channelIndex) => ({
    id: newId(),
    channelId,
    createdAt: eventAt(channelIndex, 1),
  }))
  const channelCategoryChanges = channelIds.flatMap((channelId, channelIndex) =>
    [0, 1].map((step) => ({
      id: newId(),
      channelId,
      category: `category ${channelIndex % 8}, take ${step}`,
      createdAt: eventAt(channelIndex, step),
    }))
  )
  const channelCategoryClearings = channelIds.flatMap(
    (channelId, channelIndex) =>
      channelIndex % 5 === 0
        ? [{ id: newId(), channelId, createdAt: eventAt(channelIndex, 2) }]
        : []
  )
  const channelPositionChanges = channelIds.flatMap((channelId, channelIndex) =>
    [0, 1].map((step) => ({
      id: newId(),
      channelId,
      position: channelIndex + step,
      createdAt: eventAt(channelIndex, step),
    }))
  )
  const channelPositionClearings = channelIds.flatMap(
    (channelId, channelIndex) =>
      channelIndex % 7 === 0
        ? [{ id: newId(), channelId, createdAt: eventAt(channelIndex, 2) }]
        : []
  )

  const threadIndexes = channelIds
    .map((_, channelIndex) => channelIndex)
    .filter((channelIndex) => channelIndex % 4 === 0)
  const threadDetailRevisions = threadIndexes.map((channelIndex) => ({
    id: newId(),
    channelId: channelIds[channelIndex],
    name: `thread-${channelIndex}`,
    isThread: 1,
    createdAt: eventAt(channelIndex, 30),
  }))
  const channelArchivings = threadIndexes.flatMap((channelIndex) =>
    [31, ...(channelIndex % 8 === 0 ? [33] : [])].map((step) => ({
      id: newId(),
      channelId: channelIds[channelIndex],
      createdAt: eventAt(channelIndex, step),
    }))
  )
  const channelUnarchivings = threadIndexes.map((channelIndex) => ({
    id: newId(),
    channelId: channelIds[channelIndex],
    createdAt: eventAt(channelIndex, 32),
  }))

  const messageSendRequests = channelIds.flatMap((channelId, channelIndex) =>
    [0, 1, 2, 3, 4].map((step) => ({
      id: newId(),
      channelId,
      content: `send ${channelIndex}, take ${step}`,
      createdAt: eventAt(channelIndex, 40 + step),
    }))
  )
  const sendsOf = (step: number) =>
    messageSendRequests.filter((_, index) => index % 5 === step)
  const messageSendDeliveries = [...sendsOf(0), ...sendsOf(4)].map(
    (request) => ({
      id: newId(),
      messageSendRequestId: request.id,
      discordMessageId: snowflake(),
      createdAt: request.createdAt,
    })
  )
  const messageSendFailures = [...sendsOf(1), ...sendsOf(3)].map((request) => ({
    id: newId(),
    messageSendRequestId: request.id,
    kind: 'unreachable',
    errorMessage: 'fetch failed',
    createdAt: request.createdAt,
  }))
  const messageSendSkips = sendsOf(2).map((request) => ({
    id: newId(),
    messageSendRequestId: request.id,
    reason: 'empty_content',
    createdAt: request.createdAt,
  }))
  const messageSendRequestRetries = sendsOf(4).map((request, index) => ({
    id: newId(),
    requestId: request.id,
    retriedRequestId: sendsOf(3)[index].id,
    createdAt: request.createdAt,
  }))

  await db()
    .transaction()
    .execute(async (trx) => {
      for (const batch of inBatches(backfillRuns)) {
        await trx.insertInto('backfillRuns').values(batch).execute()
      }

      for (const batch of inBatches(backfillRunProgress)) {
        await trx.insertInto('backfillRunProgress').values(batch).execute()
      }

      await trx
        .insertInto('backfillRunCompletions')
        .values(backfillRunCompletions)
        .execute()
      await trx
        .insertInto('backfillRunFailures')
        .values(backfillRunFailures)
        .execute()
      await trx
        .insertInto('channelTopicChanges')
        .values(channelTopicChanges)
        .execute()
      await trx
        .insertInto('channelTopicClearings')
        .values(channelTopicClearings)
        .execute()
      await trx
        .insertInto('channelCategoryChanges')
        .values(channelCategoryChanges)
        .execute()
      await trx
        .insertInto('channelCategoryClearings')
        .values(channelCategoryClearings)
        .execute()
      await trx
        .insertInto('channelPositionChanges')
        .values(channelPositionChanges)
        .execute()
      await trx
        .insertInto('channelPositionClearings')
        .values(channelPositionClearings)
        .execute()
      await trx
        .insertInto('channelDetailRevisions')
        .values(threadDetailRevisions)
        .execute()
      await trx
        .insertInto('channelArchivings')
        .values(channelArchivings)
        .execute()
      await trx
        .insertInto('channelUnarchivings')
        .values(channelUnarchivings)
        .execute()
      await trx
        .insertInto('messageSendRequests')
        .values(messageSendRequests)
        .execute()
      await trx
        .insertInto('messageSendDeliveries')
        .values(messageSendDeliveries)
        .execute()
      await trx
        .insertInto('messageSendFailures')
        .values(messageSendFailures)
        .execute()
      await trx
        .insertInto('messageSendSkips')
        .values(messageSendSkips)
        .execute()
      await trx
        .insertInto('messageSendRequestRetries')
        .values(messageSendRequestRetries)
        .execute()
    })

  return {
    activeThreadDiscordChannelIds: threadIndexes
      .filter((channelIndex) => channelIndex % 8 !== 0)
      .map((channelIndex) => discordChannelIdOf(channelIds[channelIndex])),
    archivedThreadDiscordChannelId: discordChannelIdOf(channelIds[0]),
    retriedRequestId: sendsOf(3)[0].id,
  }
}

async function ownerContext({
  guildId,
  discordUserId = snowflake(),
}: OwnerContextAttributes = {}) {
  const guild = guildId
    ? await db()
        .selectFrom('guilds')
        .select('discordGuildId')
        .where('id', '=', guildId)
        .executeTakeFirstOrThrow()
    : await configuredGuild()

  return {
    owner: { discordUserId, guildId: guild.discordGuildId },
    ...ownerCaps(),
  }
}

export {
  configuredGuild,
  createBookmarkedMessage,
  createBusyBookmarks,
  createBusyChannelHistory,
  createBusyGuild,
  createChannel,
  createGatewayIdentification,
  createGuild,
  createMember,
  createMessage,
  createMessageReaction,
  createMessageReactionRemoval,
  ownerContext,
  snowflake,
}
