import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Count = {
  days?: { date: string; count: number }[]
  newestMatch: string | null
  oldestMatch: string | null
  total: number
}

test('counting an alert says how far back its history goes', async () => {
  const { alert, channels, messages } = fixtures()
  const session = await openMcpSession()

  const raised = await session.call<Count>('messages_count', {
    channelId: channels.engineering.id,
    contentContains: alert.text.toLowerCase(),
    groupBy: 'day',
  })

  assert.equal(raised.total, 1)
  assert.equal(raised.oldestMatch, alert.message.discordCreatedAt)
  assert.equal(raised.newestMatch, alert.message.discordCreatedAt)
  assert.deepEqual(raised.days, [
    { date: alert.message.discordCreatedAt.slice(0, 10), count: 1 },
  ])

  const replaced = await session.call<Count>('messages_count', {
    channelId: channels.engineering.id,
    contentContains: messages.corrected.previousContent,
    groupBy: 'day',
  })

  assert.equal(replaced.total, 0)
  assert.equal(replaced.oldestMatch, null)
  assert.equal(replaced.newestMatch, null)
  assert.deepEqual(replaced.days, [])

  const standing = await session.call<Count>('messages_count', {
    channelId: channels.engineering.id,
    contentContains: messages.corrected.content,
  })

  assert.equal(standing.total, 1)
  assert.equal(standing.oldestMatch, messages.corrected.discordCreatedAt)
  assert.equal(standing.days, undefined)
})
