import { randomBytes, randomUUID } from 'node:crypto'
import { ownerCaps } from '~/business/auth.server'
import { db } from '~/db/db.server'
import { newId } from '~/framework/db.server'

type ChannelAttributes = {
  guildId?: string
  name?: string
  topic?: string
  category?: string
  isThread?: number
  position?: number
}

type MemberAttributes = {
  username?: string
  displayName?: string
}

type MessageAttributes = {
  channelId?: string
  authorMemberId?: string
  content?: string
  discordCreatedAt?: string
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

async function createChannel({
  guildId,
  name = `channel-${randomUUID()}`,
  topic = `topic-${randomUUID()}`,
  category = `category-${randomUUID()}`,
  isThread = 0,
  position = 0,
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
        .values({
          id: newId(),
          channelId: channel.id,
          name,
          topic,
          category,
          isThread,
          position,
        })
        .execute()

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
  discordCreatedAt = new Date().toISOString(),
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
          discordMessageId: snowflake(),
          discordCreatedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('messageRevisions')
        .values({ id: newId(), messageId: message.id, content })
        .execute()

      return message
    })
}

async function createBookmarkedMessage({
  source = 'reaction',
  bookmarkedAt = new Date().toISOString(),
  ...messageAttributes
}: BookmarkedMessageAttributes = {}) {
  const message = await createMessage(messageAttributes)

  await db()
    .insertInto('bookmarkAdditions')
    .values({
      id: newId(),
      messageId: message.id,
      source,
      createdAt: bookmarkedAt,
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
    : await createGuild()

  return {
    owner: { discordUserId, guildId: guild.discordGuildId },
    ...ownerCaps(),
  }
}

export {
  createBookmarkedMessage,
  createChannel,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
  snowflake,
}
