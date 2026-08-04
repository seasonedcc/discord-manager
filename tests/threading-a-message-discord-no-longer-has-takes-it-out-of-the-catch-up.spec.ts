import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Digest = {
  messages: { messageId: string }[]
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

test('threading a message Discord no longer has takes it out of the catch-up', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()
  const postedAt = clock.at(33)
  const doomed = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The migration is stuck halfway through — ${randomUUID()}`,
    discordCreatedAt: postedAt,
  })
  const catchUpOnIt = async () => {
    const { messages } = await session.call<Digest>('messages_catch_up', {
      channelId: channels.engineering.id,
      since: postedAt,
    })

    return messages.filter(({ messageId }) => messageId === doomed.id)
  }
  const name = `migration-${randomUUID()}`

  assert.equal((await catchUpOnIt()).length, 1)

  session.discord.forgetsMessage(doomed.discordMessageId)

  const { thread } = await session.call<FailedThread>('threads_create', {
    messageId: doomed.id,
    name,
  })

  assert.equal(thread.status, 'failed')
  assert.equal(
    thread.summary,
    'Discord no longer has that message, so no thread was created on it.'
  )
  assert.equal(
    thread.nextAction,
    "Catch up on that channel to pick a message that still stands, or pass the channel's `channelId` to create the thread on its own."
  )

  const answer = JSON.stringify(thread)

  assert.equal(answer.includes('Unknown Message'), false)
  assert.equal(answer.includes('10008'), false)
  assert.equal(
    session.discord.threads.filter((recorded) => recorded.name === name).length,
    0
  )
  assert.equal((await catchUpOnIt()).length, 0)
})
