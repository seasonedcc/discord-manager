import { InputError, applySchema } from 'composable-functions'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type MessageSendSkipReason,
  type MessageSendStatus,
  type MessageSendTransport,
  messageSendSkipCopy,
  messageSendStallThresholdMinutes,
  messageSendStatusCopy,
  readMessageSendStatusSchema,
  sendMessageSchema,
} from '~/business/sending.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

const sendingContextSchema = ownerContextSchema.extend({
  canSendMessages: z.literal(true),
})

function skipReasonFor({
  channel,
  content,
  guildId,
}: {
  channel: { discordGuildId: string; removed: number }
  content: string
  guildId: string
}): MessageSendSkipReason | null {
  if (channel.discordGuildId !== guildId) return 'channel_not_in_guild'
  if (channel.removed === 1) return 'channel_not_found'
  if (content.trim() === '') return 'empty_content'

  return null
}

function sendMessage(transport: MessageSendTransport) {
  return applySchema(
    sendMessageSchema,
    sendingContextSchema
  )(async ({ channelId, content, replyToMessageId }, context) => {
    const channel = await db()
      .selectFrom('channels')
      .innerJoin('guilds', 'guilds.id', 'channels.guildId')
      .where('channels.id', '=', channelId)
      .select((eb) => [
        'channels.id',
        'channels.discordChannelId',
        'guilds.discordGuildId',
        eb
          .exists(
            eb
              .selectFrom('channelRemovals')
              .select('channelRemovals.id')
              .whereRef('channelRemovals.channelId', '=', 'channels.id')
          )
          .$castTo<number>()
          .as('removed'),
      ])
      .executeTakeFirst()

    if (!channel) {
      throw new InputError(
        'No channel with that id has been ingested. List the channels to pick one.',
        ['channelId']
      )
    }

    const replyTarget = replyToMessageId
      ? await db()
          .selectFrom('messages')
          .select(['messages.id', 'messages.discordMessageId'])
          .where('messages.id', '=', replyToMessageId)
          .executeTakeFirst()
      : undefined

    if (replyToMessageId && !replyTarget) {
      throw new InputError(
        'No message with that id has been ingested, so there is nothing to reply to.',
        ['replyToMessageId']
      )
    }

    const request = await db()
      .transaction()
      .execute(async (trx) => {
        const row = await trx
          .insertInto('messageSendRequests')
          .values({ id: newId(), channelId: channel.id, content })
          .returning(['id', 'createdAt'])
          .executeTakeFirstOrThrow()

        if (replyTarget) {
          await trx
            .insertInto('messageSendRequestReplyTargets')
            .values({
              id: newId(),
              requestId: row.id,
              replyToMessageId: replyTarget.id,
            })
            .execute()
        }

        return row
      })

    const reason = skipReasonFor({
      channel,
      content,
      guildId: context.owner.guildId,
    })

    if (reason) {
      await db()
        .insertInto('messageSendSkips')
        .values({ id: newId(), messageSendRequestId: request.id, reason })
        .execute()

      return {
        send: {
          requestId: request.id,
          status: 'skipped' as const,
          reason,
          ...messageSendSkipCopy[reason],
        },
      }
    }

    try {
      const { discordMessageId } = await transport({
        content,
        discordChannelId: channel.discordChannelId,
        replyToDiscordMessageId: replyTarget?.discordMessageId ?? null,
      })

      await db()
        .insertInto('messageSendDeliveries')
        .values({
          id: newId(),
          messageSendRequestId: request.id,
          discordMessageId,
        })
        .execute()

      return {
        send: {
          requestId: request.id,
          status: 'delivered' as const,
          discordMessageId,
          ...messageSendStatusCopy.delivered,
        },
      }
    } catch (error) {
      await db()
        .insertInto('messageSendFailures')
        .values({
          id: newId(),
          messageSendRequestId: request.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        .execute()

      return {
        send: {
          requestId: request.id,
          status: 'failed' as const,
          ...messageSendStatusCopy.failed,
        },
      }
    }
  })
}

const readMessageSendStatus = applySchema(
  readMessageSendStatusSchema,
  sendingContextSchema
)(async ({ requestId }, context) => {
  const outcomeEvents = db()
    .selectFrom('messageSendDeliveries')
    .select([
      'id',
      'messageSendRequestId',
      'createdAt',
      sql<MessageSendStatus>`'delivered'`.as('outcome'),
    ])
    .unionAll(
      db()
        .selectFrom('messageSendFailures')
        .select([
          'id',
          'messageSendRequestId',
          'createdAt',
          sql<MessageSendStatus>`'failed'`.as('outcome'),
        ])
    )
    .unionAll(
      db()
        .selectFrom('messageSendSkips')
        .select([
          'id',
          'messageSendRequestId',
          'createdAt',
          sql<MessageSendStatus>`'skipped'`.as('outcome'),
        ])
    )

  const rankedOutcomes = db()
    .selectFrom(outcomeEvents.as('outcomeEvents'))
    .select((eb) => [
      'messageSendRequestId',
      'outcome',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('messageSendRequestId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedOutcomes')

  const latestOutcomes = db()
    .selectFrom(rankedOutcomes)
    .select(['messageSendRequestId', 'outcome'])
    .where('rowNumber', '=', 1)
    .as('latestOutcomes')

  const rankedDeliveries = db()
    .selectFrom('messageSendDeliveries')
    .select((eb) => [
      'messageSendRequestId',
      'discordMessageId',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('messageSendRequestId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedDeliveries')

  const latestDeliveries = db()
    .selectFrom(rankedDeliveries)
    .select(['messageSendRequestId', 'discordMessageId'])
    .where('rowNumber', '=', 1)
    .as('latestDeliveries')

  const rankedSkips = db()
    .selectFrom('messageSendSkips')
    .select((eb) => [
      'messageSendRequestId',
      'reason',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('messageSendRequestId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedSkips')

  const latestSkips = db()
    .selectFrom(rankedSkips)
    .select(['messageSendRequestId', 'reason'])
    .where('rowNumber', '=', 1)
    .as('latestSkips')

  const row = await db()
    .selectFrom('messageSendRequests')
    .innerJoin('channels', 'channels.id', 'messageSendRequests.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .leftJoin(
      latestOutcomes,
      'latestOutcomes.messageSendRequestId',
      'messageSendRequests.id'
    )
    .leftJoin(
      latestDeliveries,
      'latestDeliveries.messageSendRequestId',
      'messageSendRequests.id'
    )
    .leftJoin(
      latestSkips,
      'latestSkips.messageSendRequestId',
      'messageSendRequests.id'
    )
    .where('messageSendRequests.id', '=', requestId)
    .where('guilds.discordGuildId', '=', context.owner.guildId)
    .select((eb) => [
      'messageSendRequests.id as requestId',
      'messageSendRequests.createdAt as requestedAt',
      'latestDeliveries.discordMessageId',
      eb
        .ref('latestSkips.reason')
        .$castTo<MessageSendSkipReason | null>()
        .as('reason'),
      sql<MessageSendStatus>`coalesce(
        latest_outcomes.outcome,
        case
          when message_send_requests.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ${`-${messageSendStallThresholdMinutes} minutes`})
          then 'stalled'
          else 'pending'
        end
      )`.as('status'),
    ])
    .executeTakeFirst()

  if (!row) {
    throw new InputError('No send with that request id was ever issued', [
      'requestId',
    ])
  }

  return {
    send: {
      ...row,
      ...(row.status === 'skipped' && row.reason
        ? messageSendSkipCopy[row.reason]
        : messageSendStatusCopy[row.status]),
    },
  }
})

export { readMessageSendStatus, sendMessage }
