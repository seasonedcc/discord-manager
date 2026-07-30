import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ChannelList = {
  channels: {
    category: string
    discordChannelId: string
    id: string
    isThread: boolean
    name: string
    position: number
    topic: string
  }[]
}

test('the channel list shows what the bot sees and forgets what it lost', async () => {
  const { channels: seeded } = fixtures()
  const session = await openMcpSession()

  const { channels } = await session.call<ChannelList>('channels_list')
  const announcements = channels.filter(
    ({ id }) => id === seeded.announcements.id
  )

  assert.equal(announcements.length, 1)
  assert.equal(announcements[0].name, seeded.announcements.name)
  assert.equal(announcements[0].topic, seeded.announcements.topic)
  assert.equal(announcements[0].category, seeded.announcements.category)
  assert.equal(announcements[0].position, seeded.announcements.position)
  assert.equal(announcements[0].isThread, false)
  assert.equal(
    announcements[0].discordChannelId,
    seeded.announcements.discordChannelId
  )

  assert.equal(
    channels.filter(({ id }) => id === seeded.engineering.id).length,
    1
  )
  assert.equal(
    channels.filter(({ id }) => id === seeded.retiredStandup.id).length,
    0
  )

  assert.ok(
    channels.findIndex(({ id }) => id === seeded.announcements.id) <
      channels.findIndex(({ id }) => id === seeded.engineering.id)
  )
})
