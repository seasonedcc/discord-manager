import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Digest = {
  messages: { messageId: string }[]
}

type BookmarkList = {
  bookmarks: { deletedUpstream: boolean; messageId: string }[]
}

type ReasonList = {
  reasons: { name: string; reasonId: string }[]
}

type Fetched = {
  message: {
    channelId: string
    messageId: string
    nextAction: string
    reason?: string
    status: string
    summary: string
  }
}

const goneSummary =
  'Discord no longer has this message — it was deleted there, and the store has now recorded that.'
const goneNextAction =
  'Tell the owner it is gone — it stops coming back in catch-ups and mentions from here on, and a bookmark on it stays listed with `deletedUpstream` set until they resolve it with bookmarks_resolve. Read `channelId` back through messages_catch_up to see what stands in that channel now.'
const skipSummary =
  'That message was deleted in Discord, so nothing was fetched.'

test('a message Discord no longer has leaves the catch-up but keeps its bookmark', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()
  const postedAt = clock.at(50)
  const doomed = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `The staging box is back up — ${randomUUID()}`,
    discordCreatedAt: postedAt,
  })
  const timesDiscordWasAsked = () =>
    session.discord.reads.filter(
      ({ discordMessageId }) => discordMessageId === doomed.discordMessageId
    ).length
  const catchUp = () =>
    session.call<Digest>('messages_catch_up', {
      channelId: channels.engineering.id,
      since: postedAt,
    })
  const bookmarksOnIt = async () => {
    const { bookmarks } = await session.call<BookmarkList>('bookmarks_list')

    return bookmarks.filter(({ messageId }) => messageId === doomed.id)
  }

  const { reasons } = await session.call<ReasonList>('bookmark_reasons_list')
  const inbox = reasons.find(({ name }) => name === 'Inbox')

  assert.ok(inbox, 'the shipped Inbox reason is missing')

  await session.call('bookmarks_add', {
    messageLink: doomed.jumpUrl,
    reasonId: inbox.reasonId,
  })

  const before = await catchUp()

  assert.equal(
    before.messages.filter(({ messageId }) => messageId === doomed.id).length,
    1
  )
  assert.deepEqual(
    (await bookmarksOnIt()).map(({ deletedUpstream }) => deletedUpstream),
    [false]
  )

  session.discord.forgetsMessage(doomed.discordMessageId)

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: doomed.id,
  })

  assert.equal(message.status, 'failed')
  assert.equal(message.messageId, doomed.id)
  assert.equal(message.channelId, doomed.channelId)
  assert.equal(message.summary, goneSummary)
  assert.equal(message.nextAction, goneNextAction)
  assert.equal(JSON.stringify(message).includes('Unknown Message'), false)
  assert.equal(JSON.stringify(message).includes('10008'), false)
  assert.equal(timesDiscordWasAsked(), 1)

  const after = await catchUp()

  assert.equal(
    after.messages.filter(({ messageId }) => messageId === doomed.id).length,
    0
  )
  assert.deepEqual(
    (await bookmarksOnIt()).map(({ deletedUpstream }) => deletedUpstream),
    [true]
  )

  await session.call('bookmarks_resolve', { messageId: doomed.id })

  assert.equal((await bookmarksOnIt()).length, 0)

  const again = await session.call<Fetched>('messages_fetch', {
    messageId: doomed.id,
  })

  assert.equal(again.message.status, 'skipped')
  assert.equal(again.message.reason, 'message_deleted')
  assert.equal(again.message.summary, skipSummary)
  assert.equal(timesDiscordWasAsked(), 1)
})
