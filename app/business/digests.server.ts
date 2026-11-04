import { InputError, applySchema } from 'composable-functions'
import { type ExpressionBuilder, type SqlBool, sql } from 'kysely'
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
  storedRepliedTo,
} from '~/business/messages.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'

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
  ) order by first_appearances.first_appeared_at, first_appearances.first_appearance_id
)`.as('reactions')

const replyReferenceAsJson = sql<string>`json_object(
  'discordChannelId', message_reply_references.replied_to_discord_channel_id,
  'discordGuildId', message_reply_references.replied_to_discord_guild_id,
  'discordMessageId', message_reply_references.replied_to_discord_message_id,
  'messageId', replied_to_messages.id
)`.as('replyReference')

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
      'emoji',
      'reactorDiscordUserId',
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
    ])
    .where('rowNumber', '=', 1)
    .where('reacted', '=', 1)
    .groupBy('emoji')
    .as('standingReactions')

  const firstAppearances = db()
    .selectFrom('messageReactionAdditions')
    .select((eb) => [
      'emoji',
      eb.fn.min('createdAt').as('firstAppearedAt'),
      eb.fn.min('id').as('firstAppearanceId'),
    ])
    .where(sql<SqlBool>`message_reaction_additions.message_id = messages.id`)
    .groupBy('emoji')
    .as('firstAppearances')

  return db()
    .selectFrom(standingReactions)
    .innerJoin(
      firstAppearances,
      'firstAppearances.emoji',
      'standingReactions.emoji'
    )
    .select(reactionsAsJsonArray)
}

function latestRevisionOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('messageRevisions')
    .select('messageRevisions.id')
    .whereRef('messageRevisions.messageId', '=', 'messages.id')
    .orderBy('messageRevisions.createdAt', 'desc')
    .orderBy('messageRevisions.id', 'desc')
    .limit(1)
}

function latestChannelDetailsOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('channelDetailRevisions')
    .select('channelDetailRevisions.id')
    .whereRef('channelDetailRevisions.channelId', '=', 'messages.channelId')
    .orderBy('channelDetailRevisions.createdAt', 'desc')
    .orderBy('channelDetailRevisions.id', 'desc')
    .limit(1)
}

function latestAuthorDetailsOf(eb: ExpressionBuilder<DB, 'messages'>) {
  return eb
    .selectFrom('memberDetailRevisions')
    .select('memberDetailRevisions.id')
    .whereRef('memberDetailRevisions.memberId', '=', 'messages.authorMemberId')
    .orderBy('memberDetailRevisions.createdAt', 'desc')
    .orderBy('memberDetailRevisions.id', 'desc')
    .limit(1)
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
  return db()
    .selectFrom('messages')
    .innerJoin('channels', 'channels.id', 'messages.channelId')
    .innerJoin('messageRevisions as latestRevisions', (join) =>
      join.on((eb) => eb('latestRevisions.id', '=', latestRevisionOf(eb)))
    )
    .innerJoin('channelDetailRevisions as latestChannelDetails', (join) =>
      join.on((eb) =>
        eb('latestChannelDetails.id', '=', latestChannelDetailsOf(eb))
      )
    )
    .innerJoin('memberDetailRevisions as latestMemberDetails', (join) =>
      join.on((eb) =>
        eb('latestMemberDetails.id', '=', latestAuthorDetailsOf(eb))
      )
    )
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('guilds')
          .select('guilds.id')
          .whereRef('guilds.id', '=', 'channels.guildId')
          .where('guilds.discordGuildId', '=', guildId)
      )
    )
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
      eb.val(guildId).as('discordGuildId'),
      'latestChannelDetails.name as channelName',
      'latestMemberDetails.displayName as authorDisplayName',
      'latestRevisions.content',
      eb
        .selectFrom('messageRevisionEmbeds')
        .select(embedsAsJsonArray)
        .whereRef(
          'messageRevisionEmbeds.messageRevisionId',
          '=',
          'latestRevisions.id'
        )
        .as('embeds'),
      eb
        .selectFrom('messageRevisionAttachments')
        .select(attachmentsAsJsonArray)
        .whereRef(
          'messageRevisionAttachments.messageRevisionId',
          '=',
          'latestRevisions.id'
        )
        .as('attachments'),
      standingReactionsOfTheMessage(ownerDiscordUserId).as('reactions'),
      eb
        .selectFrom('messageReplyReferences')
        .leftJoin(
          'messages as repliedToMessages',
          'repliedToMessages.discordMessageId',
          'messageReplyReferences.repliedToDiscordMessageId'
        )
        .select(replyReferenceAsJson)
        .whereRef('messageReplyReferences.messageId', '=', 'messages.id')
        .as('replyReference'),
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
        ({
          attachments,
          discordGuildId,
          embeds,
          reactions,
          replyReference,
          ...message
        }) => ({
          ...message,
          attachments: messageAttachmentsSchema.parse(
            JSON.parse(attachments ?? '[]')
          ),
          embeds: messageEmbedsSchema.parse(JSON.parse(embeds ?? '[]')),
          jumpUrl: `https://discord.com/channels/${discordGuildId}/${message.discordChannelId}/${message.discordMessageId}`,
          reactions: messageReactionsSchema.parse(
            JSON.parse(reactions ?? '[]')
          ),
          repliedTo: storedRepliedTo(replyReference),
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
    query.where((eb) => {
      const owner = eb.val(context.owner.discordUserId)
      const bot = latestBotIdentityOf(context.owner.guildId)

      const pings = (identity: typeof owner | typeof bot) =>
        eb.and([
          eb.or([
            eb.exists(
              eb
                .selectFrom('messageRevisionUserMentions')
                .select('messageRevisionUserMentions.id')
                .whereRef(
                  'messageRevisionUserMentions.messageRevisionId',
                  '=',
                  'latestRevisions.id'
                )
                .where(
                  'messageRevisionUserMentions.mentionedDiscordUserId',
                  '=',
                  identity
                )
            ),
            eb(
              'latestRevisions.content',
              'like',
              sql<string>`'%<@' || ${identity} || '>%'`
            ),
            eb(
              'latestRevisions.content',
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
    })
  )
})

export { catchUpSince, listMentions }
