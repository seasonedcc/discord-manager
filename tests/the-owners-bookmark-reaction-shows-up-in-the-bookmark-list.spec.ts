import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type BookmarkList = {
  truncated: boolean
  bookmarks: {
    authorDisplayName: string
    channelName: string
    content: string
    deletedUpstream: boolean
    discordMessageId: string
    jumpUrl: string
    messageId: string
    snoozedUntil: string | null
    source: string
  }[]
}

test("the owner's bookmark reaction shows up in the bookmark list", async () => {
  const { bookmarks, channels } = fixtures()
  const session = await openMcpSession()

  const whole = await session.call<BookmarkList>('bookmarks_list')
  const listed = whole.bookmarks
  const reacted = listed.filter(
    ({ messageId }) => messageId === bookmarks.bookmarked.id
  )

  assert.equal(reacted.length, 1)
  assert.equal(reacted[0].source, 'reaction')
  assert.equal(reacted[0].content, bookmarks.bookmarked.content)
  assert.equal(
    reacted[0].authorDisplayName,
    bookmarks.bookmarked.author.displayName
  )
  assert.equal(reacted[0].channelName, channels.announcements.name)
  assert.equal(
    reacted[0].discordMessageId,
    bookmarks.bookmarked.discordMessageId
  )
  assert.equal(reacted[0].jumpUrl, bookmarks.bookmarked.jumpUrl)
  assert.equal(reacted[0].deletedUpstream, false)
  assert.equal(reacted[0].snoozedUntil, null)

  assert.equal(
    listed.filter(
      ({ messageId }) => messageId === bookmarks.reactedByATeammate.id
    ).length,
    0
  )
  assert.equal(
    listed.filter(
      ({ messageId }) => messageId === bookmarks.reactedWithAnotherEmoji.id
    ).length,
    0
  )

  assert.equal(whole.truncated, false)

  const onlyOne = await session.call<BookmarkList>('bookmarks_list', {
    limit: 1,
  })

  assert.equal(onlyOne.bookmarks.length, 1)
})
