import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    nextAction: string
    reason: string
    requestId: string
    status: string
    summary: string
  }
}

type SendStatus = {
  send: {
    discordMessageId: string | null
    nextAction: string
    reason: string | null
    status: string
    summary: string
  }
}

const skipSummary = 'That channel is gone from the bot, so nothing was posted.'
const skipNextAction =
  'List the channels again and pick one the bot can still see, then send.'

test('posting to a channel the bot lost comes back as a skip', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()

  const { send } = await session.call<Send>('messages_send', {
    channelId: channels.retiredStandup.id,
    content: `Is anyone still reading this channel? (${randomUUID()})`,
  })

  assert.equal(send.status, 'skipped')
  assert.equal(send.reason, 'channel_not_found')
  assert.equal(send.summary, skipSummary)
  assert.equal(send.nextAction, skipNextAction)
  assert.equal(session.discord.sends.length, 0)

  const status = await session.call<SendStatus>('messages_send_status', {
    requestId: send.requestId,
  })

  assert.equal(status.send.status, 'skipped')
  assert.equal(status.send.reason, 'channel_not_found')
  assert.equal(status.send.discordMessageId, null)
  assert.equal(status.send.summary, skipSummary)
  assert.equal(status.send.nextAction, skipNextAction)
})
