import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    attachments: { filename: string; size: number; url: string }[]
    channelName: string
    content: string
    embeds: string[]
    messageId: string
    jumpUrl: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
  truncated: boolean
}

test('mentions bring back only the messages that pinged you', async () => {
  const { alert, channels, clock, messages } = fixtures()
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
  assert.deepEqual(mention[0].reactions, [
    { emoji: '❤️', count: 1, ownerReacted: true },
  ])
  assert.equal(digest.truncated, false)

  const paged = digest.messages.filter(
    ({ messageId }) => messageId === alert.message.id
  )

  assert.equal(paged.length, 1)
  assert.equal(paged[0].content, '')
  assert.deepEqual(paged[0].embeds, [alert.text])
  assert.deepEqual(paged[0].attachments, alert.message.attachments)

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
