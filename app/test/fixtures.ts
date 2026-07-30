import { randomBytes, randomUUID } from 'node:crypto'
import { ownerCaps } from '~/business/auth.server'
import { db } from '~/db/db.server'
import { env } from '~/env.server'
import { newId } from '~/framework/db.server'

type ChannelAttributes = {
  guildId?: string
  name?: string
  topic?: string
  category?: string
  isThread?: number
  position?: number
  archived?: boolean
}

type MemberAttributes = {
  username?: string
  displayName?: string
}

type MessageAttributes = {
  channelId?: string
  authorMemberId?: string
  content?: string
  discordMessageId?: string
  discordCreatedAt?: string
  mentionedDiscordUserIds?: string[]
}

type BookmarkedMessageAttributes = MessageAttributes & {
  source?: 'reaction' | 'mcp'
  bookmarkedAt?: string
}

type OwnerContextAttributes = {
  guildId?: string
  discordUserId?: string
}

const smallestSnowflake = 100000000000000000n
const snowflakeRange = 900000000000000000n

function snowflake() {
  const entropy = randomBytes(8).readBigUInt64BE() % snowflakeRange

  return (smallestSnowflake + entropy).toString()
}

async function createGuild() {
  return await db()
    .insertInto('guilds')
    .values({ id: newId(), discordGuildId: snowflake() })
    .returningAll()
    .executeTakeFirstOrThrow()
}

async function configuredGuild() {
  const discordGuildId = env().discordGuildId

  await db()
    .insertInto('guilds')
    .values({ id: newId(), discordGuildId })
    .onConflict((oc) => oc.doNothing())
    .execute()

  return await db()
    .selectFrom('guilds')
    .selectAll()
    .where('discordGuildId', '=', discordGuildId)
    .executeTakeFirstOrThrow()
}

async function createChannel({
  guildId,
  name = `channel-${randomUUID()}`,
  topic,
  category,
  isThread = 0,
  position,
  archived = false,
}: ChannelAttributes = {}) {
  const resolvedGuildId = guildId ?? (await createGuild()).id

  return await db()
    .transaction()
    .execute(async (trx) => {
      const channel = await trx
        .insertInto('channels')
        .values({
          id: newId(),
          guildId: resolvedGuildId,
          discordChannelId: snowflake(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('channelDetailRevisions')
        .values({ id: newId(), channelId: channel.id, name, isThread })
        .execute()

      if (topic !== undefined) {
        await trx
          .insertInto('channelTopicChanges')
          .values({ id: newId(), channelId: channel.id, topic })
          .execute()
      }

      if (category !== undefined) {
        await trx
          .insertInto('channelCategoryChanges')
          .values({ id: newId(), channelId: channel.id, category })
          .execute()
      }

      if (position !== undefined) {
        await trx
          .insertInto('channelPositionChanges')
          .values({ id: newId(), channelId: channel.id, position })
          .execute()
      }

      if (archived) {
        await trx
          .insertInto('channelArchivings')
          .values({ id: newId(), channelId: channel.id })
          .execute()
      }

      return channel
    })
}

async function createMember({
  username = `username-${randomUUID()}`,
  displayName = `display-name-${randomUUID()}`,
}: MemberAttributes = {}) {
  return await db()
    .transaction()
    .execute(async (trx) => {
      const member = await trx
        .insertInto('members')
        .values({ id: newId(), discordUserId: snowflake() })
        .returningAll()
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('memberDetailRevisions')
        .values({ id: newId(), memberId: member.id, username, displayName })
        .execute()

      return member
    })
}

async function createMessage({
  channelId,
  authorMemberId,
  content = `content-${randomUUID()}`,
  discordMessageId = snowflake(),
  discordCreatedAt = new Date().toISOString(),
  mentionedDiscordUserIds = [],
}: MessageAttributes = {}) {
  const resolvedChannelId = channelId ?? (await createChannel()).id
  const resolvedAuthorMemberId = authorMemberId ?? (await createMember()).id

  return await db()
    .transaction()
    .execute(async (trx) => {
      const message = await trx
        .insertInto('messages')
        .values({
          id: newId(),
          channelId: resolvedChannelId,
          authorMemberId: resolvedAuthorMemberId,
          discordMessageId,
          discordCreatedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      const revision = await trx
        .insertInto('messageRevisions')
        .values({ id: newId(), messageId: message.id, content })
        .returning('id')
        .executeTakeFirstOrThrow()

      if (mentionedDiscordUserIds.length > 0) {
        await trx
          .insertInto('messageRevisionUserMentions')
          .values(
            mentionedDiscordUserIds.map((mentionedDiscordUserId) => ({
              id: newId(),
              mentionedDiscordUserId,
              messageRevisionId: revision.id,
            }))
          )
          .execute()
      }

      return message
    })
}

async function createBookmarkedMessage({
  source = 'reaction',
  bookmarkedAt,
  ...messageAttributes
}: BookmarkedMessageAttributes = {}) {
  const message = await createMessage(messageAttributes)

  await db()
    .insertInto('bookmarkAdditions')
    .values({
      id: newId(),
      messageId: message.id,
      source,
      ...(bookmarkedAt === undefined ? {} : { createdAt: bookmarkedAt }),
    })
    .execute()

  return message
}

async function ownerContext({
  guildId,
  discordUserId = snowflake(),
}: OwnerContextAttributes = {}) {
  const guild = guildId
    ? await db()
        .selectFrom('guilds')
        .select('discordGuildId')
        .where('id', '=', guildId)
        .executeTakeFirstOrThrow()
    : await configuredGuild()

  return {
    owner: { discordUserId, guildId: guild.discordGuildId },
    ...ownerCaps(),
  }
}

export {
  configuredGuild,
  createBookmarkedMessage,
  createChannel,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
  snowflake,
}
