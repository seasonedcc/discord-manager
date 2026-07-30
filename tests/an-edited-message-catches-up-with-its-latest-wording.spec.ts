import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: { content: string; messageId: string }[]
}

test('an edited message catches up with its latest wording', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.at(5),
  })
  const corrected = digest.messages.filter(
    ({ messageId }) => messageId === messages.corrected.id
  )

  assert.equal(corrected.length, 1)
  assert.equal(corrected[0].content, messages.corrected.content)
  assert.equal(
    digest.messages.filter(
      ({ content }) => content === messages.corrected.previousContent
    ).length,
    0
  )
})
