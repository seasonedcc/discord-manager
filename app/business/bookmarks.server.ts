import { InputError, applySchema } from 'composable-functions'
import { type SqlBool, sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  addBookmarkByLinkSchema,
  addBookmarkReasonSchema,
  editBookmarkReasonSchema,
  inboxBookmarkReasonId,
  listBookmarkReasonsSchema,
  listBookmarksSchema,
  resolveBookmarkSchema,
  retireBookmarkReasonSchema,
  setBookmarkReasonSchema,
  snoozeBookmarkSchema,
} from '~/business/bookmarks.common'
import {
  messageAttachmentsSchema,
  messageEmbedsSchema,
  messageReactionsSchema,
  storedRepliedTo,
} from '~/business/messages.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

const discordMessageLinkPattern =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)\/([^/]+)$/
const discordSnowflakePattern = /^\d{17,20}$/

const bookmarksContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
})

const nowInstant = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`

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

function latestBookmarkEvents() {
  const bookmarkEvents = db()
    .selectFrom('bookmarkAdditions')
    .select([
      'id',
      'messageId',
      'source',
      'createdAt',
      sql<number>`1`.as('bookmarked'),
    ])
    .unionAll(
      db()
        .selectFrom('bookmarkRemovals')
        .select([
          'id',
          'messageId',
          'source',
          'createdAt',
          sql<number>`0`.as('bookmarked'),
        ])
    )

  return db()
    .selectFrom(bookmarkEvents.as('bookmarkEvents'))
    .select((eb) => [
      'messageId',
      'source',
      'bookmarked',
      'createdAt',
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
    .as('latestBookmarkEvents')
}

function latestReasonDetails() {
  return db()
    .selectFrom('bookmarkReasonDetailRevisions')
    .select((eb) => [
      'reasonId',
      'name',
      'description',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('reasonId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])
    .as('latestReasonDetails')
}

function latestReasonAssignments() {
  return db()
    .selectFrom('bookmarkReasonAssignments')
    .select((eb) => [
      'messageId',
      'reasonId',
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
    .as('latestReasonAssignments')
}

function reasonsWithCurrentDetails() {
  return db()
    .selectFrom('bookmarkReasons')
    .innerJoin(latestReasonDetails(), (join) =>
      join
        .onRef('latestReasonDetails.reasonId', '=', 'bookmarkReasons.id')
        .on('latestReasonDetails.rowNumber', '=', 1)
    )
}

function activeReasons() {
  return reasonsWithCurrentDetails().where(({ not, exists, selectFrom }) =>
    not(
      exists(
        selectFrom('bookmarkReasonRetirements')
          .select('bookmarkReasonRetirements.id')
          .whereRef(
            'bookmarkReasonRetirements.reasonId',
            '=',
            'bookmarkReasons.id'
          )
      )
    )
  )
}

async function readReason(reasonId: string) {
  return await reasonsWithCurrentDetails()
    .select((eb) => [
      'bookmarkReasons.id as reasonId',
      'latestReasonDetails.name',
      'latestReasonDetails.description',
      eb
        .exists(
          eb
            .selectFrom('bookmarkReasonRetirements')
            .select('bookmarkReasonRetirements.id')
            .whereRef(
              'bookmarkReasonRetirements.reasonId',
              '=',
              'bookmarkReasons.id'
            )
        )
        .$castTo<number>()
        .as('retired'),
    ])
    .where('bookmarkReasons.id', '=', reasonId)
    .executeTakeFirst()
}

async function activeReasonNamed(name: string, exceptReasonId?: string) {
  const query = activeReasons()
    .select(['bookmarkReasons.id as reasonId', 'latestReasonDetails.name'])
    .where((eb) =>
      eb(
        eb.fn<string>('lower', ['latestReasonDetails.name']),
        '=',
        name.toLowerCase()
      )
    )

  return await (exceptReasonId
    ? query.where('bookmarkReasons.id', '!=', exceptReasonId)
    : query
  ).executeTakeFirst()
}

function unknownMessageError() {
  return new InputError(
    'No message with that id has been ingested. List your bookmarks or catch up to pick one.',
    ['messageId']
  )
}

function unknownReasonError() {
  return new InputError(
    'No bookmark reason with that id exists. List your bookmark reasons to pick one.',
    ['reasonId']
  )
}

function retiredReasonError() {
  return new InputError(
    'That bookmark reason is retired, so nothing new can be given it. Pick an active reason, or add one.',
    ['reasonId']
  )
}

function duplicateReasonNameError(name: string) {
  return new InputError(
    `An active bookmark reason is already called "${name}". Pick another name, or edit that reason.`,
    ['name']
  )
}

async function requireAssignableReason(reasonId: string) {
  const reason = await readReason(reasonId)

  if (!reason) throw unknownReasonError()
  if (reason.retired === 1) throw retiredReasonError()

  return reason
}

function messagesInGuild(guildId: string) {
  return db()
    .selectFrom('messages')
    .innerJoin('channels', 'channels.id', 'messages.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .where('guilds.discordGuildId', '=', guildId)
    .select(['messages.id', 'messages.discordMessageId'])
}

async function readBookmarkState(messageId: string) {
  return await db()
    .selectFrom(latestBookmarkEvents())
    .select(['bookmarked', 'source', 'createdAt'])
    .where('rowNumber', '=', 1)
    .where('messageId', '=', messageId)
    .executeTakeFirst()
}

const addBookmarkReason = applySchema(
  addBookmarkReasonSchema,
  bookmarksContextSchema
)(async ({ name, description }) => {
  const clash = await activeReasonNamed(name)

  if (clash) throw duplicateReasonNameError(clash.name)

  const reason = await db()
    .transaction()
    .execute(async (trx) => {
      const record = await trx
        .insertInto('bookmarkReasons')
        .values({ id: newId() })
        .returning(['id', 'createdAt'])
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('bookmarkReasonDetailRevisions')
        .values({ id: newId(), reasonId: record.id, name, description })
        .execute()

      return record
    })

  return {
    reason: {
      reasonId: reason.id,
      name,
      description,
      createdAt: reason.createdAt,
    },
  }
})

const editBookmarkReason = applySchema(
  editBookmarkReasonSchema,
  bookmarksContextSchema
)(async ({ reasonId, name, description }) => {
  if (reasonId === inboxBookmarkReasonId) {
    throw new InputError(
      'Inbox is where every unsorted bookmark lands, so its name and description belong to the product. Add a reason of your own instead.',
      ['reasonId']
    )
  }

  const reason = await readReason(reasonId)

  if (!reason) throw unknownReasonError()

  if (reason.retired === 1) {
    throw new InputError(
      'That bookmark reason is retired, so there is nothing to edit. Add a new reason instead.',
      ['reasonId']
    )
  }

  const clash = await activeReasonNamed(name, reasonId)

  if (clash) throw duplicateReasonNameError(clash.name)

  const revision = await db()
    .insertInto('bookmarkReasonDetailRevisions')
    .values({ id: newId(), reasonId, name, description })
    .returning('createdAt')
    .executeTakeFirstOrThrow()

  return {
    reason: { reasonId, name, description, recordedAt: revision.createdAt },
  }
})

const retireBookmarkReason = applySchema(
  retireBookmarkReasonSchema,
  bookmarksContextSchema
)(async ({ reasonId }) => {
  if (reasonId === inboxBookmarkReasonId) {
    throw new InputError(
      'Inbox is where every unsorted bookmark lands, so it cannot be retired. Retire a reason of your own instead.',
      ['reasonId']
    )
  }

  const reason = await readReason(reasonId)

  if (!reason) throw unknownReasonError()

  if (reason.retired === 1) {
    throw new InputError('That bookmark reason is already retired.', [
      'reasonId',
    ])
  }

  const retirement = await db()
    .insertInto('bookmarkReasonRetirements')
    .values({ id: newId(), reasonId })
    .returning('createdAt')
    .executeTakeFirstOrThrow()

  return {
    reason: { reasonId, name: reason.name, retiredAt: retirement.createdAt },
  }
})

const listBookmarkReasons = applySchema(
  listBookmarkReasonsSchema,
  bookmarksContextSchema
)(async (_input, context) => {
  const reasons = await activeReasons()
    .select((eb) => [
      'bookmarkReasons.id as reasonId',
      'latestReasonDetails.name',
      'latestReasonDetails.description',
      eb
        .selectFrom('messages')
        .innerJoin('channels', 'channels.id', 'messages.channelId')
        .innerJoin('guilds', 'guilds.id', 'channels.guildId')
        .innerJoin(
          latestBookmarkEvents(),
          'latestBookmarkEvents.messageId',
          'messages.id'
        )
        .leftJoin(latestReasonAssignments(), (join) =>
          join
            .onRef('latestReasonAssignments.messageId', '=', 'messages.id')
            .on('latestReasonAssignments.rowNumber', '=', 1)
        )
        .where('latestBookmarkEvents.rowNumber', '=', 1)
        .where('latestBookmarkEvents.bookmarked', '=', 1)
        .where('guilds.discordGuildId', '=', context.owner.guildId)
        .where((inner) =>
          inner(
            inner.fn.coalesce(
              'latestReasonAssignments.reasonId',
              inner.val(inboxBookmarkReasonId)
            ),
            '=',
            inner.ref('bookmarkReasons.id')
          )
        )
        .select((inner) => inner.fn.countAll<number>().as('bookmarkCount'))
        .as('bookmarkCount'),
    ])
    .orderBy('bookmarkReasons.createdAt', 'asc')
    .orderBy('bookmarkReasons.id', 'asc')
    .execute()

  return { reasons }
})

const setBookmarkReason = applySchema(
  setBookmarkReasonSchema,
  bookmarksContextSchema
)(async ({ messageId, reasonId }, context) => {
  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.id', '=', messageId)
    .executeTakeFirst()

  if (!message) throw unknownMessageError()

  const state = await readBookmarkState(message.id)

  if (state?.bookmarked !== 1) {
    throw new InputError(
      'That message is not bookmarked, so there is nothing to sort',
      ['messageId']
    )
  }

  const reason = await requireAssignableReason(reasonId)

  const assignment = await db()
    .insertInto('bookmarkReasonAssignments')
    .values({ id: newId(), messageId: message.id, reasonId })
    .returning('createdAt')
    .executeTakeFirstOrThrow()

  return {
    bookmark: {
      messageId: message.id,
      reasonId,
      reasonName: reason.name,
      sortedAt: assignment.createdAt,
    },
  }
})

const addBookmarkByLink = applySchema(
  addBookmarkByLinkSchema,
  bookmarksContextSchema
)(async ({ messageLink, reasonId }, context) => {
  const link = messageLink.match(discordMessageLinkPattern)

  if (!link) {
    throw new InputError(
      'That is not a Discord message link. Right-click the message in Discord, choose Copy Message Link, and pass that — it looks like https://discord.com/channels/<server>/<channel>/<message>.',
      ['messageLink']
    )
  }

  const [, linkGuildId, linkChannelId, linkMessageId] = link

  if (
    ![linkGuildId, linkChannelId, linkMessageId].every((id) =>
      discordSnowflakePattern.test(id)
    )
  ) {
    throw new InputError(
      'That message link carries something other than Discord ids. Copy it again from Discord without editing the numbers.',
      ['messageLink']
    )
  }

  if (linkGuildId !== context.owner.guildId) {
    throw new InputError(
      'That link points at a different Discord server than this deployment manages. Pick a message from the server this deployment manages.',
      ['messageLink']
    )
  }

  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.discordMessageId', '=', linkMessageId)
    .executeTakeFirst()

  if (!message) {
    throw new InputError(
      'That message has not been ingested yet. Let the bot catch up on that channel, then bookmark it again.',
      ['messageLink']
    )
  }

  const reason = await requireAssignableReason(reasonId)

  const state = await readBookmarkState(message.id)

  if (state?.bookmarked === 1) {
    await db()
      .insertInto('bookmarkReasonAssignments')
      .values({ id: newId(), messageId: message.id, reasonId })
      .execute()

    return {
      bookmark: {
        messageId: message.id,
        source: state.source,
        bookmarkedAt: state.createdAt,
        reasonId,
        reasonName: reason.name,
      },
    }
  }

  const addition = await db()
    .transaction()
    .execute(async (trx) => {
      const record = await trx
        .insertInto('bookmarkAdditions')
        .values({ id: newId(), messageId: message.id, source: 'mcp' })
        .returning(['source', 'createdAt'])
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('bookmarkReasonAssignments')
        .values({ id: newId(), messageId: message.id, reasonId })
        .execute()

      return record
    })

  return {
    bookmark: {
      messageId: message.id,
      source: addition.source,
      bookmarkedAt: addition.createdAt,
      reasonId,
      reasonName: reason.name,
    },
  }
})

const listBookmarks = applySchema(
  listBookmarksSchema,
  bookmarksContextSchema
)(async ({ includeSnoozed, limit, reasonId }, context) => {
  if (reasonId && !(await readReason(reasonId))) throw unknownReasonError()

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

  const rankedSnoozes = db()
    .selectFrom('bookmarkSnoozes')
    .select((eb) => [
      'messageId',
      'until',
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
    .as('rankedSnoozes')

  const activeSnoozes = db()
    .selectFrom(rankedSnoozes)
    .select(['messageId', 'until'])
    .where('rowNumber', '=', 1)
    .where('until', '>', nowInstant)
    .as('activeSnoozes')

  const query = db()
    .selectFrom('messages')
    .innerJoin(
      latestBookmarkEvents(),
      'latestBookmarkEvents.messageId',
      'messages.id'
    )
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
    .leftJoin(activeSnoozes, 'activeSnoozes.messageId', 'messages.id')
    .leftJoin(latestReasonAssignments(), (join) =>
      join
        .onRef('latestReasonAssignments.messageId', '=', 'messages.id')
        .on('latestReasonAssignments.rowNumber', '=', 1)
    )
    .innerJoin(latestReasonDetails(), (join) =>
      join
        .on('latestReasonDetails.rowNumber', '=', 1)
        .on((eb) =>
          eb(
            'latestReasonDetails.reasonId',
            '=',
            eb.fn.coalesce(
              'latestReasonAssignments.reasonId',
              eb.val(inboxBookmarkReasonId)
            )
          )
        )
    )
    .where('latestBookmarkEvents.rowNumber', '=', 1)
    .where('latestBookmarkEvents.bookmarked', '=', 1)
    .where('latestRevisions.rowNumber', '=', 1)
    .where('latestChannelDetails.rowNumber', '=', 1)
    .where('latestMemberDetails.rowNumber', '=', 1)
    .where('guilds.discordGuildId', '=', context.owner.guildId)
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
      'latestBookmarkEvents.createdAt as bookmarkedAt',
      'latestBookmarkEvents.source',
      'latestReasonDetails.reasonId',
      'latestReasonDetails.name as reasonName',
      'activeSnoozes.until as snoozedUntil',
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
      standingReactionsOfTheMessage(context.owner.discordUserId).as(
        'reactions'
      ),
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
      eb
        .exists(
          eb
            .selectFrom('messageDeletions')
            .select('messageDeletions.id')
            .whereRef('messageDeletions.messageId', '=', 'messages.id')
        )
        .$castTo<number>()
        .as('deletedUpstream'),
    ])
    .orderBy('latestBookmarkEvents.createdAt', 'desc')
    .orderBy(sql`cast(messages.discord_message_id as integer)`, 'desc')
    .limit(limit + 1)

  const awake = includeSnoozed
    ? query
    : query.where('activeSnoozes.messageId', 'is', null)

  const rows = await (reasonId
    ? awake.where('latestReasonDetails.reasonId', '=', reasonId)
    : awake
  ).execute()

  return {
    bookmarks: rows
      .slice(0, limit)
      .map(
        ({
          attachments,
          deletedUpstream,
          discordGuildId,
          embeds,
          reactions,
          replyReference,
          ...bookmark
        }) => ({
          ...bookmark,
          attachments: messageAttachmentsSchema.parse(
            JSON.parse(attachments ?? '[]')
          ),
          deletedUpstream: deletedUpstream === 1,
          embeds: messageEmbedsSchema.parse(JSON.parse(embeds ?? '[]')),
          jumpUrl: `https://discord.com/channels/${discordGuildId}/${bookmark.discordChannelId}/${bookmark.discordMessageId}`,
          reactions: messageReactionsSchema.parse(
            JSON.parse(reactions ?? '[]')
          ),
          repliedTo: storedRepliedTo(replyReference),
        })
      ),
    truncated: rows.length > limit,
  }
})

const resolveBookmark = applySchema(
  resolveBookmarkSchema,
  bookmarksContextSchema
)(async ({ messageId }, context) => {
  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.id', '=', messageId)
    .executeTakeFirst()

  if (!message) throw unknownMessageError()

  const state = await readBookmarkState(message.id)

  if (state?.bookmarked !== 1) {
    throw new InputError(
      'That message is not bookmarked, so there is nothing to resolve',
      ['messageId']
    )
  }

  const removal = await db()
    .insertInto('bookmarkRemovals')
    .values({ id: newId(), messageId: message.id, source: 'mcp' })
    .returning(['source', 'createdAt'])
    .executeTakeFirstOrThrow()

  return {
    bookmark: {
      messageId: message.id,
      resolvedVia: removal.source,
      resolvedAt: removal.createdAt,
    },
  }
})

const snoozeBookmark = applySchema(
  snoozeBookmarkSchema,
  bookmarksContextSchema
)(async ({ messageId, until }, context) => {
  const untilInstant = new Date(until).toISOString()

  if (untilInstant <= new Date().toISOString()) {
    throw new InputError(
      'That snooze time has already passed. Pick a moment in the future, such as tomorrow morning.',
      ['until']
    )
  }

  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.id', '=', messageId)
    .executeTakeFirst()

  if (!message) throw unknownMessageError()

  const state = await readBookmarkState(message.id)

  if (state?.bookmarked !== 1) {
    throw new InputError(
      'That message is not bookmarked, so there is nothing to snooze',
      ['messageId']
    )
  }

  const snooze = await db()
    .insertInto('bookmarkSnoozes')
    .values({ id: newId(), messageId: message.id, until: untilInstant })
    .returning(['until', 'createdAt'])
    .executeTakeFirstOrThrow()

  return {
    bookmark: {
      messageId: message.id,
      snoozedUntil: snooze.until,
      snoozedAt: snooze.createdAt,
    },
  }
})

export {
  addBookmarkByLink,
  addBookmarkReason,
  editBookmarkReason,
  listBookmarkReasons,
  listBookmarks,
  resolveBookmark,
  retireBookmarkReason,
  setBookmarkReason,
  snoozeBookmark,
}
