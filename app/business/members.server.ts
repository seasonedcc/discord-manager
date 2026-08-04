import { applySchema } from 'composable-functions'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import { listMembersSchema } from '~/business/members.common'
import { db } from '~/db/db.server'

const membersContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

type MemberRow = {
  discordUserId: string
  displayName: string
  isYourBot: number
  username: string
}

function latestMemberDetails() {
  const ranked = db()
    .selectFrom('memberDetailRevisions')
    .select((eb) => [
      'memberId',
      'displayName',
      'username',
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
    .as('rankedDetails')

  return db()
    .selectFrom(ranked)
    .select(['memberId', 'displayName', 'username'])
    .where('rowNumber', '=', 1)
    .as('memberDetails')
}

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

function carries(text: string, needle: string) {
  return text.toLowerCase().includes(needle)
}

function inDiscordsMemberOrder(left: MemberRow, right: MemberRow) {
  return (
    left.displayName.localeCompare(right.displayName, 'en') ||
    left.username.localeCompare(right.username, 'en') ||
    (BigInt(left.discordUserId) < BigInt(right.discordUserId) ? -1 : 1)
  )
}

const listMembers = applySchema(
  listMembersSchema,
  membersContextSchema
)(async ({ query }, context) => {
  const roster = await db()
    .selectFrom('members')
    .innerJoin(latestMemberDetails(), 'memberDetails.memberId', 'members.id')
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('messages')
          .innerJoin('channels', 'channels.id', 'messages.channelId')
          .innerJoin('guilds', 'guilds.id', 'channels.guildId')
          .select('messages.id')
          .whereRef('messages.authorMemberId', '=', 'members.id')
          .where('guilds.discordGuildId', '=', context.owner.guildId)
      )
    )
    .select((eb) => [
      'members.discordUserId',
      'memberDetails.displayName',
      'memberDetails.username',
      eb(
        'members.discordUserId',
        '=',
        latestBotIdentityOf(context.owner.guildId)
      )
        .$castTo<number>()
        .as('isYourBot'),
    ])
    .execute()

  const needle = query?.toLowerCase()

  return {
    members: roster
      .filter(
        ({ displayName, username }) =>
          needle === undefined ||
          carries(displayName, needle) ||
          carries(username, needle)
      )
      .sort(inDiscordsMemberOrder)
      .map(({ isYourBot, ...member }) => ({
        ...member,
        ...(isYourBot === 1 ? { isYourBot: true } : {}),
      })),
  }
})

export { listMembers }
