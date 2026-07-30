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
  }[]
  truncated: boolean
}

test('mentions bring back only the messages that pinged you', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('mentions_list', {
    since: clock.at(5),
  })
  const mention = digest.messages.filter(
    ({ messageId }) => messageId === messages.mention.id
  )

  assert.equal(mention.length, 1)
  assert.equal(mention[0].content, messages.mention.content)
  assert.equal(mention[0].channelName, channels.engineering.name)
  assert.equal(mention[0].jumpUrl, messages.mention.jumpUrl)
  assert.equal(digest.truncated, false)

  assert.equal(
    digest.messages.filter(({ messageId }) => messageId === messages.offsite.id)
      .length,
    0
  )
  assert.equal(
    digest.messages.filter(
      ({ messageId }) => messageId === messages.corrected.id
    ).length,
    0
  )
})
