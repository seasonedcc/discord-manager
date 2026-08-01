import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    messageId: string
    reactions: { emoji: string; count: number; ownerReacted: boolean }[]
  }[]
}

type BookmarkList = {
  bookmarks: { messageId: string }[]
}

test("a teammate's reaction shows up without becoming a bookmark", async () => {
  const { bookmarks, channels, clock, reactions } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.anchor,
  })
  const cheered = digest.messages.filter(
    ({ messageId }) => messageId === reactions.cheeredByATeammate.id
  )

  assert.equal(cheered.length, 1)
  assert.deepEqual(cheered[0].reactions, [
    { emoji: '🎉', count: 1, ownerReacted: false },
  ])

  const listed = await session.call<BookmarkList>('bookmarks_list')

  assert.equal(
    listed.bookmarks.filter(
      ({ messageId }) => messageId === reactions.cheeredByATeammate.id
    ).length,
    0
  )
  assert.equal(
    listed.bookmarks.filter(
      ({ messageId }) => messageId === bookmarks.reactedByATeammate.id
    ).length,
    0
  )

  const bookmarkedAllTheSame = listed.bookmarks.filter(
    ({ messageId }) => messageId === bookmarks.bookmarked.id
  )

  assert.equal(bookmarkedAllTheSame.length, 1)
})
