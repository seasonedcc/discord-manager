import { fromSuccess } from 'composable-functions'
import { catchUpSince, listMentions } from '~/business/digests.server'
import { countMessages } from '~/business/messages.server'
import { createBusyGuild } from '~/test/fixtures'
import { beforeAll, describe, it } from '~/test/prelude'
import { expectEveryPlan } from '~/test/query-plans'

const latestStateTables = [
  'message_revisions',
  'channel_detail_revisions',
  'member_detail_revisions',
  'gateway_identifications',
]

const serverWideWindowStep =
  'SEARCH messages USING INDEX messages_discord_created_at_index (discord_created_at>?)'

const channelWindowStep =
  'SEARCH messages USING INDEX messages_channel_id_discord_created_at_index (channel_id=? AND discord_created_at>?)'

const latestRevisionStep =
  'SEARCH message_revisions USING COVERING INDEX message_revisions_message_id_created_at_id_index (message_id=?)'

const digestLookupSteps = [
  latestRevisionStep,
  'SEARCH channel_detail_revisions USING COVERING INDEX channel_detail_revisions_channel_id_created_at_id_index (channel_id=?)',
  'SEARCH member_detail_revisions USING COVERING INDEX member_detail_revisions_member_id_created_at_id_index (member_id=?)',
]

const latestBotIdentityStep =
  'SEARCH gateway_identifications USING INDEX gateway_identifications_guild_id_created_at_id_index (guild_id=?)'

let busyGuild: Awaited<ReturnType<typeof createBusyGuild>>
let lastDay: string

beforeAll(async () => {
  busyGuild = await createBusyGuild()
  lastDay = new Date(
    Date.parse(busyGuild.lastMessageAt) - 24 * 60 * 60 * 1000
  ).toISOString()
})

describe('catchUpSince', () => {
  it('walks a server-wide window through the messages index, looking up each message’s latest state', async () => {
    for (const since of [lastDay, busyGuild.firstMessageAt]) {
      await expectEveryPlan(
        () => fromSuccess(catchUpSince)({ since }, busyGuild.context),
        {
          latestStateTables,
          scanning: ['guilds'],
          reaches: [serverWideWindowStep, ...digestLookupSteps],
        }
      )
    }
  })

  it('walks one channel through that channel’s messages index', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(catchUpSince)(
          {
            since: busyGuild.firstMessageAt,
            channelId: busyGuild.channelIds[0],
          },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [channelWindowStep, ...digestLookupSteps],
      }
    )
  })
})

describe('listMentions', () => {
  it('walks a server-wide window through the messages index, looking up each message’s latest state', async () => {
    for (const since of [lastDay, busyGuild.firstMessageAt]) {
      await expectEveryPlan(
        () => fromSuccess(listMentions)({ since }, busyGuild.context),
        {
          latestStateTables,
          scanning: ['guilds'],
          reaches: [
            serverWideWindowStep,
            ...digestLookupSteps,
            latestBotIdentityStep,
          ],
        }
      )
    }
  })
})

describe('countMessages', () => {
  it('counts a server-wide window through the messages index', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(countMessages)(
          { since: lastDay, groupBy: 'day' },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [serverWideWindowStep],
      }
    )
  })

  it('matches text in a server-wide window against each message’s latest revision', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(countMessages)(
          { contentContains: 'message 1', since: lastDay, groupBy: 'day' },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [serverWideWindowStep, latestRevisionStep],
      }
    )
  })

  it('matches text across the whole server without ranking every revision', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(countMessages)(
          { contentContains: 'message 1' },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds', 'messages'],
        reaches: [latestRevisionStep],
      }
    )
  })
})
