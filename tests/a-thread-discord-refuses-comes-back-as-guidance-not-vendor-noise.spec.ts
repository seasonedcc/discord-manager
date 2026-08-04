import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ChannelList = {
  channels: { channelId: string; name: string }[]
}

type Thread = {
  thread: {
    name: string
    nextAction: string
    requestId: string
    status: string
    summary: string
  }
}

test('a thread Discord refuses comes back as guidance, not vendor noise', async () => {
  const { channels } = fixtures()
  const session = await openMcpSession()
  const name = `offsite-${randomUUID()}`

  session.discord.refuseThreadsIn(channels.announcements.discordChannelId)

  const { thread } = await session.call<Thread>('threads_create', {
    channelId: channels.announcements.id,
    name,
  })

  assert.equal(thread.status, 'failed')
  assert.equal(
    thread.summary,
    'Discord refused to create the thread, so none exists.'
  )
  assert.equal(
    thread.nextAction,
    'Give the bot View Channel and Create Public Threads in that channel, check DISCORD_BOT_TOKEN, or try a plainer name, then create it again — no thread was created, so a second attempt cannot leave two.'
  )
  assert.equal(
    session.discord.threads.filter((recorded) => recorded.name === name).length,
    0
  )

  const answer = JSON.stringify(thread)

  assert.equal(answer.includes('Missing Permissions'), false)
  assert.equal(answer.includes('50013'), false)

  const { channels: listed } = await session.call<ChannelList>('channels_list')

  assert.equal(listed.filter((channel) => channel.name === name).length, 0)
})
