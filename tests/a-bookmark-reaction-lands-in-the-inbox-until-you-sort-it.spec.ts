import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: { messageId: string; reasonId: string; reasonName: string }[]
}

type ReasonList = {
  reasons: { name: string; reasonId: string }[]
}

type SortedBookmark = {
  bookmark: { messageId: string; reasonId: string; reasonName: string }
}

test('a bookmark reaction lands in the inbox until you sort it', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const message = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `Can you take a look at the rollout plan? — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })

  await feed.reactToMessage({ emoji: '🔖', message, reactor: owner })

  const captured = await session.call<BookmarkList>('bookmarks_list')
  const unsorted = captured.bookmarks.filter(
    ({ messageId }) => messageId === message.id
  )

  assert.equal(unsorted.length, 1)
  assert.equal(unsorted[0].reasonName, 'Inbox')

  const { reasons } = await session.call<ReasonList>('bookmark_reasons_list')
  const answerLater = reasons.find(({ name }) => name === 'Answer later')

  assert.ok(answerLater, 'the shipped Answer later reason is missing')

  const sorted = await session.call<SortedBookmark>('bookmarks_set_reason', {
    messageId: message.id,
    reasonId: answerLater.reasonId,
  })

  assert.equal(sorted.bookmark.reasonName, 'Answer later')

  const after = await session.call<BookmarkList>('bookmarks_list')
  const resorted = after.bookmarks.filter(
    ({ messageId }) => messageId === message.id
  )

  assert.equal(resorted.length, 1)
  assert.equal(resorted[0].reasonId, answerLater.reasonId)
  assert.equal(resorted[0].reasonName, 'Answer later')

  const backInTheInbox = await session.call<BookmarkList>('bookmarks_list', {
    reasonId: unsorted[0].reasonId,
  })

  assert.equal(
    backInTheInbox.bookmarks.filter(({ messageId }) => messageId === message.id)
      .length,
    0
  )
})
