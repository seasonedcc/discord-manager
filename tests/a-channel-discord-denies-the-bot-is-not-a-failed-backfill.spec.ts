import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ChannelList = {
  channels: { channelId: string; name: string }[]
}

type Count = {
  total: number
}

type IngestionStatus = {
  ingestion: {
    backfill: {
      channels: {
        failed: number
        unavailable: number
      }
      failedChannelNames: string[]
      unavailableChannelNames: string[]
    }
  }
}

test('a channel Discord denies the bot is not a failed backfill', async () => {
  const { outOfReach } = fixtures()
  const session = await openMcpSession()

  const { ingestion } = await session.call<IngestionStatus>('ingestion_status')

  assert.ok(
    ingestion.backfill.unavailableChannelNames.includes(
      outOfReach.channel.name
    ),
    `${outOfReach.channel.name} is missing from unavailableChannelNames`
  )
  assert.equal(
    ingestion.backfill.channels.unavailable,
    ingestion.backfill.unavailableChannelNames.length
  )
  assert.equal(ingestion.backfill.channels.failed, 0)
  assert.deepEqual(ingestion.backfill.failedChannelNames, [])

  const { channels } = await session.call<ChannelList>('channels_list')
  const denied = channels.find(({ name }) => name === outOfReach.channel.name)

  assert.ok(denied, 'the denied channel is missing from channels_list')

  const counted = await session.call<Count>('messages_count', {
    channelId: denied.channelId,
  })

  assert.equal(counted.total, 0)
})
