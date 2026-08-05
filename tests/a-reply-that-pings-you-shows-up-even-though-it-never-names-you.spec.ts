import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    channelName: string
    content: string
    messageId: string
    jumpUrl: string
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
  }[]
  truncated: boolean
}

test('a reply that pings you shows up even though it never names you', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('mentions_list', {
    since: clock.at(5),
  })
  const replyPing = digest.messages.filter(
    ({ messageId }) => messageId === messages.replyPing.id
  )

  assert.equal(replyPing.length, 1)
  assert.equal(replyPing[0].content, messages.replyPing.content)
  assert.equal(replyPing[0].channelName, channels.engineering.name)
  assert.equal(replyPing[0].jumpUrl, messages.replyPing.jumpUrl)
  assert.ok(!replyPing[0].content.includes('<@'))
  assert.deepEqual(replyPing[0].repliedTo, messages.replyPing.repliedTo)

  assert.equal(
    digest.messages.filter(
      ({ messageId }) => messageId === messages.suppressedPing.id
    ).length,
    0
  )
})
