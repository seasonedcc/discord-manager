import { applySchema } from 'composable-functions'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import { listChannelsSchema } from '~/business/channels.common'
import { db } from '~/db/db.server'

const channelsContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function latestChannelDetails() {
  const ranked = db()
    .selectFrom('channelDetailRevisions')
    .select((eb) => [
      'channelId',
      'name',
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
    .as('rankedDetails')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'name', 'isThread'])
    .where('rowNumber', '=', 1)
    .as('channelDetails')
}

function latestChannelTopics() {
  const events = db()
    .selectFrom('channelTopicChanges')
    .select((eb) => [
      'channelId',
      'createdAt',
      'id',
      eb.ref('topic').$castTo<string | null>().as('topic'),
    ])
    .unionAll(
      db()
        .selectFrom('channelTopicClearings')
        .select([
          'channelId',
          'createdAt',
          'id',
          sql<string | null>`null`.as('topic'),
        ])
    )

  const ranked = db()
    .selectFrom(events.as('topicEvents'))
    .select((eb) => [
      'channelId',
      'topic',
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
    .as('rankedTopics')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'topic'])
    .where('rowNumber', '=', 1)
    .as('channelTopics')
}

function latestChannelCategories() {
  const events = db()
    .selectFrom('channelCategoryChanges')
    .select((eb) => [
      'channelId',
      'createdAt',
      'id',
      eb.ref('category').$castTo<string | null>().as('category'),
    ])
    .unionAll(
      db()
        .selectFrom('channelCategoryClearings')
        .select([
          'channelId',
          'createdAt',
          'id',
          sql<string | null>`null`.as('category'),
        ])
    )

  const ranked = db()
    .selectFrom(events.as('categoryEvents'))
    .select((eb) => [
      'channelId',
      'category',
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
    .as('rankedCategories')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'category'])
    .where('rowNumber', '=', 1)
    .as('channelCategories')
}

function latestChannelPositions() {
  const events = db()
    .selectFrom('channelPositionChanges')
    .select((eb) => [
      'channelId',
      'createdAt',
      'id',
      eb.ref('position').$castTo<number | null>().as('position'),
    ])
    .unionAll(
      db()
        .selectFrom('channelPositionClearings')
        .select([
          'channelId',
          'createdAt',
          'id',
          sql<number | null>`null`.as('position'),
        ])
    )

  const ranked = db()
    .selectFrom(events.as('positionEvents'))
    .select((eb) => [
      'channelId',
      'position',
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
    .as('rankedPositions')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'position'])
    .where('rowNumber', '=', 1)
    .as('channelPositions')
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
    .select(['channelId', 'archived'])
    .where('rowNumber', '=', 1)
    .as('channelArchivedStates')
}

const listChannels = applySchema(
  listChannelsSchema,
  channelsContextSchema
)(async (_input, context) => {
  const rows = await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(
      latestChannelDetails(),
      'channelDetails.channelId',
      'channels.id'
    )
    .leftJoin(latestChannelTopics(), 'channelTopics.channelId', 'channels.id')
    .leftJoin(
      latestChannelCategories(),
      'channelCategories.channelId',
      'channels.id'
    )
    .leftJoin(
      latestChannelPositions(),
      'channelPositions.channelId',
      'channels.id'
    )
    .leftJoin(
      latestChannelArchivedStates(),
      'channelArchivedStates.channelId',
      'channels.id'
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
      'channelDetails.name',
      'channelDetails.isThread',
      'channelTopics.topic',
      'channelCategories.category',
      'channelPositions.position',
      eb.fn
        .coalesce('channelArchivedStates.archived', sql<number>`0`)
        .as('archived'),
    ])
    .orderBy('channelDetails.isThread', 'asc')
    .orderBy('archived', 'asc')
    .orderBy('channelCategories.category', 'asc')
    .orderBy('channelPositions.position', 'asc')
    .orderBy('channelDetails.name', 'asc')
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
