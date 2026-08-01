import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    content: string
    discordMessageId: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
}

test('history the backfill walked arrives with its reactions', async () => {
  const { backfill, channels, clock } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.announcements.id,
    since: clock.anchor,
  })
  const welcomed = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === backfill.welcomed.message.discordMessageId
  )

  assert.equal(welcomed.length, 1)
  assert.equal(welcomed[0].content, backfill.welcomed.message.content)
  assert.deepEqual(welcomed[0].reactions, backfill.welcomed.reactions)

  const previewed = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === backfill.linkPreview.message.discordMessageId
  )

  assert.equal(previewed.length, 1)
  assert.deepEqual(previewed[0].reactions, [])
})
