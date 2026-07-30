import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    discordMessageId: string | null
    nextAction: string
    requestId: string
    status: string
    summary: string
  }
}

type SendStatus = {
  send: {
    canRetry: boolean
    nextAction: string
    requestId: string
    retries: { requestId: string; status: string }[]
    retryOfRequestId: string | null
    status: string
  }
}

test('a message Discord refused goes out on the retry', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()
  const content = `The deploy window moved to Thursday (${randomUUID()})`

  session.discord.refuseSendsTo(channels.engineering.discordChannelId)

  const refused = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
  })

  assert.equal(refused.send.status, 'failed')
  assert.equal(session.discord.sends.length, 0)

  const offered = await session.call<SendStatus>('messages_send_status', {
    requestId: refused.send.requestId,
  })

  assert.equal(offered.send.canRetry, true)
  assert.deepEqual(offered.send.retries, [])

  session.discord.acceptSendsTo(channels.engineering.discordChannelId)

  const retry = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
    retryOfRequestId: refused.send.requestId,
  })

  assert.equal(retry.send.status, 'delivered')
  assert.equal(session.discord.sends.length, 1)
  assert.equal(session.discord.sends[0].content, content)
  assert.equal(
    session.discord.sends[0].discordMessageId,
    retry.send.discordMessageId
  )

  const retried = await session.call<SendStatus>('messages_send_status', {
    requestId: refused.send.requestId,
  })

  assert.equal(retried.send.status, 'failed')
  assert.equal(retried.send.canRetry, false)
  assert.deepEqual(retried.send.retries, [
    { requestId: retry.send.requestId, status: 'delivered' },
  ])
  assert.equal(
    retried.send.nextAction,
    'A retry of that send is already live in the channel, so sending it again would post it twice.'
  )

  const landed = await session.call<SendStatus>('messages_send_status', {
    requestId: retry.send.requestId,
  })

  assert.equal(landed.send.status, 'delivered')
  assert.equal(landed.send.retryOfRequestId, refused.send.requestId)
  assert.equal(landed.send.canRetry, false)
})
