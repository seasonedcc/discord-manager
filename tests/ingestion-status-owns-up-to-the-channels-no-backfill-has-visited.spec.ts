import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type IngestionStatus = {
  ingestion: {
    backfill: {
      channels: {
        completed: number
        failed: number
        reactionsUnread: number
        running: number
        stalled: number
      }
      failedChannelNames: string[]
      fetchedMessageCount: number
      lastRunStartedAt: string | null
      neverRanChannelCount: number
      nextAction: string
      reactionsUnreadChannelNames: string[]
      status: string
      storedMessageCount: number
      summary: string
    }
    gateway: {
      activity: string
      lastAliveAt: string | null
      lastConnectedAt: string | null
      lastDisconnectedAt: string | null
      nextAction: string
      summary: string
    }
    observedAt: string
  }
}

test('ingestion status owns up to the channels no backfill has visited', async () => {
  const { archiving, backfill, clock } = fixtures()
  const [finalSweep] = archiving.finalSweep.runs
  const session = await openMcpSession()

  const { ingestion } = await session.call<IngestionStatus>('ingestion_status')

  assert.ok(ingestion.observedAt >= clock.anchor)

  assert.equal(ingestion.gateway.activity, 'receiving')
  assert.ok(ingestion.gateway.lastConnectedAt !== null)
  assert.ok(ingestion.gateway.lastDisconnectedAt !== null)
  assert.ok(ingestion.gateway.lastDisconnectedAt >= clock.anchor)
  assert.ok(
    ingestion.gateway.lastDisconnectedAt <= ingestion.gateway.lastConnectedAt
  )
  assert.equal(ingestion.gateway.lastAliveAt, ingestion.gateway.lastConnectedAt)
  assert.equal(
    ingestion.gateway.summary,
    'The bot was connected and recording as of moments ago.'
  )
  assert.equal(
    ingestion.gateway.nextAction,
    'Nothing to fix — catch up on messages whenever you like.'
  )

  assert.equal(ingestion.backfill.status, 'running')
  assert.deepEqual(ingestion.backfill.channels, {
    completed: 1,
    failed: 0,
    reactionsUnread: 1,
    running: 0,
    stalled: 0,
  })
  assert.equal(ingestion.backfill.neverRanChannelCount, 3)
  assert.deepEqual(ingestion.backfill.failedChannelNames, [])
  assert.deepEqual(ingestion.backfill.reactionsUnreadChannelNames, [
    backfill.reactionsUnread.channel.name,
  ])
  assert.equal(
    ingestion.backfill.fetchedMessageCount,
    backfill.fetchedMessageCount + finalSweep.fetchedMessageCount
  )
  assert.equal(
    ingestion.backfill.storedMessageCount,
    backfill.storedMessageCount + finalSweep.storedMessageCount
  )
  assert.ok(ingestion.backfill.lastRunStartedAt !== null)
  assert.equal(
    ingestion.backfill.summary,
    'Backfills are still working through the history.'
  )
  assert.equal(
    ingestion.backfill.nextAction,
    'Read this status again in a few minutes to watch the counts move.'
  )
})
