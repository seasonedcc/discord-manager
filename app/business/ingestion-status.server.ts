import { applySchema } from 'composable-functions'
import { sql } from 'kysely'
import { z } from 'zod'
import { ownerContextSchema } from '~/business/auth.server'
import {
  type BackfillStatus,
  backfillStatusCopy,
  gatewayActivityCopy,
  readIngestionStatusSchema,
} from '~/business/ingestion-status.common'
import {
  backfillStallThresholdMinutes,
  deriveGatewayActivity,
} from '~/business/ingestion.common'
import { db } from '~/db/db.server'

type ChannelBackfillState = Exclude<BackfillStatus, 'never'> | 'neverRan'

const ingestionStatusContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

const backfillSilentSince = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now', ${`-${backfillStallThresholdMinutes} minutes`})`

function newestEventAt(
  table: 'gatewayConnections' | 'gatewayDisconnections' | 'gatewayHeartbeats'
) {
  return db()
    .selectFrom(table)
    .select('createdAt')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
}

function newestOf(instants: (string | null)[]) {
  return instants.reduce<string | null>(
    (newest, instant) =>
      instant && (!newest || instant > newest) ? instant : newest,
    null
  )
}

function latestChannelNames() {
  const ranked = db()
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
    .as('rankedNames')

  return db()
    .selectFrom(ranked)
    .select(['channelId', 'name'])
    .where('rowNumber', '=', 1)
    .as('channelNames')
}

function newestRunPerChannel() {
  const ranked = db()
    .selectFrom('backfillRuns')
    .select((eb) => [
      'id',
      'channelId',
      'createdAt as startedAt',
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
    .as('rankedRuns')

  return db()
    .selectFrom(ranked)
    .select(['id', 'channelId', 'startedAt'])
    .where('rowNumber', '=', 1)
    .as('newestRuns')
}

function furthestProgressPerRun() {
  return db()
    .selectFrom('backfillRunProgress')
    .groupBy('backfillRunId')
    .select((eb) => [
      'backfillRunId',
      eb.fn.max('fetchedMessageCount').as('fetchedMessageCount'),
      eb.fn.max('storedMessageCount').as('storedMessageCount'),
      eb.fn.max('createdAt').as('lastProgressAt'),
    ])
    .as('furthestProgress')
}

function channelBackfillStates(guildId: string) {
  return db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin(latestChannelNames(), 'channelNames.channelId', 'channels.id')
    .leftJoin(newestRunPerChannel(), 'newestRuns.channelId', 'channels.id')
    .leftJoin(
      furthestProgressPerRun(),
      'furthestProgress.backfillRunId',
      'newestRuns.id'
    )
    .where('guilds.discordGuildId', '=', guildId)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('channelRemovals')
            .select('channelRemovals.id')
            .whereRef('channelRemovals.channelId', '=', 'channels.id')
        )
      )
    )
    .select((eb) => [
      'channelNames.name',
      'newestRuns.startedAt',
      eb.fn
        .coalesce('furthestProgress.fetchedMessageCount', sql<number>`0`)
        .as('fetchedMessageCount'),
      eb.fn
        .coalesce('furthestProgress.storedMessageCount', sql<number>`0`)
        .as('storedMessageCount'),
      eb
        .case()
        .when('newestRuns.id', 'is', null)
        .then('neverRan')
        .when(
          eb.exists(
            eb
              .selectFrom('backfillRunFailures')
              .select('backfillRunFailures.id')
              .whereRef(
                'backfillRunFailures.backfillRunId',
                '=',
                'newestRuns.id'
              )
          )
        )
        .then('failed')
        .when(
          eb.exists(
            eb
              .selectFrom('backfillRunCompletions')
              .select('backfillRunCompletions.id')
              .whereRef(
                'backfillRunCompletions.backfillRunId',
                '=',
                'newestRuns.id'
              )
          )
        )
        .then('completed')
        .when(
          eb.fn.coalesce(
            'furthestProgress.lastProgressAt',
            'newestRuns.startedAt'
          ),
          '<',
          backfillSilentSince
        )
        .then('stalled')
        .else('running')
        .end()
        .$castTo<ChannelBackfillState>()
        .as('state'),
    ])
}

function worstChannelState({
  channels,
  neverRanChannelCount,
}: {
  channels: {
    completed: number
    failed: number
    running: number
    stalled: number
  }
  neverRanChannelCount: number
}): BackfillStatus {
  if (channels.failed > 0) return 'failed'
  if (channels.stalled > 0) return 'stalled'
  if (channels.running > 0 || neverRanChannelCount > 0) return 'running'
  if (channels.completed > 0) return 'completed'

  return 'never'
}

const readIngestionStatus = applySchema(
  readIngestionStatusSchema,
  ingestionStatusContextSchema
)(async (_input, context) => {
  const connection = await newestEventAt('gatewayConnections')
  const disconnection = await newestEventAt('gatewayDisconnections')
  const heartbeat = await newestEventAt('gatewayHeartbeats')

  const states = await channelBackfillStates(context.owner.guildId).execute()
  const channelsIn = (state: ChannelBackfillState) =>
    states.filter((channel) => channel.state === state)

  const observedAt = new Date().toISOString()
  const lastConnectedAt = connection?.createdAt ?? null
  const lastDisconnectedAt = disconnection?.createdAt ?? null
  const lastAliveAt = newestOf([lastConnectedAt, heartbeat?.createdAt ?? null])
  const activity = deriveGatewayActivity({
    lastAliveAt,
    lastDisconnectedAt,
    observedAt,
  })
  const channels = {
    completed: channelsIn('completed').length,
    failed: channelsIn('failed').length,
    running: channelsIn('running').length,
    stalled: channelsIn('stalled').length,
  }
  const neverRanChannelCount = channelsIn('neverRan').length
  const status = worstChannelState({ channels, neverRanChannelCount })

  return {
    ingestion: {
      observedAt,
      gateway: {
        activity,
        lastAliveAt,
        lastConnectedAt,
        lastDisconnectedAt,
        ...gatewayActivityCopy[activity],
      },
      backfill: {
        status,
        channels,
        neverRanChannelCount,
        failedChannelNames: channelsIn('failed').map(({ name }) => name),
        fetchedMessageCount: states.reduce(
          (total, channel) => total + channel.fetchedMessageCount,
          0
        ),
        storedMessageCount: states.reduce(
          (total, channel) => total + channel.storedMessageCount,
          0
        ),
        lastRunStartedAt: newestOf(states.map(({ startedAt }) => startedAt)),
        ...backfillStatusCopy[status],
      },
    },
  }
})

export { readIngestionStatus }
