import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    messageId: string
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
  }[]
}

test('a reply that never pinged you still says which message it answers', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.at(5),
  })
  const answered = digest.messages.filter(
    ({ messageId }) => messageId === messages.suppressedPing.id
  )
  const answering = digest.messages.filter(
    ({ messageId }) => messageId === messages.mention.id
  )

  assert.equal(answered.length, 1)
  assert.deepEqual(answered[0].repliedTo, messages.suppressedPing.repliedTo)
  assert.equal(answered[0].repliedTo?.messageId, messages.mention.id)

  assert.equal(answering.length, 1)
  assert.equal(answering[0].repliedTo, null)
})
