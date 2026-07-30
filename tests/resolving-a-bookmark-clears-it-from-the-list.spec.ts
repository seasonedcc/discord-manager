import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: { messageId: string }[]
}

type ResolvedBookmark = {
  bookmark: { messageId: string; resolvedAt: string; source: string }
}

test('resolving a bookmark clears it from the list', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.maya,
    channel: channels.engineering,
    content: `Ship the release notes today — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })

  await feed.reactToMessage({ emoji: '🔖', message, reactor: owner })

  const resolved = await session.call<ResolvedBookmark>('bookmarks_resolve', {
    messageId: message.id,
  })

  assert.equal(resolved.bookmark.messageId, message.id)
  assert.equal(resolved.bookmark.source, 'mcp')

  const { bookmarks } = await session.call<BookmarkList>('bookmarks_list')

  assert.equal(
    bookmarks.filter(({ messageId }) => messageId === message.id).length,
    0
  )

  const withSnoozed = await session.call<BookmarkList>('bookmarks_list', {
    includeSnoozed: true,
  })

  assert.equal(
    withSnoozed.bookmarks.filter(({ messageId }) => messageId === message.id)
      .length,
    0
  )
})
