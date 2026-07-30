import { randomUUID } from 'node:crypto'
import { fromSuccess, isContextError } from 'composable-functions'
import {
  backfillStatusCopy,
  gatewayActivityCopy,
} from '~/business/ingestion-status.common'
import { readIngestionStatus } from '~/business/ingestion-status.server'
import { backfillStallThresholdMinutes } from '~/business/ingestion.common'
import { newId } from '~/framework/db.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

async function startBackfillRun(
  channelId: string,
  startedAt = new Date().toISOString()
) {
  return await db()
    .insertInto('backfillRuns')
    .values({ id: newId(), channelId, createdAt: startedAt })
    .returningAll()
    .executeTakeFirstOrThrow()
}

describe('readIngestionStatus', () => {
  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const result = await readIngestionStatus(
      {},
      { ...context, canReadMessages: false }
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a failure')
    expect(isContextError(result.errors[0])).toBe(true)
  })

  it('reads the newest connection and disconnection the bot recorded', async () => {
    const guild = await createGuild()

    await db()
      .insertInto('gatewayDisconnections')
      .values({ id: newId(), createdAt: '2099-06-02T00:00:00.000Z' })
      .execute()
    await db()
      .insertInto('gatewayConnections')
      .values({ id: newId(), createdAt: '2099-06-03T00:00:00.000Z' })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.gateway).toEqual({
      activity: 'receiving',
      lastAliveAt: '2099-06-03T00:00:00.000Z',
      lastConnectedAt: '2099-06-03T00:00:00.000Z',
      lastDisconnectedAt: '2099-06-02T00:00:00.000Z',
      ...gatewayActivityCopy.receiving,
    })
  })

  it('reads a heartbeat newer than the connection as the newest sign of life', async () => {
    const guild = await createGuild()

    await db()
      .insertInto('gatewayConnections')
      .values({ id: newId(), createdAt: '2099-06-03T00:00:00.000Z' })
      .execute()
    await db()
      .insertInto('gatewayHeartbeats')
      .values({ id: newId(), createdAt: '2099-06-04T00:00:00.000Z' })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.gateway.lastAliveAt).toBe('2099-06-04T00:00:00.000Z')
    expect(ingestion.gateway.lastConnectedAt).toBe('2099-06-03T00:00:00.000Z')
  })

  it('counts the furthest a backfill walked, not whichever progress row it read last', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const run = await startBackfillRun(channel.id)
    const walkedAt = new Date().toISOString()
    const [furthestPageId, earlierPageId] = [newId(), newId()].sort()

    await db()
      .insertInto('backfillRunProgress')
      .values([
        {
          id: earlierPageId,
          backfillRunId: run.id,
          fetchedMessageCount: 100,
          storedMessageCount: 40,
          createdAt: walkedAt,
        },
        {
          id: furthestPageId,
          backfillRunId: run.id,
          fetchedMessageCount: 250,
          storedMessageCount: 90,
          createdAt: walkedAt,
        },
      ])
      .execute()
    await db()
      .insertInto('backfillRunCompletions')
      .values({
        id: newId(),
        backfillRunId: run.id,
        fetchedMessageCount: 250,
        storedMessageCount: 90,
      })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toEqual({
      status: 'completed',
      channels: { completed: 1, failed: 0, running: 0, stalled: 0 },
      fetchedMessageCount: 250,
      storedMessageCount: 90,
      lastRunStartedAt: run.createdAt,
      ...backfillStatusCopy.completed,
    })
  })

  it('reads a backfill that has said nothing for too long as stalled', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    await startBackfillRun(
      channel.id,
      minutesAgo(backfillStallThresholdMinutes + 1)
    )

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toMatchObject({
      status: 'stalled',
      channels: { completed: 0, failed: 0, running: 0, stalled: 1 },
      ...backfillStatusCopy.stalled,
    })
  })

  it('keeps a long backfill running while its progress rows keep arriving', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const run = await startBackfillRun(
      channel.id,
      minutesAgo(backfillStallThresholdMinutes * 4)
    )

    await db()
      .insertInto('backfillRunProgress')
      .values({
        id: newId(),
        backfillRunId: run.id,
        fetchedMessageCount: 700,
        storedMessageCount: 700,
      })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toMatchObject({
      status: 'running',
      channels: { completed: 0, failed: 0, running: 1, stalled: 0 },
      fetchedMessageCount: 700,
      ...backfillStatusCopy.running,
    })
  })

  it('speaks for the worst channel when one backfill failed', async () => {
    const guild = await createGuild()
    const failing = await createChannel({ guildId: guild.id })
    const finished = await createChannel({ guildId: guild.id })
    const failedRun = await startBackfillRun(failing.id)
    const completedRun = await startBackfillRun(finished.id)

    await db()
      .insertInto('backfillRunFailures')
      .values({
        id: newId(),
        backfillRunId: failedRun.id,
        errorMessage: 'Missing Access',
      })
      .execute()
    await db()
      .insertInto('backfillRunCompletions')
      .values({
        id: newId(),
        backfillRunId: completedRun.id,
        fetchedMessageCount: 12,
        storedMessageCount: 12,
      })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toMatchObject({
      status: 'failed',
      channels: { completed: 1, failed: 1, running: 0, stalled: 0 },
      ...backfillStatusCopy.failed,
    })
  })

  it('never repeats what Discord said about a failed backfill', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const run = await startBackfillRun(channel.id)
    const errorMessage = `discord-refused-${randomUUID()}`

    await db()
      .insertInto('backfillRunFailures')
      .values({ id: newId(), backfillRunId: run.id, errorMessage })
      .execute()

    const status = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(status.ingestion.backfill.status).toBe('failed')
    expect(JSON.stringify(status)).not.toContain(errorMessage)
    expect(JSON.stringify(status)).not.toContain('errorMessage')
  })

  it('reads only the newest backfill run of each channel', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const abandoned = await startBackfillRun(channel.id, minutesAgo(120))
    const latest = await startBackfillRun(channel.id, minutesAgo(1))

    await db()
      .insertInto('backfillRunFailures')
      .values({
        id: newId(),
        backfillRunId: abandoned.id,
        errorMessage: 'Missing Access',
      })
      .execute()
    await db()
      .insertInto('backfillRunProgress')
      .values({
        id: newId(),
        backfillRunId: latest.id,
        fetchedMessageCount: 8,
        storedMessageCount: 8,
      })
      .execute()
    await db()
      .insertInto('backfillRunCompletions')
      .values({
        id: newId(),
        backfillRunId: latest.id,
        fetchedMessageCount: 8,
        storedMessageCount: 8,
      })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toMatchObject({
      status: 'completed',
      channels: { completed: 1, failed: 0, running: 0, stalled: 0 },
      fetchedMessageCount: 8,
      lastRunStartedAt: latest.createdAt,
    })
  })

  it('reads a server whose channels were never backfilled as never', async () => {
    const guild = await createGuild()
    const otherGuild = await createGuild()
    const otherChannel = await createChannel({ guildId: otherGuild.id })
    const otherRun = await startBackfillRun(otherChannel.id)

    await db()
      .insertInto('backfillRunCompletions')
      .values({
        id: newId(),
        backfillRunId: otherRun.id,
        fetchedMessageCount: 40,
        storedMessageCount: 40,
      })
      .execute()

    const { ingestion } = await fromSuccess(readIngestionStatus)(
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(ingestion.backfill).toEqual({
      status: 'never',
      channels: { completed: 0, failed: 0, running: 0, stalled: 0 },
      fetchedMessageCount: 0,
      storedMessageCount: 0,
      lastRunStartedAt: null,
      ...backfillStatusCopy.never,
    })
  })
})
