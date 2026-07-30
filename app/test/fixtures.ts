import { randomUUID } from 'node:crypto'
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

async function createGuild() {
  return await db()
    .insertInto('guilds')
    .values({ id: newId(), discordGuildId: randomUUID() })
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
          discordChannelId: randomUUID(),
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
        .values({ id: newId(), discordUserId: randomUUID() })
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
          discordMessageId: randomUUID(),
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

export { createChannel, createGuild, createMember, createMessage }
