import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type ChannelList = {
  channels: { channelId: string; isThread: boolean; name: string }[]
}

type CreatedThread = {
  thread: { channelId: string; name: string; status: string }
}

type SkippedThread = {
  thread: {
    name: string
    nextAction: string
    reason: string
    status: string
    summary: string
  }
}

test('a thread anchored on a message is the only one that message gets', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The deploy failed on the migration step — ${randomUUID()}`,
    discordCreatedAt: clock.at(31),
  })
  const name = `deploy-${randomUUID()}`

  const { thread } = await session.call<CreatedThread>('threads_create', {
    messageId: message.id,
    name,
  })
  const opened = session.discord.threads.filter(
    (recorded) => recorded.name === name
  )

  assert.equal(thread.status, 'created')
  assert.equal(opened.length, 1)
  assert.equal(opened[0].anchorDiscordMessageId, message.discordMessageId)
  assert.equal(
    opened[0].parentDiscordChannelId,
    channels.engineering.discordChannelId
  )
  assert.equal(opened[0].type, undefined)
  assert.equal(opened[0].discordThreadId, message.discordMessageId)

  const { channels: listed } = await session.call<ChannelList>('channels_list')
  const found = listed.filter(({ channelId }) => channelId === thread.channelId)

  assert.equal(found.length, 1)
  assert.equal(found[0].name, name)
  assert.equal(found[0].isThread, true)

  const secondName = `${name}-again`
  const again = await session.call<SkippedThread>('threads_create', {
    messageId: message.id,
    name: secondName,
  })

  assert.equal(again.thread.status, 'skipped')
  assert.equal(again.thread.reason, 'thread_already_exists')
  assert.equal(
    again.thread.summary,
    'That message already carries a thread, and Discord gives a message only one.'
  )
  assert.equal(
    again.thread.nextAction,
    'List the channels to find that thread, then post into it with messages_send.'
  )
  assert.equal(
    session.discord.threads.filter((recorded) => recorded.name === secondName)
      .length,
    0
  )
})
