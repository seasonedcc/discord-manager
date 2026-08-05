import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type BookmarkList = {
  bookmarks: {
    messageId: string
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
  }[]
}

test('a bookmarked reply still says which message it answers', async () => {
  const { bookmarks, messages } = fixtures()
  const session = await openMcpSession()

  const { bookmarks: listed } =
    await session.call<BookmarkList>('bookmarks_list')
  const answer = listed.filter(
    ({ messageId }) => messageId === bookmarks.bookmarkedReply.id
  )
  const remark = listed.filter(
    ({ messageId }) => messageId === bookmarks.bookmarked.id
  )

  assert.equal(answer.length, 1)
  assert.deepEqual(answer[0].repliedTo, bookmarks.bookmarkedReply.repliedTo)
  assert.equal(answer[0].repliedTo?.messageId, messages.mention.id)

  assert.equal(remark.length, 1)
  assert.equal(remark[0].repliedTo, null)
})
