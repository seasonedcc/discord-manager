import { InputError, applySchema } from 'composable-functions'
import type { Transaction } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  ThreadCreateGoneError,
  ThreadCreateRejectedError,
  type ThreadCreateTransport,
  type ThreadCreationFailureKind,
  type ThreadCreationSkipReason,
  createThreadSchema,
  threadAutoArchiveMinutes,
  threadCreationGuidance,
} from '~/business/threads.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'
import { newId } from '~/framework/db.server'

const threadsContextSchema = ownerContextSchema.extend({
  canSendMessages: z.literal(true),
})

function jumpUrl({
  discordChannelId,
  discordGuildId,
}: {
  discordChannelId: string
  discordGuildId: string
}) {
  return `https://discord.com/channels/${discordGuildId}/${discordChannelId}`
}

function failureKindOf(error: unknown): ThreadCreationFailureKind {
  if (error instanceof ThreadCreateGoneError) return 'gone'
  if (error instanceof ThreadCreateRejectedError) return 'rejected'

  return 'unreachable'
}

function latestChannelDetails() {
  const ranked = db()
    .selectFrom('channelDetailRevisions')
    .select((eb) => [
      'channelId',
      'isThread',
      'name',
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
    .as('rankedDetails')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'isThread', 'name'])
    .where('rowNumber', '=', 1)
    .as('channelDetails')
}

async function findParentChannel(channelId: string) {
  return await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(
      latestChannelDetails(),
      'channelDetails.channelId',
      'channels.id'
    )
    .where('channels.id', '=', channelId)
    .select((eb) => [
      'channels.id',
      'channels.discordChannelId',
      'channels.guildId',
      'channelDetails.isThread',
      'channelDetails.name',
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
}

// A thread Discord anchors on a message takes the message's own snowflake as
// its channel id, so a channel already standing under that id is that thread.
async function findAnchorMessage(messageId: string) {
  return await db()
    .selectFrom('messages')
    .where('messages.id', '=', messageId)
    .select((eb) => [
      'messages.id',
      'messages.channelId',
      'messages.discordMessageId',
      eb
        .exists(
          eb
            .selectFrom('messageDeletions')
            .select('messageDeletions.id')
            .whereRef('messageDeletions.messageId', '=', 'messages.id')
        )
        .$castTo<number>()
        .as('deleted'),
      eb
        .exists(
          eb
            .selectFrom('channels')
            .select('channels.id')
            .whereRef(
              'channels.discordChannelId',
              '=',
              'messages.discordMessageId'
            )
            .where(({ exists, not, selectFrom }) =>
              not(
                exists(
                  selectFrom('channelRemovals')
                    .select('channelRemovals.id')
                    .whereRef('channelRemovals.channelId', '=', 'channels.id')
                )
              )
            )
        )
        .$castTo<number>()
        .as('threaded'),
    ])
    .executeTakeFirst()
}

function skipReasonFor({
  anchor,
  channel,
  guildId,
}: {
  anchor: { deleted: number; threaded: number } | undefined
  channel: { discordGuildId: string; isThread: number; removed: number }
  guildId: string
}): ThreadCreationSkipReason | null {
  if (channel.discordGuildId !== guildId) return 'channel_not_in_guild'
  if (channel.removed === 1) return 'channel_not_found'
  if (channel.isThread === 1) return 'channel_is_a_thread'
  if (anchor?.deleted === 1) return 'anchor_message_deleted'
  if (anchor?.threaded === 1) return 'thread_already_exists'

  return null
}

// The daemon records the same thread the moment Discord announces it, and its
// snapshot already carries the name, the thread flag and the category — so this
// writer describes the thread only when its own insert is what created the row.
async function recordThreadChannel(
  trx: Transaction<DB>,
  {
    category,
    discordChannelId,
    guildId,
    name,
  }: {
    category: string
    discordChannelId: string
    guildId: string
    name: string
  }
) {
  const created = await trx
    .insertInto('channels')
    .values({ discordChannelId, guildId, id: newId() })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst()

  if (!created) {
    return await trx
      .selectFrom('channels')
      .select('id')
      .where('discordChannelId', '=', discordChannelId)
      .executeTakeFirstOrThrow()
  }

  await trx
    .insertInto('channelDetailRevisions')
    .values({ channelId: created.id, id: newId(), isThread: 1, name })
    .execute()

  await trx
    .insertInto('channelCategoryChanges')
    .values({ category, channelId: created.id, id: newId() })
    .execute()

  return created
}

function createThread(transport: ThreadCreateTransport) {
  return applySchema(
    createThreadSchema,
    threadsContextSchema
  )(async ({ channelId, messageId, name }, context) => {
    const anchor = messageId ? await findAnchorMessage(messageId) : undefined

    if (messageId && !anchor) {
      throw new InputError(
        'No message with that id has been ingested, so there is nothing to anchor a thread on. Catch up on a channel to pick one.',
        ['messageId']
      )
    }

    const parentChannelId = anchor?.channelId ?? channelId
    const channel = parentChannelId
      ? await findParentChannel(parentChannelId)
      : undefined

    if (!channel) {
      throw new InputError(
        'No channel with that id has been ingested. List the channels to pick one.',
        ['channelId']
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
          .insertInto('threadCreationRequests')
          .values({ channelId: channel.id, id: newId(), name })
          .returning('id')
          .executeTakeFirstOrThrow()

        if (anchor) {
          await trx
            .insertInto('threadCreationRequestAnchors')
            .values({
              id: newId(),
              messageId: anchor.id,
              threadCreationRequestId: row.id,
            })
            .execute()
        }

        return row
      })

    const reason = skipReasonFor({
      anchor,
      channel,
      guildId: context.owner.guildId,
    })

    if (reason) {
      await db()
        .insertInto('threadCreationSkips')
        .values({ id: newId(), reason, threadCreationRequestId: request.id })
        .execute()

      return {
        thread: {
          requestId: request.id,
          status: 'skipped' as const,
          name,
          reason,
          ...threadCreationGuidance({ reason, status: 'skipped' }),
        },
      }
    }

    let created: { discordChannelId: string }

    try {
      created = await transport({
        anchorDiscordMessageId: anchor?.discordMessageId ?? null,
        autoArchiveMinutes: threadAutoArchiveMinutes,
        discordChannelId: channel.discordChannelId,
        name,
      })
    } catch (error) {
      const kind = failureKindOf(error)

      await db()
        .insertInto('threadCreationFailures')
        .values({
          id: newId(),
          kind,
          errorMessage: error instanceof Error ? error.message : String(error),
          threadCreationRequestId: request.id,
        })
        .execute()

      return {
        thread: {
          requestId: request.id,
          status: 'failed' as const,
          name,
          ...threadCreationGuidance({ kind, status: 'failed' }),
        },
      }
    }

    const thread = await db()
      .transaction()
      .execute(async (trx) => {
        const row = await recordThreadChannel(trx, {
          category: channel.name,
          discordChannelId: created.discordChannelId,
          guildId: channel.guildId,
          name,
        })

        await trx
          .insertInto('threadCreations')
          .values({
            channelId: row.id,
            id: newId(),
            threadCreationRequestId: request.id,
          })
          .execute()

        return row
      })

    return {
      thread: {
        requestId: request.id,
        status: 'created' as const,
        name,
        channelId: thread.id,
        jumpUrl: jumpUrl({
          discordChannelId: created.discordChannelId,
          discordGuildId: channel.discordGuildId,
        }),
        ...threadCreationGuidance({ status: 'created' }),
      },
    }
  })
}

export { createThread }
