import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: { messageId: string; snoozedUntil: string | null }[]
}

type SnoozedBookmark = {
  bookmark: { messageId: string; snoozedAt: string; snoozedUntil: string }
}

test('a snoozed bookmark stays out of the way until you ask for it', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `Quarterly planning doc to read later — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })

  await feed.reactToMessage({ emoji: '🔖', message, reactor: owner })

  const tomorrow = clock.at(60 * 24)
  const snoozed = await session.call<SnoozedBookmark>('bookmarks_snooze', {
    messageId: message.id,
    until: tomorrow,
  })

  assert.equal(snoozed.bookmark.messageId, message.id)
  assert.equal(snoozed.bookmark.snoozedUntil, tomorrow)

  const waiting = await session.call<BookmarkList>('bookmarks_list')

  assert.equal(
    waiting.bookmarks.filter(({ messageId }) => messageId === message.id)
      .length,
    0
  )

  const withSnoozed = await session.call<BookmarkList>('bookmarks_list', {
    includeSnoozed: true,
  })
  const listed = withSnoozed.bookmarks.filter(
    ({ messageId }) => messageId === message.id
  )

  assert.equal(listed.length, 1)
  assert.equal(listed[0].snoozedUntil, tomorrow)
})
