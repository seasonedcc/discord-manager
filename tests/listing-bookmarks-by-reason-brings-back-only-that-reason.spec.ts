import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type AddedReason = {
  reason: { name: string; reasonId: string }
}

type BookmarkList = {
  bookmarks: { messageId: string; reasonName: string }[]
}

type ReasonList = {
  reasons: { bookmarkCount: number; name: string; reasonId: string }[]
}

test('listing bookmarks by reason brings back only that reason', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()

  const name = `Waiting on finance ${randomUUID()}`
  const { reason } = await session.call<AddedReason>('bookmark_reasons_add', {
    name,
    description: 'Blocked until finance answers.',
  })

  const filed = await feed.postMessage({
    author: members.priya,
    channel: channels.engineering,
    content: `Invoice for the runner fleet — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })
  const elsewhere = await feed.postMessage({
    author: members.maya,
    channel: channels.engineering,
    content: `Notes from the sync — ${randomUUID()}`,
    discordCreatedAt: clock.at(31),
  })

  const { reasons } = await session.call<ReasonList>('bookmark_reasons_list')
  const readLater = reasons.find(({ name }) => name === 'Read later')

  assert.ok(readLater, 'the shipped Read later reason is missing')

  await session.call('bookmarks_add', {
    messageLink: filed.jumpUrl,
    reasonId: reason.reasonId,
  })
  await session.call('bookmarks_add', {
    messageLink: elsewhere.jumpUrl,
    reasonId: readLater.reasonId,
  })

  const narrowed = await session.call<BookmarkList>('bookmarks_list', {
    reasonId: reason.reasonId,
  })
  const messageIds = narrowed.bookmarks.map(({ messageId }) => messageId)

  assert.deepEqual(messageIds, [filed.id])
  assert.equal(narrowed.bookmarks[0].reasonName, name)

  const counted = await session.call<ReasonList>('bookmark_reasons_list')
  const mine = counted.reasons.find(
    ({ reasonId }) => reasonId === reason.reasonId
  )

  assert.equal(mine?.bookmarkCount, 1)
})
