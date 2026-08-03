import { applySchema } from 'composable-functions'
import { type ExpressionBuilder, sql } from 'kysely'
import { z } from 'zod'
import { activitySinceSchema } from '~/business/activity.common'
import { ownerContextSchema } from '~/business/auth.server'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'

const activityContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
  canReadMessages: z.literal(true),
})

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function latestRevisionOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('messageRevisions')
    .whereRef('messageRevisions.messageId', '=', 'messages.id')
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .limit(1)
}

function latestBotIdentityOf(guildId: string) {
  return db()
    .selectFrom('gatewayIdentifications')
    .innerJoin('guilds', 'guilds.id', 'gatewayIdentifications.guildId')
    .select('gatewayIdentifications.botDiscordUserId')
    .where('guilds.discordGuildId', '=', guildId)
    .orderBy('gatewayIdentifications.createdAt', 'desc')
    .orderBy('gatewayIdentifications.id', 'desc')
    .limit(1)
}

function pingsTheOwnerOrTheBot(
  eb: ExpressionBuilder<DB, 'messages'>,
  { discordUserId, guildId }: { discordUserId: string; guildId: string }
) {
  const owner = eb.val(discordUserId)
  const bot = latestBotIdentityOf(guildId)

  const pings = (identity: typeof owner | typeof bot) =>
    eb.and([
      eb.or([
        eb.exists(
          eb
            .selectFrom('messageRevisionUserMentions')
            .select('messageRevisionUserMentions.id')
            .where(
              'messageRevisionUserMentions.messageRevisionId',
              '=',
              latestRevisionOf(eb).select('messageRevisions.id')
            )
            .where(
              'messageRevisionUserMentions.mentionedDiscordUserId',
              '=',
              identity
            )
        ),
        eb(
          latestRevisionOf(eb).select('messageRevisions.content'),
          'like',
          sql<string>`'%<@' || ${identity} || '>%'`
        ),
        eb(
          latestRevisionOf(eb).select('messageRevisions.content'),
          'like',
          sql<string>`'%<@!' || ${identity} || '>%'`
        ),
      ]),
      eb.not(
        eb.exists(
          eb
            .selectFrom('members')
            .select('members.id')
            .whereRef('members.id', '=', 'messages.authorMemberId')
            .where('members.discordUserId', '=', identity)
        )
      ),
    ])

  return eb.or([pings(owner), pings(bot)])
}

async function countActivity({
  cutoff,
  discordUserId,
  guildId,
}: {
  cutoff: string
  discordUserId: string
  guildId: string
}) {
  const counted = await db()
    .with('newMessages', (qb) =>
      qb
        .selectFrom('messages')
        .where('messages.createdAt', '>', cutoff)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('channels')
              .innerJoin('guilds', 'guilds.id', 'channels.guildId')
              .select('channels.id')
              .whereRef('channels.id', '=', 'messages.channelId')
              .where('guilds.discordGuildId', '=', guildId)
          )
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('messageDeletions')
                .select('messageDeletions.id')
                .whereRef('messageDeletions.messageId', '=', 'messages.id')
            )
          )
        )
        .select((eb) => [
          'messages.createdAt',
          pingsTheOwnerOrTheBot(eb, { discordUserId, guildId })
            .$castTo<number>()
            .as('pingsTheOwnerOrTheBot'),
        ])
    )
    .with('newBookmarkAdditions', (qb) =>
      qb
        .selectFrom('bookmarkAdditions')
        .where('bookmarkAdditions.createdAt', '>', cutoff)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('messages')
              .innerJoin('channels', 'channels.id', 'messages.channelId')
              .innerJoin('guilds', 'guilds.id', 'channels.guildId')
              .select('messages.id')
              .whereRef('messages.id', '=', 'bookmarkAdditions.messageId')
              .where('guilds.discordGuildId', '=', guildId)
          )
        )
        .select('bookmarkAdditions.createdAt')
    )
    .selectFrom('newMessages')
    .select((eb) => [
      eb.fn.countAll<number>().as('messageCount'),
      eb.fn.max<string | null>('createdAt').as('messagesNewestAt'),
      eb.fn
        .countAll<number>()
        .filterWhere('pingsTheOwnerOrTheBot', '=', 1)
        .as('mentionCount'),
      eb.fn
        .max<string | null>('createdAt')
        .filterWhere('pingsTheOwnerOrTheBot', '=', 1)
        .as('mentionsNewestAt'),
      eb
        .selectFrom('newBookmarkAdditions')
        .select((additions) => additions.fn.countAll<number>().as('count'))
        .as('bookmarkAdditionCount'),
      eb
        .selectFrom('newBookmarkAdditions')
        .select((additions) =>
          additions.fn.max<string | null>('createdAt').as('newestAt')
        )
        .as('bookmarkAdditionsNewestAt'),
    ])
    .executeTakeFirstOrThrow()

  return {
    messages: {
      count: counted.messageCount,
      newestAt: counted.messagesNewestAt,
    },
    mentions: {
      count: counted.mentionCount,
      newestAt: counted.mentionsNewestAt,
    },
    bookmarkAdditions: {
      count: counted.bookmarkAdditionCount,
      newestAt: counted.bookmarkAdditionsNewestAt,
    },
  }
}

const readActivitySince = applySchema(
  activitySinceSchema,
  activityContextSchema
)(async ({ since, waitSeconds }, context) => {
  const cutoff = new Date(since).toISOString()
  const { discordUserId, guildId } = context.owner
  const deadline = Date.now() + (waitSeconds ?? 0) * 1000

  let activity = await countActivity({ cutoff, discordUserId, guildId })

  while (
    activity.messages.count === 0 &&
    activity.bookmarkAdditions.count === 0 &&
    Date.now() < deadline
  ) {
    await sleep(1000)
    activity = await countActivity({ cutoff, discordUserId, guildId })
  }

  return { activity }
})

export { readActivitySince }
