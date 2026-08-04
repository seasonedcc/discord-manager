import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Send = {
  send: {
    discordMessageId: string
    requestId: string
    status: string
  }
}

test('a reply to a message in another channel is refused before Discord sees it', async () => {
  const { channels, messages } = fixtures()
  const session = await openMcpSession()

  const acrossChannels = await session.callExpectingRefusal('messages_send', {
    channelId: channels.engineering.id,
    content: `Booked — thanks for the heads up (${randomUUID()})`,
    replyToMessageId: messages.offsite.id,
  })

  assert.equal(acrossChannels.errors.length, 1)
  assert.deepEqual(acrossChannels.errors[0].path, ['replyToMessageId'])
  assert.equal(
    acrossChannels.errors[0].message,
    'That message is in a different channel, and Discord only attaches a reply to a message in the same channel. Send to the `channelId` that message came with, or leave out `replyToMessageId` to post on its own.'
  )
  assert.equal(session.discord.sends.length, 0)

  const content = `Booked — thanks for the heads up (${randomUUID()})`
  const { send } = await session.call<Send>('messages_send', {
    channelId: messages.offsite.channelId,
    content,
    replyToMessageId: messages.offsite.id,
  })

  assert.equal(send.status, 'delivered')
  assert.equal(session.discord.sends.length, 1)
  assert.equal(
    session.discord.sends[0].discordChannelId,
    messages.offsite.discordChannelId
  )
  assert.equal(session.discord.sends[0].content, content)
  assert.equal(
    session.discord.sends[0].replyToDiscordMessageId,
    messages.offsite.discordMessageId
  )
})
