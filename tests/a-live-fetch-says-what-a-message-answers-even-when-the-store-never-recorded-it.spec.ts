import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
    status: string
  }
}

test('a live fetch says what a message answers even when the store never recorded it', async () => {
  const { messages } = fixtures()
  const session = await openMcpSession()

  session.discord.holdsMessage(messages.corrected.discordMessageId, {
    answering: {
      discordChannelId: messages.mention.discordChannelId,
      discordMessageId: messages.mention.discordMessageId,
    },
    content: messages.corrected.content,
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.corrected.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.equal(messages.corrected.repliedTo, null)
  assert.deepEqual(message.repliedTo, {
    discordMessageId: messages.mention.discordMessageId,
    jumpUrl: messages.mention.jumpUrl,
    messageId: messages.mention.id,
  })
})
