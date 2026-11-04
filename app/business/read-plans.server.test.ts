import { fromSuccess } from 'composable-functions'
import { catchUpSince, listMentions } from '~/business/digests.server'
import { countMessages } from '~/business/messages.server'
import { createBusyGuild } from '~/test/fixtures'
import { beforeAll, describe, expect, it } from '~/test/prelude'
import { plansOf, wholeTableSteps } from '~/test/query-plans'

const latestStateTables = [
  'messages',
  'message_revisions',
  'channel_detail_revisions',
  'member_detail_revisions',
  'gateway_identifications',
]

const serverWideWindowStep =
  'SEARCH messages USING INDEX messages_discord_created_at_index (discord_created_at>?)'

const channelWindowStep =
  'SEARCH messages USING INDEX messages_channel_id_discord_created_at_index (channel_id=? AND discord_created_at>?)'

let busyGuild: Awaited<ReturnType<typeof createBusyGuild>>
let lastDay: string

beforeAll(async () => {
  busyGuild = await createBusyGuild()
  lastDay = new Date(
    Date.parse(busyGuild.lastMessageAt) - 24 * 60 * 60 * 1000
  ).toISOString()
})

async function expectEveryPlan(
  read: () => Promise<unknown>,
  { reaches, scanning = [] }: { reaches: string; scanning?: string[] }
) {
  for (const { statistics, steps } of await plansOf(read)) {
    expect(
      wholeTableSteps(
        steps,
        latestStateTables.filter((table) => !scanning.includes(table))
      ),
      `statistics ${statistics}`
    ).toEqual([])
    expect(steps, `statistics ${statistics}`).toContain(reaches)
  }
}

describe('catchUpSince', () => {
  it('walks a server-wide window through the messages index, looking up each message’s latest state', async () => {
    for (const since of [lastDay, busyGuild.firstMessageAt]) {
      await expectEveryPlan(
        () => fromSuccess(catchUpSince)({ since }, busyGuild.context),
        { reaches: serverWideWindowStep }
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
      { reaches: channelWindowStep }
    )
  })
})

describe('listMentions', () => {
  it('walks a server-wide window through the messages index, looking up each message’s latest state', async () => {
    for (const since of [lastDay, busyGuild.firstMessageAt]) {
      await expectEveryPlan(
        () => fromSuccess(listMentions)({ since }, busyGuild.context),
        { reaches: serverWideWindowStep }
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
      { reaches: serverWideWindowStep }
    )
  })

  it('matches text in a server-wide window against each message’s latest revision', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(countMessages)(
          { contentContains: 'message 1', since: lastDay, groupBy: 'day' },
          busyGuild.context
        ),
      { reaches: serverWideWindowStep }
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
        reaches:
          'SEARCH message_revisions USING COVERING INDEX message_revisions_message_id_created_at_id_index (message_id=?)',
        scanning: ['messages'],
      }
    )
  })
})
