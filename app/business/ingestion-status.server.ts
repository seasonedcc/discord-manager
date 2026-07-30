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

function newestRunPerChannel(guildId: string) {
  return db()
    .selectFrom('backfillRuns')
    .innerJoin('channels', 'channels.id', 'backfillRuns.channelId')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .where('guilds.discordGuildId', '=', guildId)
    .select((eb) => [
      'backfillRuns.id',
      'backfillRuns.createdAt as startedAt',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('backfillRuns.channelId')
            .orderBy('backfillRuns.createdAt', 'desc')
            .orderBy('backfillRuns.id', 'desc')
        )
        .as('rowNumber'),
    ])
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

function runFacts(guildId: string) {
  return db()
    .selectFrom(newestRunPerChannel(guildId))
    .leftJoin(
      furthestProgressPerRun(),
      'furthestProgress.backfillRunId',
      'newestRuns.id'
    )
    .where('newestRuns.rowNumber', '=', 1)
    .select((eb) => [
      'newestRuns.startedAt',
      eb.fn
        .coalesce('furthestProgress.fetchedMessageCount', sql<number>`0`)
        .as('fetchedMessageCount'),
      eb.fn
        .coalesce('furthestProgress.storedMessageCount', sql<number>`0`)
        .as('storedMessageCount'),
      eb.fn
        .coalesce('furthestProgress.lastProgressAt', 'newestRuns.startedAt')
        .as('lastHeardFromAt'),
      eb
        .exists(
          eb
            .selectFrom('backfillRunCompletions')
            .select('backfillRunCompletions.id')
            .whereRef(
              'backfillRunCompletions.backfillRunId',
              '=',
              'newestRuns.id'
            )
        )
        .$castTo<number>()
        .as('completed'),
      eb
        .exists(
          eb
            .selectFrom('backfillRunFailures')
            .select('backfillRunFailures.id')
            .whereRef('backfillRunFailures.backfillRunId', '=', 'newestRuns.id')
        )
        .$castTo<number>()
        .as('failed'),
    ])
    .as('runFacts')
}

function runStates(guildId: string) {
  return db()
    .selectFrom(runFacts(guildId))
    .select((eb) => [
      'startedAt',
      'fetchedMessageCount',
      'storedMessageCount',
      eb
        .case()
        .when('failed', '=', 1)
        .then('failed')
        .when('completed', '=', 1)
        .then('completed')
        .when('lastHeardFromAt', '<', backfillSilentSince)
        .then('stalled')
        .else('running')
        .end()
        .$castTo<BackfillStatus>()
        .as('state'),
    ])
    .as('runStates')
}

function worstChannelState(channels: {
  completed: number
  failed: number
  running: number
  stalled: number
}): BackfillStatus {
  if (channels.failed > 0) return 'failed'
  if (channels.stalled > 0) return 'stalled'
  if (channels.running > 0) return 'running'
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

  const backfill = await db()
    .selectFrom(runStates(context.owner.guildId))
    .select((eb) => [
      eb.fn
        .count<number>('state')
        .filterWhere('state', '=', 'completed')
        .as('completed'),
      eb.fn
        .count<number>('state')
        .filterWhere('state', '=', 'failed')
        .as('failed'),
      eb.fn
        .count<number>('state')
        .filterWhere('state', '=', 'running')
        .as('running'),
      eb.fn
        .count<number>('state')
        .filterWhere('state', '=', 'stalled')
        .as('stalled'),
      eb.fn
        .coalesce(eb.fn.sum<number>('fetchedMessageCount'), sql<number>`0`)
        .as('fetchedMessageCount'),
      eb.fn
        .coalesce(eb.fn.sum<number>('storedMessageCount'), sql<number>`0`)
        .as('storedMessageCount'),
      eb.fn.max('startedAt').$castTo<string | null>().as('lastRunStartedAt'),
    ])
    .executeTakeFirstOrThrow()

  const observedAt = new Date().toISOString()
  const lastConnectedAt = connection?.createdAt ?? null
  const lastDisconnectedAt = disconnection?.createdAt ?? null
  const lastAliveAt = newestOf([lastConnectedAt, heartbeat?.createdAt ?? null])
  const activity = deriveGatewayActivity({
    lastAliveAt,
    lastDisconnectedAt,
    observedAt,
  })
  const { completed, failed, running, stalled, ...counts } = backfill
  const channels = { completed, failed, running, stalled }
  const status = worstChannelState(channels)

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
        ...counts,
        ...backfillStatusCopy[status],
      },
    },
  }
})

export { readIngestionStatus }
