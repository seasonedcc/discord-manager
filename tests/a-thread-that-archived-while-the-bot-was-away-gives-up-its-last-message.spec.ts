import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ChannelList = {
  channels: {
    archived?: boolean
    category?: string
    channelId: string
    discordChannelId: string
    isThread: boolean
    name: string
  }[]
}

type Digest = {
  messages: { content: string; discordMessageId: string }[]
}

test('a thread that archived while the bot was away gives up its last message', async () => {
  const { archiving, channels, clock } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: archiving.hotfixThread.id,
    since: clock.anchor,
  })
  const rescued = digest.messages.filter(
    ({ discordMessageId }) =>
      discordMessageId === archiving.saidWhileTheBotWasAway.discordMessageId
  )

  assert.equal(rescued.length, 1)
  assert.equal(rescued[0].content, archiving.saidWhileTheBotWasAway.content)

  assert.ok(
    archiving.finalSweep.backfillableChannelIds.includes(
      archiving.hotfixThread.id
    )
  )
  assert.equal(
    archiving.laterReconnect.backfillableChannelIds.filter(
      (channelId) => channelId === archiving.hotfixThread.id
    ).length,
    0
  )

  const listing = await session.call<ChannelList>('channels_list')
  const listed = (channelId: string) =>
    listing.channels.filter((channel) => channel.channelId === channelId)

  assert.deepEqual(listed(archiving.hotfixThread.id), [
    {
      archived: true,
      category: archiving.hotfixThread.category,
      channelId: archiving.hotfixThread.id,
      discordChannelId: archiving.hotfixThread.discordChannelId,
      isThread: true,
      name: archiving.hotfixThread.name,
    },
  ])
  assert.equal(listed(channels.releaseThread.id)[0].archived, false)
  assert.equal(
    Object.hasOwn(listed(channels.announcements.id)[0], 'archived'),
    false
  )

  const placeOf = (channelId: string) =>
    listing.channels.findIndex((channel) => channel.channelId === channelId)

  assert.ok(
    placeOf(channels.releaseThread.id) < placeOf(archiving.hotfixThread.id)
  )
})
