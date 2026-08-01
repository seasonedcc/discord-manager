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

type IngestionStatus = {
  ingestion: {
    backfill: {
      channels: { reactionsUnread: number }
      nextAction: string
      reactionsUnreadChannelNames: string[]
      summary: string
    }
  }
}

test('history whose reactors Discord would not list still arrives', async () => {
  const { backfill, channels, clock } = fixtures()
  const session = await openMcpSession()
  const { message } = backfill.reactionsUnread

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.announcements.id,
    since: clock.anchor,
  })
  const arrived = digest.messages.filter(
    ({ discordMessageId }) => discordMessageId === message.discordMessageId
  )

  assert.equal(arrived.length, 1)
  assert.equal(arrived[0].content, message.content)
  assert.deepEqual(arrived[0].reactions, [])

  const { ingestion } = await session.call<IngestionStatus>('ingestion_status')

  assert.equal(ingestion.backfill.channels.reactionsUnread, 1)
  assert.deepEqual(ingestion.backfill.reactionsUnreadChannelNames, [
    backfill.reactionsUnread.channel.name,
  ])
})
