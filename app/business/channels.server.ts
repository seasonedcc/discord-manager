import { applySchema } from 'composable-functions'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import { listChannelsSchema } from '~/business/channels.common'
import { db } from '~/db/db.server'

const channelsContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

const listChannels = applySchema(
  listChannelsSchema,
  channelsContextSchema
)(async (_input, context) => {
  const rankedChannelDetails = db()
    .selectFrom('channelDetailRevisions')
    .select((eb) => [
      'channelId',
      'name',
      'topic',
      'category',
      'isThread',
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
    .as('channelDetails')

  const rows = await db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(rankedChannelDetails, 'channelDetails.channelId', 'channels.id')
    .where('channelDetails.rowNumber', '=', 1)
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
    .select([
      'channels.id',
      'channels.discordChannelId',
      'channelDetails.name',
      'channelDetails.topic',
      'channelDetails.category',
      'channelDetails.isThread',
      'channelDetails.position',
    ])
    .orderBy('channelDetails.category', 'asc')
    .orderBy('channelDetails.position', 'asc')
    .orderBy('channelDetails.name', 'asc')
    .orderBy('channels.discordChannelId', 'asc')
    .execute()

  return {
    channels: rows.map(({ isThread, ...channel }) => ({
      ...channel,
      isThread: isThread === 1,
    })),
  }
})

export { listChannels }
