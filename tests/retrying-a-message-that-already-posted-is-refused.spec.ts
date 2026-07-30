import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    requestId: string
    status: string
  }
}

type SendStatus = {
  send: {
    canRetry: boolean
    status: string
  }
}

test('retrying a message that already posted is refused', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()
  const content = `Reminder: retro notes are due (${randomUUID()})`

  const delivered = await session.call<Send>('messages_send', {
    channelId: channels.announcements.id,
    content,
  })

  assert.equal(delivered.send.status, 'delivered')
  assert.equal(session.discord.sends.length, 1)

  const status = await session.call<SendStatus>('messages_send_status', {
    requestId: delivered.send.requestId,
  })

  assert.equal(status.send.canRetry, false)

  const refusal = await session.callExpectingRefusal('messages_send', {
    channelId: channels.announcements.id,
    content,
    retryOfRequestId: delivered.send.requestId,
  })

  assert.equal(
    refusal.errors[0].message,
    'That message is already live in the channel, so sending it again would post it twice.'
  )
  assert.deepEqual(refusal.errors[0].path, ['retryOfRequestId'])
  assert.equal(session.discord.sends.length, 1)
})
