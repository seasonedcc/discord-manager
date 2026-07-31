import { applySchema } from 'composable-functions'
import { z } from 'zod'
import { activitySinceSchema } from '~/business/activity.common'
import { ownerContextSchema } from '~/business/auth.server'
import { db } from '~/db/db.server'

const activityContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
  canReadMessages: z.literal(true),
})

function latestRevisions() {
  return db()
    .selectFrom('messageRevisions')
    .select((eb) => [
      'messageId',
      'content',
      'id as revisionId',
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
    .as('latestRevisions')
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
        .innerJoin('channels', 'channels.id', 'messages.channelId')
        .innerJoin('guilds', 'guilds.id', 'channels.guildId')
        .innerJoin(
          latestRevisions(),
          'latestRevisions.messageId',
          'messages.id'
        )
        .where('latestRevisions.rowNumber', '=', 1)
        .where('guilds.discordGuildId', '=', guildId)
        .where('messages.discordCreatedAt', '>', cutoff)
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
          'messages.discordCreatedAt',
          eb
            .or([
              eb.exists(
                eb
                  .selectFrom('messageRevisionUserMentions')
                  .select('messageRevisionUserMentions.id')
                  .whereRef(
                    'messageRevisionUserMentions.messageRevisionId',
                    '=',
                    'latestRevisions.revisionId'
                  )
                  .where(
                    'messageRevisionUserMentions.mentionedDiscordUserId',
                    '=',
                    discordUserId
                  )
              ),
              eb('latestRevisions.content', 'like', `%<@${discordUserId}>%`),
              eb('latestRevisions.content', 'like', `%<@!${discordUserId}>%`),
            ])
            .$castTo<number>()
            .as('pingsTheOwner'),
        ])
    )
    .with('newBookmarkAdditions', (qb) =>
      qb
        .selectFrom('bookmarkAdditions')
        .innerJoin('messages', 'messages.id', 'bookmarkAdditions.messageId')
        .innerJoin('channels', 'channels.id', 'messages.channelId')
        .innerJoin('guilds', 'guilds.id', 'channels.guildId')
        .where('guilds.discordGuildId', '=', guildId)
        .where('bookmarkAdditions.createdAt', '>', cutoff)
        .select('bookmarkAdditions.createdAt')
    )
    .selectFrom('newMessages')
    .select((eb) => [
      eb.fn.countAll<number>().as('messageCount'),
      eb.fn.max<string | null>('discordCreatedAt').as('messagesNewestAt'),
      eb.fn
        .countAll<number>()
        .filterWhere('pingsTheOwner', '=', 1)
        .as('mentionCount'),
      eb.fn
        .max<string | null>('discordCreatedAt')
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
