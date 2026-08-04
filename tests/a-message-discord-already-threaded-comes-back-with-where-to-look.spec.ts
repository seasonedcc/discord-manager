import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type ChannelList = {
  channels: { channelId: string; name: string }[]
}

type FailedThread = {
  thread: {
    name: string
    nextAction: string
    requestId: string
    status: string
    summary: string
  }
}

test('a message Discord already threaded comes back with where to look', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `Anyone else seeing the queue back up? — ${randomUUID()}`,
    discordCreatedAt: clock.at(29),
  })
  const name = `queue-${randomUUID()}`

  session.discord.refuseThreadsOn(message.discordMessageId)

  const { thread } = await session.call<FailedThread>('threads_create', {
    messageId: message.id,
    name,
  })

  assert.equal(thread.status, 'failed')
  assert.equal(
    thread.summary,
    'Discord says that message already carries a thread, so none was created, and that thread is not among the channels the bot can see.'
  )
  assert.equal(
    thread.nextAction,
    "List the channels to find that thread once the ingest daemon records it, then post into it with messages_send. If it never shows up there, pass the channel's `channelId` to create the thread on its own."
  )

  const answer = JSON.stringify(thread)

  assert.equal(
    answer.includes('A thread has already been created for this message'),
    false
  )
  assert.equal(answer.includes('160004'), false)

  const { channels: listed } = await session.call<ChannelList>('channels_list')

  assert.equal(listed.filter((channel) => channel.name === name).length, 0)
})
