import { InputError, applySchema } from 'composable-functions'
import { type ExpressionBuilder, type Kysely, sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type MessageSendFailureKind,
  type MessageSendSkipReason,
  type MessageSendStatus,
  type MessageSendTransport,
  TransportRejectedError,
  messageSendGuidance,
  messageSendLiveRisk,
  messageSendRetryChainRefusalCopy,
  messageSendRetryGround,
  messageSendRetryRefusalCopy,
  messageSendStallThresholdMinutes,
  readMessageSendStatusSchema,
  sendMessageSchema,
} from '~/business/sending.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'
import { newId } from '~/framework/db.server'

const sendingContextSchema = ownerContextSchema.extend({
  canSendMessages: z.literal(true),
})

function jumpUrl({
  discordChannelId,
  discordGuildId,
  discordMessageId,
}: {
  discordChannelId: string
  discordGuildId: string
  discordMessageId: string
}) {
  return `https://discord.com/channels/${discordGuildId}/${discordChannelId}/${discordMessageId}`
}

function failureKindOf(error: unknown): MessageSendFailureKind {
  return error instanceof TransportRejectedError ? 'rejected' : 'unreachable'
}

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

function latestOutcomeOf(eb: ExpressionBuilder<DB, 'messageSendRequests'>) {
  return eb
    .selectFrom(
      eb
        .selectFrom('messageSendDeliveries')
        .select([
          sql<MessageSendStatus>`'delivered'`.as('outcome'),
          'messageSendDeliveries.createdAt',
          'messageSendDeliveries.id',
        ])
        .whereRef(
          'messageSendDeliveries.messageSendRequestId',
          '=',
          'messageSendRequests.id'
        )
        .unionAll(
          eb
            .selectFrom('messageSendFailures')
            .select([
              sql<MessageSendStatus>`'failed'`.as('outcome'),
              'messageSendFailures.createdAt',
              'messageSendFailures.id',
            ])
            .whereRef(
              'messageSendFailures.messageSendRequestId',
              '=',
              'messageSendRequests.id'
            )
        )
        .unionAll(
          eb
            .selectFrom('messageSendSkips')
            .select([
              sql<MessageSendStatus>`'skipped'`.as('outcome'),
              'messageSendSkips.createdAt',
              'messageSendSkips.id',
            ])
            .whereRef(
              'messageSendSkips.messageSendRequestId',
              '=',
              'messageSendRequests.id'
            )
        )
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .as('latestOutcomes')
    )
    .select('latestOutcomes.outcome')
}

function latestDeliveryOf(eb: ExpressionBuilder<DB, 'messageSendRequests'>) {
  return eb
    .selectFrom('messageSendDeliveries')
    .select('messageSendDeliveries.id')
    .whereRef(
      'messageSendDeliveries.messageSendRequestId',
      '=',
      'messageSendRequests.id'
    )
    .orderBy('messageSendDeliveries.createdAt', 'desc')
    .orderBy('messageSendDeliveries.id', 'desc')
    .limit(1)
}

function latestFailureOf(eb: ExpressionBuilder<DB, 'messageSendRequests'>) {
  return eb
    .selectFrom('messageSendFailures')
    .select('messageSendFailures.id')
    .whereRef(
      'messageSendFailures.messageSendRequestId',
      '=',
      'messageSendRequests.id'
    )
    .orderBy('messageSendFailures.createdAt', 'desc')
    .orderBy('messageSendFailures.id', 'desc')
    .limit(1)
}

function latestSkipOf(eb: ExpressionBuilder<DB, 'messageSendRequests'>) {
  return eb
    .selectFrom('messageSendSkips')
    .select('messageSendSkips.id')
    .whereRef(
      'messageSendSkips.messageSendRequestId',
      '=',
      'messageSendRequests.id'
    )
    .orderBy('messageSendSkips.createdAt', 'desc')
    .orderBy('messageSendSkips.id', 'desc')
    .limit(1)
}

function messageSendStandings() {
  return db()
    .selectFrom('messageSendRequests')
    .leftJoin('messageSendDeliveries as latestDeliveries', (join) =>
      join.on((eb) => eb('latestDeliveries.id', '=', latestDeliveryOf(eb)))
    )
    .leftJoin('messageSendFailures as latestFailures', (join) =>
      join.on((eb) => eb('latestFailures.id', '=', latestFailureOf(eb)))
    )
    .leftJoin('messageSendSkips as latestSkips', (join) =>
      join.on((eb) => eb('latestSkips.id', '=', latestSkipOf(eb)))
    )
    .select((eb) => [
      'messageSendRequests.id as requestId',
      'messageSendRequests.createdAt as requestedAt',
      'messageSendRequests.channelId',
      'latestDeliveries.discordMessageId',
      eb
        .ref('latestFailures.kind')
        .$castTo<MessageSendFailureKind | null>()
        .as('kind'),
      eb
        .ref('latestSkips.reason')
        .$castTo<MessageSendSkipReason | null>()
        .as('reason'),
      eb.fn
        .coalesce(
          latestOutcomeOf(eb),
          sql<MessageSendStatus>`case
            when message_send_requests.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ${`-${messageSendStallThresholdMinutes} minutes`})
            then 'stalled'
            else 'pending'
          end`
        )
        .as('status'),
    ])
    .as('standings')
}

async function readRetrySafety(executor: Kysely<DB>, requestId: string) {
  const request = await executor
    .selectFrom(messageSendStandings())
    .select(['kind', 'reason', 'status'])
    .where('requestId', '=', requestId)
    .executeTakeFirst()

  if (!request) return undefined

  const retries = await executor
    .selectFrom('messageSendRequestRetries')
    .innerJoin(
      messageSendStandings(),
      'standings.requestId',
      'messageSendRequestRetries.requestId'
    )
    .where('messageSendRequestRetries.retriedRequestId', '=', requestId)
    .select(['standings.requestId', 'standings.kind', 'standings.status'])
    .orderBy('messageSendRequestRetries.createdAt', 'asc')
    .orderBy('messageSendRequestRetries.id', 'asc')
    .execute()

  const ground = messageSendRetryGround(request)
  const liveRetry = retries
    .map((retry) => messageSendLiveRisk(retry))
    .find((risk) => risk !== null)

  const chainRefusal =
    !ground && liveRetry ? messageSendRetryChainRefusalCopy[liveRetry] : null
  const refusal = ground ? messageSendRetryRefusalCopy[ground] : chainRefusal

  return {
    canRetry: refusal === null,
    chainRefusal,
    refusal,
    retries: retries.map(({ requestId, status }) => ({ requestId, status })),
  }
}

function sendMessage(transport: MessageSendTransport) {
  return applySchema(
    sendMessageSchema,
    sendingContextSchema
  )(
    async (
      { channelId, content, replyToMessageId, retryOfRequestId },
      context
    ) => {
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
            .select([
              'messages.id',
              'messages.channelId',
              'messages.discordMessageId',
            ])
            .where('messages.id', '=', replyToMessageId)
            .executeTakeFirst()
        : undefined

      if (replyToMessageId && !replyTarget) {
        throw new InputError(
          'No message with that id has been ingested, so there is nothing to reply to.',
          ['replyToMessageId']
        )
      }

      if (replyTarget && replyTarget.channelId !== channel.id) {
        throw new InputError(
          'That message is in a different channel, and Discord only attaches a reply to a message in the same channel. Send to the `channelId` that message came with, or leave out `replyToMessageId` to post on its own.',
          ['replyToMessageId']
        )
      }

      const request = await db()
        .transaction()
        .execute(async (trx) => {
          // This insert comes first so the transaction holds SQLite's write
          // lock from its opening statement. A transaction that reads before it
          // writes takes a snapshot instead, and its later writes fail outright
          // once the ingest daemon commits against the same file in between.
          const row = await trx
            .insertInto('messageSendRequests')
            .values({ id: newId(), channelId: channel.id, content })
            .returning(['id', 'createdAt'])
            .executeTakeFirstOrThrow()

          if (retryOfRequestId) {
            const safety = await readRetrySafety(trx, retryOfRequestId)

            if (!safety) {
              throw new InputError(
                'No send with that request id was ever issued, so there is nothing to retry.',
                ['retryOfRequestId']
              )
            }

            if (safety.refusal) {
              throw new InputError(safety.refusal, ['retryOfRequestId'])
            }

            await trx
              .insertInto('messageSendRequestRetries')
              .values({
                id: newId(),
                requestId: row.id,
                retriedRequestId: retryOfRequestId,
              })
              .execute()
          }

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
            requestedAt: request.createdAt,
            status: 'skipped' as const,
            reason,
            ...messageSendGuidance({ kind: null, reason, status: 'skipped' }),
          },
        }
      }

      let posted: { discordMessageId: string }

      try {
        posted = await transport({
          content,
          discordChannelId: channel.discordChannelId,
          replyToDiscordMessageId: replyTarget?.discordMessageId ?? null,
        })
      } catch (error) {
        const kind = failureKindOf(error)

        await db()
          .insertInto('messageSendFailures')
          .values({
            id: newId(),
            kind,
            messageSendRequestId: request.id,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          })
          .execute()

        return {
          send: {
            requestId: request.id,
            requestedAt: request.createdAt,
            status: 'failed' as const,
            ...messageSendGuidance({ kind, reason: null, status: 'failed' }),
          },
        }
      }

      await db()
        .insertInto('messageSendDeliveries')
        .values({
          id: newId(),
          messageSendRequestId: request.id,
          discordMessageId: posted.discordMessageId,
        })
        .execute()

      return {
        send: {
          requestId: request.id,
          requestedAt: request.createdAt,
          status: 'delivered' as const,
          discordMessageId: posted.discordMessageId,
          jumpUrl: jumpUrl({
            discordChannelId: channel.discordChannelId,
            discordGuildId: channel.discordGuildId,
            discordMessageId: posted.discordMessageId,
          }),
          ...messageSendGuidance({
            kind: null,
            reason: null,
            status: 'delivered',
          }),
        },
      }
    }
  )
}

const readMessageSendStatus = applySchema(
  readMessageSendStatusSchema,
  sendingContextSchema
)(async ({ requestId }) => {
  const retrySafety = await readRetrySafety(db(), requestId)

  if (!retrySafety) {
    throw new InputError('No send with that request id was ever issued', [
      'requestId',
    ])
  }

  const row = await db()
    .selectFrom(messageSendStandings())
    .innerJoin('channels', 'channels.id', 'standings.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .where('standings.requestId', '=', requestId)
    .select((eb) => [
      'standings.requestId',
      'standings.requestedAt',
      'standings.discordMessageId',
      'standings.kind',
      'standings.reason',
      'standings.status',
      'channels.discordChannelId',
      'guilds.discordGuildId',
      eb
        .selectFrom('messageSendRequestRetries')
        .select('messageSendRequestRetries.retriedRequestId')
        .whereRef(
          'messageSendRequestRetries.requestId',
          '=',
          'standings.requestId'
        )
        .orderBy('messageSendRequestRetries.createdAt', 'desc')
        .orderBy('messageSendRequestRetries.id', 'desc')
        .limit(1)
        .as('retryOfRequestId'),
    ])
    .executeTakeFirstOrThrow()

  const { discordChannelId, discordGuildId, ...send } = row
  const guidance = messageSendGuidance(row)

  return {
    send: {
      ...send,
      canRetry: retrySafety.canRetry,
      retries: retrySafety.retries,
      jumpUrl: send.discordMessageId
        ? jumpUrl({
            discordChannelId,
            discordGuildId,
            discordMessageId: send.discordMessageId,
          })
        : null,
      ...guidance,
      nextAction: retrySafety.chainRefusal ?? guidance.nextAction,
    },
  }
})

export { readMessageSendStatus, sendMessage }
