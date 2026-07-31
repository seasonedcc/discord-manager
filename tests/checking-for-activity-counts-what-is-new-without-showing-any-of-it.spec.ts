import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Activity = {
  activity: {
    bookmarkAdditions: { count: number; newestAt: string | null }
    mentions: { count: number; newestAt: string | null }
    messages: { count: number; newestAt: string | null }
  }
}

const nothingNew = {
  bookmarkAdditions: { count: 0, newestAt: null },
  mentions: { count: 0, newestAt: null },
  messages: { count: 0, newestAt: null },
}

function nextCursor({ activity }: Activity) {
  const newest = [
    activity.bookmarkAdditions.newestAt,
    activity.mentions.newestAt,
    activity.messages.newestAt,
  ].reduce<string | null>(
    (largest, instant) =>
      instant && (!largest || instant > largest) ? instant : largest,
    null
  )

  if (!newest) throw new Error('the answer carried no newest timestamp')

  return newest
}

test('checking for activity counts what is new without showing any of it', async () => {
  const { channels, clock, members, messages, owner } = fixtures()
  const session = await openMcpSession()

  const everything = await session.call<Activity>('activity_since', {
    since: clock.anchor,
  })
  const afterEverything = nextCursor(everything)

  const settled = await session.call<Activity>('activity_since', {
    since: afterEverything,
  })

  assert.deepEqual(settled.activity, nothingNew)

  const stampedAheadOfTheStoresClock = clock.at(45)
  const fresh = await feed.postMessage({
    author: members.priya,
    channel: channels.engineering,
    content: `Standup notes are up — ${randomUUID()}`,
    discordCreatedAt: stampedAheadOfTheStoresClock,
    mentioning: [owner],
  })

  const afterPosting = await session.call<Activity>('activity_since', {
    since: afterEverything,
  })
  const recordedAt = afterPosting.activity.messages.newestAt

  assert.equal(afterPosting.activity.messages.count, 1)
  assert.equal(afterPosting.activity.mentions.count, 1)
  assert.deepEqual(afterPosting.activity.bookmarkAdditions, {
    count: 0,
    newestAt: null,
  })
  assert.equal(afterPosting.activity.mentions.newestAt, recordedAt)
  assert.ok(recordedAt && recordedAt > afterEverything)
  assert.ok(recordedAt < stampedAheadOfTheStoresClock)

  const afterTheMessage = nextCursor(afterPosting)

  await feed.reactToMessage({ emoji: '🔖', message: fresh, reactor: owner })

  const afterBookmarking = await session.call<Activity>('activity_since', {
    since: afterTheMessage,
  })
  const bookmarkedAt = afterBookmarking.activity.bookmarkAdditions.newestAt

  assert.equal(afterBookmarking.activity.bookmarkAdditions.count, 1)
  assert.ok(bookmarkedAt && bookmarkedAt > afterTheMessage)
  assert.deepEqual(afterBookmarking.activity.messages, {
    count: 0,
    newestAt: null,
  })
  assert.deepEqual(afterBookmarking.activity.mentions, {
    count: 0,
    newestAt: null,
  })

  const afterTheBookmark = nextCursor(afterBookmarking)

  const quietAgain = await session.call<Activity>('activity_since', {
    since: afterTheBookmark,
  })

  assert.deepEqual(quietAgain.activity, nothingNew)

  const answered = [
    everything,
    settled,
    afterPosting,
    afterBookmarking,
    quietAgain,
  ]
    .map((answer) => JSON.stringify(answer))
    .join('')

  assert.ok(!answered.includes(fresh.content))
  assert.ok(!answered.includes(messages.offsite.content))
  assert.ok(!answered.includes(messages.mention.content))
  assert.ok(!answered.includes(channels.engineering.name))
  assert.ok(!answered.includes(members.priya.displayName))
})
