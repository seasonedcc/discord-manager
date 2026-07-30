import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    nextAction: string
    requestId: string
    status: string
    summary: string
  }
}

type SendStatus = {
  send: {
    discordMessageId: string | null
    nextAction: string
    status: string
    summary: string
  }
}

const refusalSummary = 'Discord refused the message, so it was never posted.'
const refusalNextAction =
  'Give the bot Send Messages (and Send Messages in Threads) in that channel and check DISCORD_BOT_TOKEN, then send it again.'

test('a send Discord refuses comes back as guidance, not vendor noise', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()

  session.discord.refuseSendsTo(channels.announcements.discordChannelId)

  const { send } = await session.call<Send>('messages_send', {
    channelId: channels.announcements.id,
    content: `Heads up on the offsite agenda (${randomUUID()})`,
  })

  assert.equal(send.status, 'failed')
  assert.equal(send.summary, refusalSummary)
  assert.equal(send.nextAction, refusalNextAction)
  assert.equal(session.discord.sends.length, 0)

  const answer = JSON.stringify(send)

  assert.equal(answer.includes('Missing Permissions'), false)
  assert.equal(answer.includes('50013'), false)

  const status = await session.call<SendStatus>('messages_send_status', {
    requestId: send.requestId,
  })

  assert.equal(status.send.status, 'failed')
  assert.equal(status.send.discordMessageId, null)
  assert.equal(status.send.summary, refusalSummary)
  assert.equal(status.send.nextAction, refusalNextAction)
})
