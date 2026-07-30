import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    discordMessageId: string
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
    requestId: string
    requestedAt: string
    status: string
    summary: string
  }
}

test('sending a reply reaches Discord and remembers where it landed', async () => {
  const { channels, messages } = fixtures()
  const session = await openMcpSession()

  const content = `On it — reviewing the checklist now (${randomUUID()})`
  const { send } = await session.call<Send>('messages_send', {
    channelId: channels.engineering.id,
    content,
    replyToMessageId: messages.mention.id,
  })

  assert.equal(send.status, 'delivered')
  assert.equal(send.summary, 'The message is live in the channel.')
  assert.equal(
    send.nextAction,
    'Open the channel in Discord to follow the conversation.'
  )

  assert.equal(session.discord.sends.length, 1)
  assert.equal(
    session.discord.sends[0].discordChannelId,
    channels.engineering.discordChannelId
  )
  assert.equal(session.discord.sends[0].content, content)
  assert.equal(
    session.discord.sends[0].replyToDiscordMessageId,
    messages.mention.discordMessageId
  )
  assert.equal(send.discordMessageId, session.discord.sends[0].discordMessageId)

  const status = await session.call<SendStatus>('messages_send_status', {
    requestId: send.requestId,
  })

  assert.equal(status.send.requestId, send.requestId)
  assert.equal(status.send.status, 'delivered')
  assert.equal(status.send.discordMessageId, send.discordMessageId)
  assert.equal(status.send.summary, 'The message is live in the channel.')
  assert.equal(
    status.send.nextAction,
    'Open the channel in Discord to follow the conversation.'
  )
})
