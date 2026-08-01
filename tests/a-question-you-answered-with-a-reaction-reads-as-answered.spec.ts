import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    content: string
    messageId: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
}

test('a question you answered with a reaction reads as answered', async () => {
  const { channels, clock, reactions } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.anchor,
  })
  const asked = digest.messages.filter(
    ({ messageId }) => messageId === reactions.answeredByReacting.id
  )

  assert.equal(asked.length, 1)
  assert.equal(asked[0].content, reactions.answeredByReacting.content)
  assert.deepEqual(asked[0].reactions, [
    { emoji: '👍', count: 1, ownerReacted: true },
    { emoji: '👀', count: 1, ownerReacted: false },
  ])

  const untouched = digest.messages.filter(
    ({ messageId }) => messageId === reactions.cheeredByATeammate.id
  )

  assert.equal(untouched.length, 1)
  assert.deepEqual(untouched[0].reactions, [
    { emoji: '🎉', count: 1, ownerReacted: false },
  ])
})
