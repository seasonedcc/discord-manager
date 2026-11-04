import { applySchema } from 'composable-functions'
import { type ExpressionBuilder, sql } from 'kysely'
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
import type { DB } from '~/db/types'

type ChannelBackfillState = Exclude<BackfillStatus, 'never'> | 'neverRan'

const ingestionStatusContextSchema = ownerContextSchema.extend({
  canReadMessages: z.literal(true),
})

const backfillSilentSince = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now', ${`-${backfillStallThresholdMinutes} minutes`})`

async function newestEventAt(
  table: 'gatewayConnections' | 'gatewayDisconnections' | 'gatewayHeartbeats'
) {
  const { newestAt } = await db()
    .selectFrom(table)
    .select((eb) => eb.fn.max<string | null>('createdAt').as('newestAt'))
    .executeTakeFirstOrThrow()

  return newestAt
}

function newestOf(instants: (string | null)[]) {
  return instants.reduce<string | null>(
    (newest, instant) =>
      instant && (!newest || instant > newest) ? instant : newest,
    null
  )
}

function latestChannelDetailsOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom('channelDetailRevisions')
    .select('channelDetailRevisions.id')
    .whereRef('channelDetailRevisions.channelId', '=', 'channels.id')
    .orderBy('channelDetailRevisions.createdAt', 'desc')
    .orderBy('channelDetailRevisions.id', 'desc')
    .limit(1)
}

function newestRunOf(eb: ExpressionBuilder<DB, 'channels'>) {
  return eb
    .selectFrom('backfillRuns')
    .select('backfillRuns.id')
    .whereRef('backfillRuns.channelId', '=', 'channels.id')
    .orderBy('backfillRuns.createdAt', 'desc')
    .orderBy('backfillRuns.id', 'desc')
    .limit(1)
}

function channelBackfillStates(guildId: string) {
  return db()
    .selectFrom('channels')
    .innerJoin('guilds', 'guilds.id', 'channels.guildId')
    .innerJoin('channelDetailRevisions as latestChannelDetails', (join) =>
      join.on((eb) =>
        eb('latestChannelDetails.id', '=', latestChannelDetailsOf(eb))
      )
    )
    .leftJoin('backfillRuns as newestRuns', (join) =>
      join.on((eb) => eb('newestRuns.id', '=', newestRunOf(eb)))
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
    .select((eb) => {
      const newestRunProgress = eb
        .selectFrom('backfillRunProgress')
        .whereRef('backfillRunProgress.backfillRunId', '=', 'newestRuns.id')

      return [
        'latestChannelDetails.name',
        'newestRuns.createdAt as startedAt',
        eb.fn
          .coalesce(
            newestRunProgress.select((progress) =>
              progress.fn
                .max('backfillRunProgress.fetchedMessageCount')
                .as('fetchedMessageCount')
            ),
            sql<number>`0`
          )
          .as('fetchedMessageCount'),
        eb.fn
          .coalesce(
            newestRunProgress.select((progress) =>
              progress.fn
                .max('backfillRunProgress.storedMessageCount')
                .as('storedMessageCount')
            ),
            sql<number>`0`
          )
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
            eb.and([
              eb.exists(
                eb
                  .selectFrom('backfillRunCompletions')
                  .select('backfillRunCompletions.id')
                  .whereRef(
                    'backfillRunCompletions.backfillRunId',
                    '=',
                    'newestRuns.id'
                  )
              ),
              eb.exists(
                eb
                  .selectFrom('backfillRunUnreadReactions')
                  .select('backfillRunUnreadReactions.id')
                  .whereRef(
                    'backfillRunUnreadReactions.backfillRunId',
                    '=',
                    'newestRuns.id'
                  )
              ),
            ])
          )
          .then('reactionsUnread')
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
              newestRunProgress.select((progress) =>
                progress.fn
                  .max('backfillRunProgress.createdAt')
                  .as('lastProgressAt')
              ),
              'newestRuns.createdAt'
            ),
            '<',
            backfillSilentSince
          )
          .then('stalled')
          .else('running')
          .end()
          .$castTo<ChannelBackfillState>()
          .as('state'),
      ]
    })
}

function worstChannelState({
  channels,
  neverRanChannelCount,
}: {
  channels: {
    completed: number
    failed: number
    reactionsUnread: number
    running: number
    stalled: number
  }
  neverRanChannelCount: number
}): BackfillStatus {
  if (channels.failed > 0) return 'failed'
  if (channels.stalled > 0) return 'stalled'
  if (channels.running > 0 || neverRanChannelCount > 0) return 'running'
  if (channels.reactionsUnread > 0) return 'reactionsUnread'
  if (channels.completed > 0) return 'completed'

  return 'never'
}

const readIngestionStatus = applySchema(
  readIngestionStatusSchema,
  ingestionStatusContextSchema
)(async (_input, context) => {
  const lastConnectedAt = await newestEventAt('gatewayConnections')
  const lastDisconnectedAt = await newestEventAt('gatewayDisconnections')
  const lastHeartbeatAt = await newestEventAt('gatewayHeartbeats')

  const states = await channelBackfillStates(context.owner.guildId).execute()
  const channelsIn = (state: ChannelBackfillState) =>
    states.filter((channel) => channel.state === state)

  const observedAt = new Date().toISOString()
  const lastAliveAt = newestOf([lastConnectedAt, lastHeartbeatAt])
  const activity = deriveGatewayActivity({
    lastAliveAt,
    lastDisconnectedAt,
    observedAt,
  })
  const channels = {
    completed: channelsIn('completed').length,
    failed: channelsIn('failed').length,
    reactionsUnread: channelsIn('reactionsUnread').length,
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
        reactionsUnreadChannelNames: channelsIn('reactionsUnread').map(
          ({ name }) => name
        ),
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
