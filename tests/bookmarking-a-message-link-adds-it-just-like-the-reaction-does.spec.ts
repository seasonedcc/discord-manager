import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type AddedBookmark = {
  bookmark: { bookmarkedAt: string; messageId: string; source: string }
}

type BookmarkList = {
  bookmarks: {
    bookmarkedAt: string
    content: string
    jumpUrl: string
    messageId: string
    source: string
  }[]
}

test('bookmarking a message link adds it just like the reaction does', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.maya,
    channel: channels.engineering,
    content: `Handbook update worth keeping — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })

  const added = await session.call<AddedBookmark>('bookmarks_add', {
    messageLink: message.jumpUrl,
  })

  assert.equal(added.bookmark.messageId, message.id)
  assert.equal(added.bookmark.source, 'mcp')

  const { bookmarks } = await session.call<BookmarkList>('bookmarks_list')
  const listed = bookmarks.filter(({ messageId }) => messageId === message.id)

  assert.equal(listed.length, 1)
  assert.equal(listed[0].source, 'mcp')
  assert.equal(listed[0].content, message.content)
  assert.equal(listed[0].jumpUrl, message.jumpUrl)
  assert.equal(listed[0].bookmarkedAt, added.bookmark.bookmarkedAt)
})
