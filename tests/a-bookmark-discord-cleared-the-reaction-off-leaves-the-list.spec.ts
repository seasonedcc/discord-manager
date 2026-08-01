import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: { messageId: string }[]
}

type Digest = {
  messages: {
    messageId: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
}

test('a bookmark Discord cleared the reaction off leaves the list', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The migration plan is ready for review — ${randomUUID()}`,
    discordCreatedAt: clock.at(32),
  })

  await feed.reactToMessage({ emoji: '🔖', message, reactor: owner })
  await feed.reactToMessage({ emoji: '👀', message, reactor: members.priya })

  const listedOf = async () => {
    const { bookmarks } = await session.call<BookmarkList>('bookmarks_list')

    return bookmarks.filter(({ messageId }) => messageId === message.id)
  }
  const reactionsOf = async () => {
    const digest = await session.call<Digest>('messages_catch_up', {
      channelId: channels.engineering.id,
      since: clock.anchor,
    })

    return digest.messages.find(({ messageId }) => messageId === message.id)
      ?.reactions
  }

  assert.equal((await listedOf()).length, 1)
  assert.deepEqual(await reactionsOf(), [
    { emoji: '🔖', count: 1, ownerReacted: true },
    { emoji: '👀', count: 1, ownerReacted: false },
  ])

  await feed.clearReactions({ message })

  assert.deepEqual(await reactionsOf(), [])
  assert.equal((await listedOf()).length, 0)
})
