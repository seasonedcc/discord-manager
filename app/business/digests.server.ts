import { InputError, applySchema } from 'composable-functions'
import { type SqlBool, sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  catchUpSinceSchema,
  digestMessageLimit,
  listMentionsSchema,
} from '~/business/digests.common'
import {
  messageAttachmentsSchema,
  messageEmbedsSchema,
  messageReactionsSchema,
} from '~/business/messages.common'
import { db } from '~/db/db.server'

const digestsContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

const embedsAsJsonArray = sql<string>`json_group_array(
  message_revision_embeds.content order by message_revision_embeds.position
)`.as('embeds')

const attachmentsAsJsonArray = sql<string>`json_group_array(
  json_object(
    'filename', message_revision_attachments.filename,
    'size', message_revision_attachments.size,
    'url', message_revision_attachments.url
  ) order by message_revision_attachments.position
)`.as('attachments')

const reactionsAsJsonArray = sql<string>`json_group_array(
  json_object(
    'emoji', standing_reactions.emoji,
    'count', standing_reactions.reactor_count,
    'ownerReacted', standing_reactions.owner_reacted
  ) order by standing_reactions.first_reacted_at, standing_reactions.first_reaction_id
)`.as('reactions')

function standingReactionsOfTheMessage(ownerDiscordUserId: string) {
  const reactionEvents = db()
    .selectFrom('messageReactionAdditions')
    .select([
      'id',
      'emoji',
      'reactorDiscordUserId',
      'createdAt',
      sql<number>`1`.as('reacted'),
    ])
    .where(sql<SqlBool>`message_reaction_additions.message_id = messages.id`)
    .unionAll(
      db()
        .selectFrom('messageReactionRemovals')
        .select([
          'id',
          'emoji',
          'reactorDiscordUserId',
          'createdAt',
          sql<number>`0`.as('reacted'),
        ])
        .where(sql<SqlBool>`message_reaction_removals.message_id = messages.id`)
    )

  const rankedReactionEvents = db()
    .selectFrom(reactionEvents.as('reactionEvents'))
    .select((eb) => [
      'id',
      'emoji',
      'reactorDiscordUserId',
      'createdAt',
      'reacted',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy(['emoji', 'reactorDiscordUserId'])
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('rankedReactionEvents')

  const standingReactions = db()
    .selectFrom(rankedReactionEvents)
    .select((eb) => [
      'emoji',
      eb.fn.countAll<number>().as('reactorCount'),
      eb.fn
        .max(
          eb
            .case()
            .when('reactorDiscordUserId', '=', ownerDiscordUserId)
            .then(1)
            .else(0)
            .end()
        )
        .as('ownerReacted'),
      eb.fn.min('createdAt').as('firstReactedAt'),
      eb.fn.min('id').as('firstReactionId'),
    ])
    .where('rowNumber', '=', 1)
    .where('reacted', '=', 1)
    .groupBy('emoji')
    .as('standingReactions')

  return db().selectFrom(standingReactions).select(reactionsAsJsonArray)
}

function digestMessagesSince({
  since,
  guildId,
  ownerDiscordUserId,
}: {
  since: string
  guildId: string
  ownerDiscordUserId: string
}) {
  const rankedRevisions = db()
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
    .select((eb) => [
      'messages.id as messageId',
      'messages.discordMessageId',
      'messages.discordCreatedAt',
      'messages.channelId',
      'channels.discordChannelId',
      'guilds.discordGuildId',
      'latestChannelDetails.name as channelName',
      'latestMemberDetails.displayName as authorDisplayName',
      'latestRevisions.content',
      eb
        .selectFrom('messageRevisionEmbeds')
        .select(embedsAsJsonArray)
        .whereRef(
          'messageRevisionEmbeds.messageRevisionId',
          '=',
          'latestRevisions.revisionId'
        )
        .as('embeds'),
      eb
        .selectFrom('messageRevisionAttachments')
        .select(attachmentsAsJsonArray)
        .whereRef(
          'messageRevisionAttachments.messageRevisionId',
          '=',
          'latestRevisions.revisionId'
        )
        .as('attachments'),
      standingReactionsOfTheMessage(ownerDiscordUserId).as('reactions'),
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
      .map(
        ({ attachments, discordGuildId, embeds, reactions, ...message }) => ({
          ...message,
          attachments: messageAttachmentsSchema.parse(
            JSON.parse(attachments ?? '[]')
          ),
          embeds: messageEmbedsSchema.parse(JSON.parse(embeds ?? '[]')),
          jumpUrl: `https://discord.com/channels/${discordGuildId}/${message.discordChannelId}/${message.discordMessageId}`,
          reactions: messageReactionsSchema.parse(
            JSON.parse(reactions ?? '[]')
          ),
        })
      ),
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
    ownerDiscordUserId: context.owner.discordUserId,
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
    ownerDiscordUserId: context.owner.discordUserId,
  })

  return await readDigest(
    query.where(({ eb, exists, or, selectFrom }) =>
      or([
        exists(
          selectFrom('messageRevisionUserMentions')
            .select('messageRevisionUserMentions.id')
            .whereRef(
              'messageRevisionUserMentions.messageRevisionId',
              '=',
              'latestRevisions.revisionId'
            )
            .where(
              'messageRevisionUserMentions.mentionedDiscordUserId',
              '=',
              context.owner.discordUserId
            )
        ),
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
