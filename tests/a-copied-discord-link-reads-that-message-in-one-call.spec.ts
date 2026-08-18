import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    channelId: string
    content: string
    jumpUrl: string
    messageId: string
    status: string
  }
}

test('a copied Discord link reads that message in one call', async () => {
  const { messages } = fixtures()
  const session = await openMcpSession()

  session.discord.holdsMessage(messages.mention.discordMessageId, {
    content: messages.mention.content,
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageLink: messages.mention.jumpUrl,
  })

  assert.equal(message.status, 'retrieved')
  assert.equal(message.messageId, messages.mention.id)
  assert.equal(message.channelId, messages.mention.channelId)
  assert.equal(message.jumpUrl, messages.mention.jumpUrl)
  assert.equal(message.content, messages.mention.content)

  const strayLink = await session.callExpectingRefusal('messages_fetch', {
    messageId: messages.mention.id,
    messageLink: messages.mention.jumpUrl,
  })

  assert.equal(strayLink.errors.length, 1)
  assert.equal(
    strayLink.errors[0].message,
    'Pass either `messageId` from messages_catch_up, mentions_list or bookmarks_list, or `messageLink` copied from Discord with Copy Message Link — one of the two, never both'
  )
  assert.equal(session.discord.reads.length, 1)
})
