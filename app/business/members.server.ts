import { applySchema } from 'composable-functions'
import type { ExpressionBuilder } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import { listMembersSchema } from '~/business/members.common'
import { db } from '~/db/db.server'
import type { DB } from '~/db/types'

const membersContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

function latestMemberDetailsOf(eb: ExpressionBuilder<DB, 'members'>) {
  return eb
    .selectFrom('memberDetailRevisions')
    .select('memberDetailRevisions.id')
    .whereRef('memberDetailRevisions.memberId', '=', 'members.id')
    .orderBy('memberDetailRevisions.createdAt', 'desc')
    .orderBy('memberDetailRevisions.id', 'desc')
    .limit(1)
}

function latestBotIdentityOf(guildId: string) {
  return db()
    .selectFrom('gatewayIdentifications')
    .select('gatewayIdentifications.botDiscordUserId')
    .where('gatewayIdentifications.guildId', '=', ({ selectFrom }) =>
      selectFrom('guilds')
        .select('guilds.id')
        .where('guilds.discordGuildId', '=', guildId)
    )
    .orderBy('gatewayIdentifications.createdAt', 'desc')
    .orderBy('gatewayIdentifications.id', 'desc')
    .limit(1)
}

const dottedOrDotlessI = /i\u0307|\u0131/gu

function caseFolded(text: string) {
  return text.toLowerCase().replace(dottedOrDotlessI, 'i')
}

function carries(text: string, needle: string) {
  return caseFolded(text).includes(needle)
}

const listMembers = applySchema(
  listMembersSchema,
  membersContextSchema
)(async ({ query }, context) => {
  const roster = await db()
    .selectFrom('members')
    .innerJoin('memberDetailRevisions as latestMemberDetails', (join) =>
      join.on((eb) =>
        eb('latestMemberDetails.id', '=', latestMemberDetailsOf(eb))
      )
    )
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
      'latestMemberDetails.displayName',
      'latestMemberDetails.username',
      eb(
        'members.discordUserId',
        '=',
        latestBotIdentityOf(context.owner.guildId)
      )
        .$castTo<number | null>()
        .as('isYourBot'),
    ])
    .execute()

  const needle = query === undefined ? undefined : caseFolded(query)
  const matching =
    needle === undefined
      ? roster
      : roster.filter(
          ({ displayName, username }) =>
            carries(displayName, needle) || carries(username, needle)
        )

  matching.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName, 'en') ||
      left.username.localeCompare(right.username, 'en') ||
      (BigInt(left.discordUserId) < BigInt(right.discordUserId) ? -1 : 1)
  )

  return {
    members: matching.map(({ isYourBot, ...member }) => ({
      ...member,
      ...(isYourBot === 1 ? { isYourBot: true } : {}),
    })),
  }
})

export { listMembers }
