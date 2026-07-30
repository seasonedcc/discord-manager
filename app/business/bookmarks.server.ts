import { InputError, applySchema } from 'composable-functions'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  addBookmarkByLinkSchema,
  listBookmarksSchema,
  resolveBookmarkSchema,
  snoozeBookmarkSchema,
} from '~/business/bookmarks.common'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

const discordMessageLinkPattern =
  /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/

const bookmarksContextSchema = ownerContextSchema.extend({
  canManageBookmarks: z.literal(true),
})

const nowInstant = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`

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

const addBookmarkByLink = applySchema(
  addBookmarkByLinkSchema,
  bookmarksContextSchema
)(async ({ messageLink }, context) => {
  const link = messageLink.match(discordMessageLinkPattern)

  if (!link) {
    throw new InputError(
      'Use a Discord message link that looks like https://discord.com/channels/<server>/<channel>/<message>',
      ['messageLink']
    )
  }

  const [, linkGuildId, , linkMessageId] = link

  if (linkGuildId !== context.owner.guildId) {
    throw new InputError(
      'That link points at a different Discord server than this deployment manages',
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

  const state = await readBookmarkState(message.id)

  if (state?.bookmarked === 1) {
    return {
      bookmark: {
        messageId: message.id,
        source: state.source,
        bookmarkedAt: state.createdAt,
      },
    }
  }

  const addition = await db()
    .insertInto('bookmarkAdditions')
    .values({ id: newId(), messageId: message.id, source: 'mcp' })
    .returning(['source', 'createdAt'])
    .executeTakeFirstOrThrow()

  return {
    bookmark: {
      messageId: message.id,
      source: addition.source,
      bookmarkedAt: addition.createdAt,
    },
  }
})

const listBookmarks = applySchema(
  listBookmarksSchema,
  bookmarksContextSchema
)(async ({ includeSnoozed }, context) => {
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
      'activeSnoozes.until as snoozedUntil',
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
    .orderBy('messages.discordMessageId', 'desc')

  const rows = await (includeSnoozed
    ? query
    : query.where('activeSnoozes.messageId', 'is', null)
  ).execute()

  return {
    bookmarks: rows.map(({ discordGuildId, deletedUpstream, ...bookmark }) => ({
      ...bookmark,
      deletedUpstream: deletedUpstream === 1,
      jumpUrl: `https://discord.com/channels/${discordGuildId}/${bookmark.discordChannelId}/${bookmark.discordMessageId}`,
    })),
  }
})

const resolveBookmark = applySchema(
  resolveBookmarkSchema,
  bookmarksContextSchema
)(async ({ messageId }, context) => {
  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.id', '=', messageId)
    .executeTakeFirst()

  if (!message) {
    throw new InputError(
      'That message is not in the server this deployment manages',
      ['messageId']
    )
  }

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
      source: removal.source,
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
    throw new InputError('Pick a snooze time in the future', ['until'])
  }

  const message = await messagesInGuild(context.owner.guildId)
    .where('messages.id', '=', messageId)
    .executeTakeFirst()

  if (!message) {
    throw new InputError(
      'That message is not in the server this deployment manages',
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

export { addBookmarkByLink, listBookmarks, resolveBookmark, snoozeBookmark }
