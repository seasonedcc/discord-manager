import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Digest = {
  messages: {
    messageId: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
}

test('reactions Discord cleared off a message leave the catch up', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The staging database is back — ${randomUUID()}`,
    discordCreatedAt: clock.at(31),
  })

  await feed.reactToMessage({ emoji: '🎉', message, reactor: owner })
  await feed.reactToMessage({ emoji: '🎉', message, reactor: members.maya })
  await feed.reactToMessage({ emoji: '👀', message, reactor: members.priya })

  const reactionsOf = async () => {
    const digest = await session.call<Digest>('messages_catch_up', {
      channelId: channels.engineering.id,
      since: clock.anchor,
    })

    return digest.messages.find(({ messageId }) => messageId === message.id)
      ?.reactions
  }

  assert.deepEqual(await reactionsOf(), [
    { emoji: '🎉', count: 2, ownerReacted: true },
    { emoji: '👀', count: 1, ownerReacted: false },
  ])

  await feed.clearReactions({ emoji: '🎉', message })

  assert.deepEqual(await reactionsOf(), [
    { emoji: '👀', count: 1, ownerReacted: false },
  ])

  await feed.clearReactions({ message })

  assert.deepEqual(await reactionsOf(), [])
})
