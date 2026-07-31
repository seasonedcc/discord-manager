import { applySchema } from 'composable-functions'
import type { ExpressionBuilder } from 'kysely'
import { z } from 'zod'
import { activitySinceSchema } from '~/business/activity.common'
import { ownerContextSchema } from '~/business/auth.server'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'

const activityContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
  canReadMessages: z.literal(true),
})

function latestRevisionOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('messageRevisions')
    .whereRef('messageRevisions.messageId', '=', 'messages.id')
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .limit(1)
}

const readActivitySince = applySchema(
  activitySinceSchema,
  activityContextSchema
)(async ({ since }, context) => {
  const cutoff = new Date(since).toISOString()
  const { discordUserId, guildId } = context.owner

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
          eb
            .or([
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
                    discordUserId
                  )
              ),
              eb(
                latestRevisionOf(eb).select('messageRevisions.content'),
                'like',
                `%<@${discordUserId}>%`
              ),
              eb(
                latestRevisionOf(eb).select('messageRevisions.content'),
                'like',
                `%<@!${discordUserId}>%`
              ),
            ])
            .$castTo<number>()
            .as('pingsTheOwner'),
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
        .filterWhere('pingsTheOwner', '=', 1)
        .as('mentionCount'),
      eb.fn
        .max<string | null>('createdAt')
        .filterWhere('pingsTheOwner', '=', 1)
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
    activity: {
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
    },
  }
})

export { readActivitySince }
