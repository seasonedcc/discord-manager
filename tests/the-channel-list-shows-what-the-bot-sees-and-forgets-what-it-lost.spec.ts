import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ChannelList = {
  channels: {
    category?: string
    channelId: string
    discordChannelId: string
    isThread: boolean
    name: string
    position?: number
    topic?: string
  }[]
}

test('the channel list shows what the bot sees and forgets what it lost', async () => {
  const { channels: seeded } = fixtures()
  const session = await openMcpSession()

  const { channels } = await session.call<ChannelList>('channels_list')
  const placeOf = (channelId: string) =>
    channels.findIndex((channel) => channel.channelId === channelId)
  const announcements = channels.filter(
    ({ channelId }) => channelId === seeded.announcements.id
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
    channels.filter(({ channelId }) => channelId === seeded.engineering.id)
      .length,
    1
  )
  assert.equal(
    channels.filter(({ channelId }) => channelId === seeded.retiredStandup.id)
      .length,
    0
  )

  const lobby = channels[placeOf(seeded.lobby.id)]

  assert.equal(Object.hasOwn(lobby, 'category'), false)
  assert.equal(Object.hasOwn(lobby, 'topic'), false)
  assert.equal(lobby.position, seeded.lobby.position)

  const releaseThread = channels[placeOf(seeded.releaseThread.id)]

  assert.equal(releaseThread.isThread, true)
  assert.equal(Object.hasOwn(releaseThread, 'position'), false)

  assert.ok(placeOf(seeded.lobby.id) < placeOf(seeded.announcements.id))
  assert.ok(placeOf(seeded.announcements.id) < placeOf(seeded.engineering.id))
  assert.ok(placeOf(seeded.engineering.id) < placeOf(seeded.releaseThread.id))
})
