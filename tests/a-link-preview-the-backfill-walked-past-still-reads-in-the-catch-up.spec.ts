import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    attachments: { filename: string; size: number; url: string }[]
    content: string
    discordMessageId: string
    embeds: string[]
  }[]
}

test('a link preview the backfill walked past still reads in the catch up', async () => {
  const { backfill, channels, clock } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.announcements.id,
    since: clock.anchor,
  })
  const previewed = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === backfill.linkPreview.message.discordMessageId
  )

  assert.equal(previewed.length, 1)
  assert.equal(previewed[0].content, backfill.linkPreview.message.content)
  assert.deepEqual(previewed[0].embeds, [backfill.linkPreview.text])
  assert.deepEqual(previewed[0].attachments, [])
})
