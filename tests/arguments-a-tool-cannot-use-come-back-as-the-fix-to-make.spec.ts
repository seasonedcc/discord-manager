import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

test('arguments a tool cannot use come back as the fix to make', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const noChannel = await session.callExpectingRefusal('messages_catch_up', {
    channelId: null,
    since: clock.at(5),
  })

  assert.equal(noChannel.errors.length, 1)
  assert.deepEqual(noChannel.errors[0].path, ['channelId'])
  assert.equal(
    noChannel.errors[0].message,
    'Pass a `channelId` from channels_list, or leave it out to read the whole server'
  )

  const tooManyBookmarks = await session.callExpectingRefusal(
    'bookmarks_list',
    { limit: 1000 }
  )

  assert.equal(tooManyBookmarks.errors.length, 1)
  assert.deepEqual(tooManyBookmarks.errors[0].path, ['limit'])
  assert.equal(
    tooManyBookmarks.errors[0].message,
    'Ask for a whole number of bookmarks, from 1 to 500'
  )

  const noReason = await session.callExpectingRefusal('bookmarks_add', {
    messageLink: messages.offsite.jumpUrl,
  })

  assert.equal(noReason.errors.length, 1)
  assert.deepEqual(noReason.errors[0].path, ['reasonId'])
  assert.equal(
    noReason.errors[0].message,
    'Pass a `reasonId` from bookmark_reasons_list'
  )

  const snowflakeAsNumber = await session.callExpectingRefusal(
    'messages_fetch',
    { messageId: Number(messages.offsite.discordMessageId) }
  )

  assert.equal(snowflakeAsNumber.errors.length, 1)
  assert.deepEqual(snowflakeAsNumber.errors[0].path, ['messageId'])
  assert.equal(
    snowflakeAsNumber.errors[0].message,
    'Pass a `messageId` from messages_catch_up, mentions_list or bookmarks_list, not the Discord message snowflake'
  )

  const overlongPost = await session.callExpectingRefusal('messages_send', {
    channelId: channels.engineering.id,
    content: 'a'.repeat(2001),
  })

  assert.equal(overlongPost.errors.length, 1)
  assert.deepEqual(overlongPost.errors[0].path, ['content'])
  assert.equal(
    overlongPost.errors[0].message,
    'Write the message text to post, up to 2000 characters'
  )

  assert.equal(session.discord.sends.length, 0)
  assert.equal(session.discord.reads.length, 0)
})
