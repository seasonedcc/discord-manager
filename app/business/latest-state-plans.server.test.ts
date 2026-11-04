import { fromSuccess } from 'composable-functions'
import { listChannels } from '~/business/channels.server'
import { readIngestionStatus } from '~/business/ingestion-status.server'
import {
  listBackfillableChannels,
  reconcileThreadArchivings,
  recordChannelArchiving,
} from '~/business/ingestion.server'
import { listMembers } from '~/business/members.server'
import { readMessageSendStatus } from '~/business/sending.server'
import { createThread } from '~/business/threads.server'
import { createBusyChannelHistory, createBusyGuild } from '~/test/fixtures'
import { beforeAll, describe, it } from '~/test/prelude'
import { expectEveryPlan } from '~/test/query-plans'

const latestStateTables = [
  'channel_detail_revisions',
  'member_detail_revisions',
  'backfill_runs',
  'backfill_run_progress',
  'channel_topic_changes',
  'channel_topic_clearings',
  'channel_category_changes',
  'channel_category_clearings',
  'channel_position_changes',
  'channel_position_clearings',
  'channel_archivings',
  'channel_unarchivings',
  'message_send_deliveries',
  'message_send_failures',
  'message_send_skips',
]

const latestChannelDetailsStep =
  'SEARCH channel_detail_revisions USING COVERING INDEX channel_detail_revisions_channel_id_created_at_id_index (channel_id=?)'

const latestArchivedStateSteps = [
  'SEARCH channel_archivings USING COVERING INDEX channel_archivings_channel_id_created_at_id_index (channel_id=?)',
  'SEARCH channel_unarchivings USING COVERING INDEX channel_unarchivings_channel_id_created_at_id_index (channel_id=?)',
]

let busyGuild: Awaited<ReturnType<typeof createBusyGuild>>
let history: Awaited<ReturnType<typeof createBusyChannelHistory>>

beforeAll(async () => {
  busyGuild = await createBusyGuild()
  history = await createBusyChannelHistory({
    channelIds: busyGuild.channelIds,
  })
})

describe('readIngestionStatus', () => {
  it('looks up each channel’s newest backfill run and its progress instead of ranking every run', async () => {
    await expectEveryPlan(
      () => fromSuccess(readIngestionStatus)({}, busyGuild.context),
      {
        latestStateTables,
        scanning: [
          'guilds',
          'channels',
          'gateway_connections',
          'gateway_disconnections',
          'gateway_heartbeats',
        ],
        reaches: [
          latestChannelDetailsStep,
          'SEARCH backfill_runs USING COVERING INDEX backfill_runs_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH backfill_run_progress USING INDEX backfill_run_progress_run_id_created_at_index (backfill_run_id=?)',
        ],
      }
    )
  })
})

describe('listChannels', () => {
  it('looks up each channel’s latest details, topic, category, position and archived state', async () => {
    await expectEveryPlan(
      () => fromSuccess(listChannels)({}, busyGuild.context),
      {
        latestStateTables,
        scanning: ['guilds', 'channels'],
        reaches: [
          latestChannelDetailsStep,
          'SEARCH channel_topic_changes USING INDEX channel_topic_changes_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH channel_topic_clearings USING COVERING INDEX channel_topic_clearings_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH channel_category_changes USING INDEX channel_category_changes_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH channel_category_clearings USING COVERING INDEX channel_category_clearings_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH channel_position_changes USING INDEX channel_position_changes_channel_id_created_at_id_index (channel_id=?)',
          'SEARCH channel_position_clearings USING COVERING INDEX channel_position_clearings_channel_id_created_at_id_index (channel_id=?)',
          ...latestArchivedStateSteps,
        ],
      }
    )
  })
})

describe('listMembers', () => {
  it('looks up each member’s latest details', async () => {
    await expectEveryPlan(
      () => fromSuccess(listMembers)({}, busyGuild.context),
      {
        latestStateTables,
        scanning: ['members', 'guilds', 'gateway_identifications'],
        reaches: [
          'SEARCH member_detail_revisions USING COVERING INDEX member_detail_revisions_member_id_created_at_id_index (member_id=?)',
        ],
      }
    )
  })
})

describe('readMessageSendStatus', () => {
  it('looks up the send’s latest outcome, delivery, failure and skip', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(readMessageSendStatus)(
          { requestId: history.retriedRequestId },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [
          'SEARCH message_send_deliveries USING COVERING INDEX message_send_deliveries_request_id_created_at_id_index (message_send_request_id=?)',
          'SEARCH message_send_failures USING COVERING INDEX message_send_failures_request_id_created_at_id_index (message_send_request_id=?)',
          'SEARCH message_send_skips USING COVERING INDEX message_send_skips_request_id_created_at_id_index (message_send_request_id=?)',
        ],
      }
    )
  })
})

describe('createThread', () => {
  it('looks up the parent channel’s latest details', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(
          createThread(async () => ({ discordChannelId: crypto.randomUUID() }))
        )(
          { channelId: busyGuild.channelIds[1], name: 'incident' },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: [
          'guilds',
          'thread_creation_requests',
          'thread_creation_request_anchors',
          'thread_creations',
          'thread_creation_failures',
          'thread_creation_skips',
        ],
        reaches: [latestChannelDetailsStep],
      }
    )
  })
})

describe('listBackfillableChannels', () => {
  it('looks up each channel’s latest archived state and latest archiving', async () => {
    await expectEveryPlan(
      () => fromSuccess(listBackfillableChannels)({}, busyGuild.context),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [
          ...latestArchivedStateSteps,
          'SEARCH backfill_runs USING COVERING INDEX backfill_runs_channel_id_created_at_id_index (channel_id=? AND created_at>?)',
        ],
      }
    )
  })
})

describe('reconcileThreadArchivings', () => {
  it('looks up each channel’s latest details and archived state', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(reconcileThreadArchivings)(
          {
            activeThreadDiscordChannelIds:
              history.activeThreadDiscordChannelIds,
          },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: [latestChannelDetailsStep, ...latestArchivedStateSteps],
      }
    )
  })
})

describe('recordChannelArchiving', () => {
  it('looks up the channel’s latest archived state', async () => {
    await expectEveryPlan(
      () =>
        fromSuccess(recordChannelArchiving)(
          { discordChannelId: history.archivedThreadDiscordChannelId },
          busyGuild.context
        ),
      {
        latestStateTables,
        scanning: ['guilds'],
        reaches: latestArchivedStateSteps,
      }
    )
  })
})
