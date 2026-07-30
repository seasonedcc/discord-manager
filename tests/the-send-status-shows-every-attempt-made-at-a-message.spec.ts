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
    nextAction: string
    retries: { requestId: string; status: string }[]
    retryOfRequestId: string | null
    status: string
  }
}

test('the send status shows every attempt made at a message', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()
  const content = `Standup moves to 10:00 tomorrow (${randomUUID()})`

  session.discord.refuseSendsTo(channels.engineering.discordChannelId)

  const first = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
  })
  const secondAttempt = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
    retryOfRequestId: first.send.requestId,
  })

  assert.equal(first.send.status, 'failed')
  assert.equal(secondAttempt.send.status, 'failed')

  const stillOpen = await session.call<SendStatus>('messages_send_status', {
    requestId: first.send.requestId,
  })

  assert.equal(stillOpen.send.canRetry, true)
  assert.deepEqual(stillOpen.send.retries, [
    { requestId: secondAttempt.send.requestId, status: 'failed' },
  ])

  session.discord.acceptSendsTo(channels.engineering.discordChannelId)

  const thirdAttempt = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
    retryOfRequestId: first.send.requestId,
  })

  assert.equal(thirdAttempt.send.status, 'delivered')
  assert.equal(session.discord.sends.length, 1)

  const settled = await session.call<SendStatus>('messages_send_status', {
    requestId: first.send.requestId,
  })

  assert.equal(settled.send.canRetry, false)
  assert.deepEqual(settled.send.retries, [
    { requestId: secondAttempt.send.requestId, status: 'failed' },
    { requestId: thirdAttempt.send.requestId, status: 'delivered' },
  ])

  const middle = await session.call<SendStatus>('messages_send_status', {
    requestId: secondAttempt.send.requestId,
  })

  assert.equal(middle.send.retryOfRequestId, first.send.requestId)
  assert.deepEqual(middle.send.retries, [])
})
