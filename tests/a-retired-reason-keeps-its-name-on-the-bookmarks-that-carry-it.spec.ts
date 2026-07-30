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
  reasons: { name: string; reasonId: string }[]
}

test('a retired reason keeps its name on the bookmarks that carry it', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()

  const name = `Quarterly audit ${randomUUID()}`
  const { reason } = await session.call<AddedReason>('bookmark_reasons_add', {
    name,
    description: 'Only matters until the audit closes.',
  })

  const filed = await feed.postMessage({
    author: members.priya,
    channel: channels.engineering,
    content: `Evidence for the audit — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })
  const other = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `One more for the pile — ${randomUUID()}`,
    discordCreatedAt: clock.at(31),
  })

  await session.call('bookmarks_add', {
    messageLink: filed.jumpUrl,
    reasonId: reason.reasonId,
  })
  await session.call('bookmarks_add', {
    messageLink: other.jumpUrl,
    reasonId: reason.reasonId,
  })

  await session.call('bookmark_reasons_retire', { reasonId: reason.reasonId })

  const { reasons } = await session.call<ReasonList>('bookmark_reasons_list')

  assert.equal(
    reasons.filter(({ reasonId }) => reasonId === reason.reasonId).length,
    0
  )

  const { bookmarks } = await session.call<BookmarkList>('bookmarks_list')
  const stillLabelled = bookmarks.filter(
    ({ messageId }) => messageId === filed.id
  )

  assert.equal(stillLabelled.length, 1)
  assert.equal(stillLabelled[0].reasonName, name)

  const refused = await session.callExpectingRefusal('bookmarks_set_reason', {
    messageId: other.id,
    reasonId: reason.reasonId,
  })

  assert.equal(
    refused.errors[0].message,
    'That bookmark reason is retired, so nothing new can be given it. Pick an active reason, or add one.'
  )
  assert.deepEqual(refused.errors[0].path, ['reasonId'])
})
