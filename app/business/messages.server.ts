import { InputError, applySchema } from 'composable-functions'
import { type Expression, type SqlBool, type Transaction, sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type MessageFetchFailureKind,
  MessageFetchGoneError,
  MessageFetchRejectedError,
  type MessageFetchTransport,
  countMessagesSchema,
  fetchMessageSchema,
  messageFetchGuidance,
  renderEmbed,
} from '~/business/messages.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'
import { newId } from '~/framework/db.server'

const messagesContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function failureKindOf(error: unknown): MessageFetchFailureKind {
  if (error instanceof MessageFetchGoneError) return 'gone'
  if (error instanceof MessageFetchRejectedError) return 'rejected'

  return 'unreachable'
}

async function recordObservedDeletion(trx: Transaction<DB>, messageId: string) {
  await trx
    .insertInto('messageDeletions')
    .columns(['id', 'messageId'])
    .expression((eb) =>
      eb
        .selectFrom('messages')
        .select([eb.val(newId()).as('id'), 'messages.id as messageId'])
        .where('messages.id', '=', messageId)
        .where(({ exists, not, selectFrom }) =>
          not(
            exists(
              selectFrom('messageDeletions')
                .select('messageDeletions.id')
                .whereRef('messageDeletions.messageId', '=', 'messages.id')
            )
          )
        )
    )
    .execute()
}

function fetchMessage(transport: MessageFetchTransport) {
  return applySchema(
    fetchMessageSchema,
    messagesContextSchema
  )(async ({ messageId }, context) => {
    const found = await db()
      .selectFrom('messages')
      .innerJoin('channels', 'channels.id', 'messages.channelId')
      .innerJoin('guilds', 'guilds.id', 'channels.guildId')
      .where('messages.id', '=', messageId)
      .where('guilds.discordGuildId', '=', context.owner.guildId)
      .select((eb) => [
        'messages.id as messageId',
        'messages.channelId',
        'messages.discordMessageId',
        'channels.discordChannelId',
        'guilds.discordGuildId',
        eb
          .exists(
            eb
              .selectFrom('messageDeletions')
              .select('messageDeletions.id')
              .whereRef('messageDeletions.messageId', '=', 'messages.id')
          )
          .$castTo<number>()
          .as('deleted'),
      ])
      .executeTakeFirst()

    if (!found) {
      throw new InputError(
        'No message with that id has been ingested. Catch up on a channel to pick one.',
        ['messageId']
      )
    }

    const { deleted, discordGuildId, ...message } = found
    const located = {
      ...message,
      jumpUrl: `https://discord.com/channels/${discordGuildId}/${message.discordChannelId}/${message.discordMessageId}`,
    }

    const request = await db()
      .insertInto('messageFetchRequests')
      .values({ id: newId(), messageId: message.messageId })
      .returning('id')
      .executeTakeFirstOrThrow()

    if (deleted === 1) {
      const reason = 'message_deleted' as const

      await db()
        .insertInto('messageFetchSkips')
        .values({ id: newId(), messageFetchRequestId: request.id, reason })
        .execute()

      return {
        message: {
          ...located,
          status: 'skipped' as const,
          reason,
          ...messageFetchGuidance({ reason, status: 'skipped' }),
        },
      }
    }

    let live: Awaited<ReturnType<MessageFetchTransport>>

    try {
      live = await transport({
        discordChannelId: message.discordChannelId,
        discordMessageId: message.discordMessageId,
      })
    } catch (error) {
      const kind = failureKindOf(error)

      await db()
        .transaction()
        .execute(async (trx) => {
          await trx
            .insertInto('messageFetchFailures')
            .values({
              id: newId(),
              kind,
              messageFetchRequestId: request.id,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            })
            .execute()

          if (kind === 'gone') {
            await recordObservedDeletion(trx, message.messageId)
          }
        })

      return {
        message: {
          ...located,
          status: 'failed' as const,
          ...messageFetchGuidance({ kind, status: 'failed' }),
        },
      }
    }

    const retrieval = await db()
      .insertInto('messageFetchRetrievals')
      .values({ id: newId(), messageFetchRequestId: request.id })
      .returning('createdAt')
      .executeTakeFirstOrThrow()

    return {
      message: {
        ...located,
        attachments: live.attachments,
        content: live.content,
        embeds: live.embeds.flatMap((embed) => {
          const text = renderEmbed(embed)

          return text ? [text] : []
        }),
        fetchedAt: retrieval.createdAt,
        reactions: live.reactions?.map(
          ({ count, emoji, reactorDiscordUserIds }) => ({
            count,
            emoji,
            ownerReacted: reactorDiscordUserIds.includes(
              context.owner.discordUserId
            ),
          })
        ),
        status: 'retrieved' as const,
        ...messageFetchGuidance({ status: 'retrieved' }),
      },
    }
  })
}

const dayBucket = sql<string>`substr(messages.discord_created_at, 1, 10)`

function carriesTheText(text: Expression<string>, wanted: string) {
  return sql<SqlBool>`instr(lower(${text}), lower(${wanted})) > 0`
}

function messagesMatching({
  channelId,
  contentContains,
  guildId,
  since,
  until,
}: {
  channelId: string | undefined
  contentContains: string | undefined
  guildId: string
  since: string | undefined
  until: string | undefined
}) {
  let matching = db()
    .with('latestRevisions', (qb) =>
      qb.selectFrom('messageRevisions').select((eb) => [
        'messageRevisions.id',
        'messageRevisions.messageId',
        'messageRevisions.content',
        eb.fn
          .agg<number>('row_number')
          .over((over) =>
            over
              .partitionBy('messageId')
              .orderBy('createdAt', 'desc')
              .orderBy('id', 'desc')
          )
          .as('rowNumber'),
      ])
    )
    .selectFrom('messages')
    .innerJoin('channels', 'channels.id', 'messages.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .where('guilds.discordGuildId', '=', guildId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('messageDeletions')
            .select('messageDeletions.id')
            .whereRef('messageDeletions.messageId', '=', 'messages.id')
        )
      )
    )

  if (channelId) {
    matching = matching.where('messages.channelId', '=', channelId)
  }

  if (since) {
    matching = matching.where('messages.discordCreatedAt', '>=', since)
  }

  if (until) {
    matching = matching.where('messages.discordCreatedAt', '<=', until)
  }

  if (contentContains) {
    matching = matching.where((eb) =>
      eb.exists(
        eb
          .selectFrom('latestRevisions')
          .select('latestRevisions.id')
          .whereRef('latestRevisions.messageId', '=', 'messages.id')
          .where('latestRevisions.rowNumber', '=', 1)
          .where((revision) =>
            revision.or([
              carriesTheText(
                revision.ref('latestRevisions.content'),
                contentContains
              ),
              revision.exists(
                revision
                  .selectFrom('messageRevisionEmbeds')
                  .select('messageRevisionEmbeds.id')
                  .whereRef(
                    'messageRevisionEmbeds.messageRevisionId',
                    '=',
                    'latestRevisions.id'
                  )
                  .where((embed) =>
                    carriesTheText(
                      embed.ref('messageRevisionEmbeds.content'),
                      contentContains
                    )
                  )
              ),
            ])
          )
      )
    )
  }

  return matching
}

const countMessages = applySchema(
  countMessagesSchema,
  messagesContextSchema
)(async ({ channelId, contentContains, groupBy, since, until }, context) => {
  if (channelId) {
    const channel = await db()
      .selectFrom('channels')
      .innerJoin('guilds', 'guilds.id', 'channels.guildId')
      .select('channels.id')
      .where('channels.id', '=', channelId)
      .where('guilds.discordGuildId', '=', context.owner.guildId)
      .executeTakeFirst()

    if (!channel) {
      throw new InputError(
        'No channel with that id has been ingested. List the channels to pick one.',
        ['channelId']
      )
    }
  }

  const matching = messagesMatching({
    channelId,
    contentContains,
    guildId: context.owner.guildId,
    since: since ? new Date(since).toISOString() : undefined,
    until: until ? new Date(until).toISOString() : undefined,
  })

  const counted = await matching
    .select((eb) => [
      eb.fn.count<number>('messages.id').distinct().as('total'),
      eb.fn.min<string | null>('messages.discordCreatedAt').as('oldestMatch'),
      eb.fn.max<string | null>('messages.discordCreatedAt').as('newestMatch'),
    ])
    .executeTakeFirstOrThrow()

  const days =
    groupBy === 'day'
      ? await matching
          .select((eb) => [
            dayBucket.as('date'),
            eb.fn.count<number>('messages.id').distinct().as('count'),
          ])
          .groupBy(dayBucket)
          .orderBy(dayBucket, 'asc')
          .execute()
      : undefined

  return { ...counted, days }
})

export { countMessages, fetchMessage }
