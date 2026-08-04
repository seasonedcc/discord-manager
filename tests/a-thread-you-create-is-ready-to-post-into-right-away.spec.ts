import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  }[]
}

type CreatedThread = {
  thread: {
    channelId: string
    jumpUrl: string
    name: string
    nextAction: string
    requestId: string
    status: string
    summary: string
  }
}

type Send = {
  send: { discordMessageId: string; status: string }
}

test('a thread you create is ready to post into right away', async () => {
  const { channels, guild } = fixtures()
  const session = await openMcpSession()
  const name = `incident-${randomUUID()}`

  const before = await session.call<ChannelList>('channels_list')

  assert.equal(
    before.channels.filter((channel) => channel.name === name).length,
    0
  )

  const { thread } = await session.call<CreatedThread>('threads_create', {
    channelId: channels.engineering.id,
    name,
  })

  assert.equal(thread.status, 'created')
  assert.equal(thread.name, name)
  assert.equal(thread.summary, 'The thread is live in the channel.')
  assert.equal(
    thread.nextAction,
    'Post into it with messages_send, passing the `channelId` this answer carries.'
  )

  const opened = session.discord.threads.filter(
    (recorded) => recorded.name === name
  )

  assert.equal(opened.length, 1)
  assert.equal(
    opened[0].parentDiscordChannelId,
    channels.engineering.discordChannelId
  )
  assert.equal(opened[0].anchorDiscordMessageId, null)
  assert.equal(opened[0].autoArchiveDuration, 10080)
  assert.equal(opened[0].type, 11)
  assert.equal(
    thread.jumpUrl,
    `https://discord.com/channels/${guild.discordGuildId}/${opened[0].discordThreadId}`
  )

  const after = await session.call<ChannelList>('channels_list')
  const listed = after.channels.filter(
    ({ channelId }) => channelId === thread.channelId
  )

  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, name)
  assert.equal(listed[0].isThread, true)
  assert.equal(listed[0].category, channels.engineering.name)
  assert.equal(listed[0].discordChannelId, opened[0].discordThreadId)

  const content = `Rolling back the release now — ${randomUUID()}`
  const { send } = await session.call<Send>('messages_send', {
    channelId: thread.channelId,
    content,
  })
  const delivered = session.discord.sends.filter(
    (recorded) => recorded.content === content
  )

  assert.equal(send.status, 'delivered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].discordChannelId, opened[0].discordThreadId)
})
