import { fromSuccess } from 'composable-functions'
import { inboxBookmarkReasonId } from '~/business/bookmarks.common'
import {
  addBookmarkByLink,
  editBookmarkReason,
  listBookmarkReasons,
  listBookmarks,
} from '~/business/bookmarks.server'
import { createBusyBookmarks, createBusyGuild } from '~/test/fixtures'
import { beforeAll, describe, expect, it } from '~/test/prelude'
import {
  lookupsSortingTheirTieBreak,
  plansOf,
  scansBeyond,
} from '~/test/query-plans'

const latestStateTables = [
  'message_revisions',
  'channel_detail_revisions',
  'member_detail_revisions',
  'bookmark_additions',
  'bookmark_removals',
  'bookmark_snoozes',
  'bookmark_reason_assignments',
  'bookmark_reason_detail_revisions',
]

const latestBookmarkEventSteps = [
  'SEARCH bookmark_additions USING COVERING INDEX bookmark_additions_message_id_created_at_id_index (message_id=?)',
  'SEARCH bookmark_removals USING COVERING INDEX bookmark_removals_message_id_created_at_id_index (message_id=?)',
]

const latestReasonAssignmentStep =
  'SEARCH bookmark_reason_assignments USING COVERING INDEX bookmark_reason_assignments_message_id_created_at_id_index (message_id=?)'

const latestReasonDetailsStep =
  'SEARCH bookmark_reason_detail_revisions USING COVERING INDEX bookmark_reason_detail_revisions_reason_id_created_at_id_index (reason_id=?)'

const latestSnoozeStep =
  'SEARCH bookmark_snoozes USING COVERING INDEX bookmark_snoozes_message_id_created_at_id_index (message_id=?)'

const bookmarkedMessageStep =
  'SEARCH messages USING INDEX sqlite_autoindex_messages_1 (id=?)'

const messageLookupSteps = [
  'SEARCH message_revisions USING COVERING INDEX message_revisions_message_id_created_at_id_index (message_id=?)',
  'SEARCH channel_detail_revisions USING COVERING INDEX channel_detail_revisions_channel_id_created_at_id_index (channel_id=?)',
  'SEARCH member_detail_revisions USING COVERING INDEX member_detail_revisions_member_id_created_at_id_index (member_id=?)',
]

let busyGuild: Awaited<ReturnType<typeof createBusyGuild>>
let busyBookmarks: Awaited<ReturnType<typeof createBusyBookmarks>>

beforeAll(async () => {
  busyGuild = await createBusyGuild()
  busyBookmarks = await createBusyBookmarks(busyGuild)
})

async function expectEveryPlan(
  read: () => Promise<unknown>,
  { reaches, scanning = [] }: { reaches: string[]; scanning?: string[] }
) {
  for (const { statistics, branches } of await plansOf(read)) {
    const steps = branches.flat()

    expect(
      steps.filter((step) => step.includes('AUTOMATIC')),
      `statistics ${statistics}`
    ).toEqual([])
    expect(
      scansBeyond(steps, ['guilds', ...scanning]),
      `statistics ${statistics}`
    ).toEqual([])
    expect(
      lookupsSortingTheirTieBreak(branches, latestStateTables),
      `statistics ${statistics}`
    ).toEqual([])

    for (const step of reaches) {
      expect(steps, `statistics ${statistics}`).toContain(step)
    }
  }
}

describe('listBookmarks', () => {
  it('walks the standing bookmarks, looking up each one’s latest state, whatever the filters', async () => {
    const [busyReasonId] = busyBookmarks.reasonIds

    for (const input of [
      {},
      { includeSnoozed: true },
      { reasonId: busyReasonId },
      { reasonId: inboxBookmarkReasonId },
      { includeSnoozed: true, reasonId: busyReasonId },
      { limit: 500 },
    ]) {
      await expectEveryPlan(
        () => fromSuccess(listBookmarks)(input, busyGuild.context),
        {
          reaches: [
            ...latestBookmarkEventSteps,
            bookmarkedMessageStep,
            latestReasonAssignmentStep,
            latestReasonDetailsStep,
            latestSnoozeStep,
            ...messageLookupSteps,
          ],
          scanning: ['standing_bookmarks'],
        }
      )
    }
  })
})

describe('listBookmarkReasons', () => {
  it('counts each reason’s standing bookmarks, looking up each one’s latest state', async () => {
    await expectEveryPlan(
      () => fromSuccess(listBookmarkReasons)({}, busyGuild.context),
      {
        reaches: [
          ...latestBookmarkEventSteps,
          bookmarkedMessageStep,
          latestReasonAssignmentStep,
          latestReasonDetailsStep,
        ],
        scanning: ['standing_bookmarks', 'bookmark_reasons'],
      }
    )
  })
})

describe('addBookmarkByLink', () => {
  it('reads one message’s bookmark state through that message’s own events', async () => {
    const {
      bookmarks: [bookmark],
    } = await fromSuccess(listBookmarks)({ limit: 1 }, busyGuild.context)

    await expectEveryPlan(
      () =>
        fromSuccess(addBookmarkByLink)(
          {
            messageLink: bookmark.jumpUrl,
            reasonId: busyBookmarks.reasonIds[1],
          },
          busyGuild.context
        ),
      {
        reaches: [...latestBookmarkEventSteps, latestReasonDetailsStep],
      }
    )
  })
})

describe('editBookmarkReason', () => {
  it('checks the new name against each active reason’s latest details', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(editBookmarkReason)(
          {
            reasonId: busyBookmarks.reasonIds[2],
            name: 'busy reason renamed',
            description: 'What the busy reason is for now',
          },
          busyGuild.context
        ),
      { reaches: [latestReasonDetailsStep], scanning: ['bookmark_reasons'] }
    )
  })
})
