import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    attachments: { filename: string; size: number; url: string }[]
    content: string
    embeds: string[]
    messageId: string
  }[]
}

test('an alert with no text of its own still reads in the catch up', async () => {
  const { alert, channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.at(5),
  })
  const raised = digest.messages.filter(
    ({ messageId }) => messageId === alert.message.id
  )

  assert.equal(raised.length, 1)
  assert.equal(raised[0].content, '')
  assert.deepEqual(raised[0].embeds, [alert.text])
  assert.deepEqual(raised[0].attachments, alert.message.attachments)

  const spoken = digest.messages.filter(
    ({ messageId }) => messageId === messages.mention.id
  )

  assert.equal(spoken.length, 1)
  assert.equal(spoken[0].content, messages.mention.content)
  assert.deepEqual(spoken[0].embeds, [])
  assert.deepEqual(spoken[0].attachments, [])
})
