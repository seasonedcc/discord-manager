import { applySchema } from 'composable-functions'
import { type ExpressionBuilder, sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import { listChannelsSchema } from '~/business/channels.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'

const channelsContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function latestChannelDetailsOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom('channelDetailRevisions')
    .select('channelDetailRevisions.id')
    .whereRef('channelDetailRevisions.channelId', '=', 'channels.id')
    .orderBy('channelDetailRevisions.createdAt', 'desc')
    .orderBy('channelDetailRevisions.id', 'desc')
    .limit(1)
}

function latestTopicOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom(
      eb
        .selectFrom('channelTopicChanges')
        .select((change) => [
          change
            .ref('channelTopicChanges.topic')
            .$castTo<string | null>()
            .as('topic'),
          'channelTopicChanges.createdAt',
          'channelTopicChanges.id',
        ])
        .whereRef('channelTopicChanges.channelId', '=', 'channels.id')
        .unionAll(
          eb
            .selectFrom('channelTopicClearings')
            .select([
              sql<string | null>`null`.as('topic'),
              'channelTopicClearings.createdAt',
              'channelTopicClearings.id',
            ])
            .whereRef('channelTopicClearings.channelId', '=', 'channels.id')
        )
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .as('latestTopicEvents')
    )
    .select('latestTopicEvents.topic')
}

function latestCategoryOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom(
      eb
        .selectFrom('channelCategoryChanges')
        .select((change) => [
          change
            .ref('channelCategoryChanges.category')
            .$castTo<string | null>()
            .as('category'),
          'channelCategoryChanges.createdAt',
          'channelCategoryChanges.id',
        ])
        .whereRef('channelCategoryChanges.channelId', '=', 'channels.id')
        .unionAll(
          eb
            .selectFrom('channelCategoryClearings')
            .select([
              sql<string | null>`null`.as('category'),
              'channelCategoryClearings.createdAt',
              'channelCategoryClearings.id',
            ])
            .whereRef('channelCategoryClearings.channelId', '=', 'channels.id')
        )
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .as('latestCategoryEvents')
    )
    .select('latestCategoryEvents.category')
}

function latestPositionOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom(
      eb
        .selectFrom('channelPositionChanges')
        .select((change) => [
          change
            .ref('channelPositionChanges.position')
            .$castTo<number | null>()
            .as('position'),
          'channelPositionChanges.createdAt',
          'channelPositionChanges.id',
        ])
        .whereRef('channelPositionChanges.channelId', '=', 'channels.id')
        .unionAll(
          eb
            .selectFrom('channelPositionClearings')
            .select([
              sql<number | null>`null`.as('position'),
              'channelPositionClearings.createdAt',
              'channelPositionClearings.id',
            ])
            .whereRef('channelPositionClearings.channelId', '=', 'channels.id')
        )
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .as('latestPositionEvents')
    )
    .select('latestPositionEvents.position')
}

function latestArchivedStateOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom(
      eb
        .selectFrom('channelArchivings')
        .select([
          sql<number>`1`.as('archived'),
          'channelArchivings.createdAt',
          'channelArchivings.id',
        ])
        .whereRef('channelArchivings.channelId', '=', 'channels.id')
        .unionAll(
          eb
            .selectFrom('channelUnarchivings')
            .select([
              sql<number>`0`.as('archived'),
              'channelUnarchivings.createdAt',
              'channelUnarchivings.id',
            ])
            .whereRef('channelUnarchivings.channelId', '=', 'channels.id')
        )
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .as('latestArchivedEvents')
    )
    .select('latestArchivedEvents.archived')
}

const listChannels = applySchema(
  listChannelsSchema,
  channelsContextSchema
)(async (_input, context) => {
  const rows = await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin('channelDetailRevisions as latestChannelDetails', (join) =>
      join.on((eb) =>
        eb('latestChannelDetails.id', '=', latestChannelDetailsOf(eb))
      )
    )
    .where('guilds.discordGuildId', '=', context.owner.guildId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('channelRemovals')
            .select('channelRemovals.id')
            .whereRef('channelRemovals.channelId', '=', 'channels.id')
        )
      )
    )
    .select((eb) => [
      'channels.id as channelId',
      'channels.discordChannelId',
      'latestChannelDetails.name',
      'latestChannelDetails.isThread',
      latestTopicOf(eb).as('topic'),
      latestCategoryOf(eb).as('category'),
      latestPositionOf(eb).as('position'),
      eb.fn.coalesce(latestArchivedStateOf(eb), sql<number>`0`).as('archived'),
    ])
    .orderBy('latestChannelDetails.isThread', 'asc')
    .orderBy('archived', 'asc')
    .orderBy('category', 'asc')
    .orderBy('position', 'asc')
    .orderBy('latestChannelDetails.name', 'asc')
    .orderBy('channels.discordChannelId', 'asc')
    .execute()

  return {
    channels: rows.map(
      ({ archived, category, isThread, position, topic, ...channel }) => ({
        ...channel,
        isThread: isThread === 1,
        ...(isThread === 1 ? { archived: archived === 1 } : {}),
        ...(topic === null ? {} : { topic }),
        ...(category === null ? {} : { category }),
        ...(position === null ? {} : { position }),
      })
    ),
  }
})

export { listChannels }
