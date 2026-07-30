import { InputError, applySchema } from 'composable-functions'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  catchUpSinceSchema,
  digestMessageLimit,
  listMentionsSchema,
} from '~/business/digests.common'
import { db } from '~/db/db.server'

const digestsContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function digestMessagesSince({
  since,
  guildId,
}: {
  since: string
  guildId: string
}) {
  const rankedRevisions = db()
    .selectFrom('messageRevisions')
    .select((eb) => [
      'messageId',
      'content',
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

  const rankedChannelDetails = db()
    .selectFrom('channelDetailRevisions')
    .select((eb) => [
      'channelId',
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
    .as('latestChannelDetails')

  const rankedMemberDetails = db()
    .selectFrom('memberDetailRevisions')
    .select((eb) => [
      'memberId',
      'displayName',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('memberId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('latestMemberDetails')

  return db()
    .selectFrom('messages')
    .innerJoin('channels', 'channels.id', 'messages.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(rankedRevisions, 'latestRevisions.messageId', 'messages.id')
    .innerJoin(
      rankedChannelDetails,
      'latestChannelDetails.channelId',
      'channels.id'
    )
    .innerJoin(
      rankedMemberDetails,
      'latestMemberDetails.memberId',
      'messages.authorMemberId'
    )
    .where('latestRevisions.rowNumber', '=', 1)
    .where('latestChannelDetails.rowNumber', '=', 1)
    .where('latestMemberDetails.rowNumber', '=', 1)
    .where('guilds.discordGuildId', '=', guildId)
    .where('messages.discordCreatedAt', '>=', since)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('messageDeletions')
            .select('messageDeletions.id')
            .whereRef('messageDeletions.messageId', '=', 'messages.id')
        )
      )
    )
    .select([
      'messages.id as messageId',
      'messages.discordMessageId',
      'messages.discordCreatedAt',
      'messages.channelId',
      'channels.discordChannelId',
      'guilds.discordGuildId',
      'latestChannelDetails.name as channelName',
      'latestMemberDetails.displayName as authorDisplayName',
      'latestRevisions.content',
    ])
    .orderBy('messages.discordCreatedAt', 'asc')
    .orderBy(sql`cast(messages.discord_message_id as integer)`, 'asc')
    .limit(digestMessageLimit + 1)
}

async function readDigest(query: ReturnType<typeof digestMessagesSince>) {
  const rows = await query.execute()

  return {
    messages: rows
      .slice(0, digestMessageLimit)
      .map(({ discordGuildId, ...message }) => ({
        ...message,
        jumpUrl: `https://discord.com/channels/${discordGuildId}/${message.discordChannelId}/${message.discordMessageId}`,
      })),
    truncated: rows.length > digestMessageLimit,
  }
}

const catchUpSince = applySchema(
  catchUpSinceSchema,
  digestsContextSchema
)(async ({ since, channelId }, context) => {
  const query = digestMessagesSince({
    since: new Date(since).toISOString(),
    guildId: context.owner.guildId,
  })

  if (!channelId) return await readDigest(query)

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

  return await readDigest(query.where('messages.channelId', '=', channel.id))
})

const listMentions = applySchema(
  listMentionsSchema,
  digestsContextSchema
)(async ({ since }, context) => {
  const query = digestMessagesSince({
    since: new Date(since).toISOString(),
    guildId: context.owner.guildId,
  })

  return await readDigest(
    query.where(({ eb, or }) =>
      or([
        eb(
          'latestRevisions.content',
          'like',
          `%<@${context.owner.discordUserId}>%`
        ),
        eb(
          'latestRevisions.content',
          'like',
          `%<@!${context.owner.discordUserId}>%`
        ),
      ])
    )
  )
})

export { catchUpSince, listMentions }
