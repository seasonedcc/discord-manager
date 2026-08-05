import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    discordMessageId: string
    jumpUrl: string
    messageId: string
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
  }[]
}

test('a reply the backfill walked still says which message it answers', async () => {
  const { backfill, channels, clock } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.announcements.id,
    since: clock.anchor,
  })
  const answers = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === backfill.answeredInHistory.message.discordMessageId
  )
  const answered = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === backfill.answeredInHistory.answered.discordMessageId
  )

  assert.equal(answers.length, 1)
  assert.equal(answered.length, 1)
  assert.deepEqual(answers[0].repliedTo, {
    discordMessageId: answered[0].discordMessageId,
    jumpUrl: answered[0].jumpUrl,
    messageId: answered[0].messageId,
  })
  assert.equal(answered[0].repliedTo, null)
})
