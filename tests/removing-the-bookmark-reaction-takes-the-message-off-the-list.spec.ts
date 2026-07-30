import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: { messageId: string }[]
}

test('removing the bookmark reaction takes the message off the list', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The runbook needs a second pair of eyes — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })

  await feed.reactToMessage({ emoji: '🔖', message, reactor: owner })

  const withTheReaction = await session.call<BookmarkList>('bookmarks_list')

  assert.equal(
    withTheReaction.bookmarks.filter(
      ({ messageId }) => messageId === message.id
    ).length,
    1
  )

  await feed.undoReaction({ emoji: '🔖', message, reactor: owner })

  const afterTheReactionIsGone =
    await session.call<BookmarkList>('bookmarks_list')

  assert.equal(
    afterTheReactionIsGone.bookmarks.filter(
      ({ messageId }) => messageId === message.id
    ).length,
    0
  )
})
