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
        running: number
        stalled: number
      }
      fetchedMessageCount: number
      lastRunStartedAt: string | null
      nextAction: string
      status: string
      storedMessageCount: number
      summary: string
    }
    gateway: {
      activity: string
      lastConnectedAt: string | null
      lastDisconnectedAt: string | null
      nextAction: string
      summary: string
    }
    observedAt: string
  }
}

test('ingestion status reports a live gateway and a finished backfill', async () => {
  const { backfill, clock } = fixtures()
  const session = await openMcpSession()

  const { ingestion } = await session.call<IngestionStatus>('ingestion_status')

  assert.ok(ingestion.observedAt >= clock.anchor)

  assert.equal(ingestion.gateway.activity, 'receiving')
  assert.ok(ingestion.gateway.lastConnectedAt !== null)
  assert.ok(ingestion.gateway.lastDisconnectedAt !== null)
  assert.ok(
    ingestion.gateway.lastDisconnectedAt <= ingestion.gateway.lastConnectedAt
  )
  assert.equal(
    ingestion.gateway.summary,
    'The bot is connected to Discord and recording messages as they arrive.'
  )
  assert.equal(
    ingestion.gateway.nextAction,
    'Nothing to fix — catch up on messages whenever you like.'
  )

  assert.equal(ingestion.backfill.status, 'completed')
  assert.deepEqual(ingestion.backfill.channels, {
    completed: 1,
    failed: 0,
    running: 0,
    stalled: 0,
  })
  assert.equal(
    ingestion.backfill.fetchedMessageCount,
    backfill.fetchedMessageCount
  )
  assert.equal(
    ingestion.backfill.storedMessageCount,
    backfill.storedMessageCount
  )
  assert.ok(ingestion.backfill.lastRunStartedAt !== null)
  assert.equal(
    ingestion.backfill.summary,
    'Every channel the bot backfilled has finished pulling its history.'
  )
  assert.equal(
    ingestion.backfill.nextAction,
    'Catch up on messages whenever you like — the history is in the store.'
  )
})
