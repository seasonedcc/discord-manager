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

type Digest = {
  messages: { discordCreatedAt: string }[]
  truncated: boolean
}

function newestInstant(messages: { discordCreatedAt: string }[]) {
  return messages.reduce<string | null>(
    (newest, { discordCreatedAt }) =>
      !newest || discordCreatedAt > newest ? discordCreatedAt : newest,
    null
  )
}

function aMinuteAfter(instant: string) {
  return new Date(Date.parse(instant) + 60_000).toISOString()
}

test('checking for activity counts what is new without showing any of it', async () => {
  const { channels, clock, members, messages, owner } = fixtures()
  const session = await openMcpSession()

  const sinceTheMorning = clock.at(5)
  const morning = await session.call<Activity>('activity_since', {
    since: sinceTheMorning,
  })
  const digest = await session.call<Digest>('messages_catch_up', {
    since: sinceTheMorning,
  })
  const pings = await session.call<Digest>('mentions_list', {
    since: sinceTheMorning,
  })

  assert.equal(digest.truncated, false)
  assert.equal(pings.truncated, false)
  assert.equal(morning.activity.messages.count, digest.messages.length)
  assert.equal(
    morning.activity.messages.newestAt,
    newestInstant(digest.messages)
  )
  assert.equal(morning.activity.mentions.count, pings.messages.length)
  assert.equal(
    morning.activity.mentions.newestAt,
    newestInstant(pings.messages)
  )

  const everythingSoFar = morning.activity.messages.newestAt

  if (!everythingSoFar) throw new Error('the seeded store answered no messages')

  const settled = await session.call<Activity>('activity_since', {
    since: everythingSoFar,
  })

  assert.deepEqual(settled.activity, {
    bookmarkAdditions: { count: 0, newestAt: null },
    mentions: { count: 0, newestAt: null },
    messages: { count: 0, newestAt: null },
  })

  const fresh = await feed.postMessage({
    author: members.priya,
    channel: channels.engineering,
    content: `Standup notes are up — ${randomUUID()}`,
    discordCreatedAt: aMinuteAfter(everythingSoFar),
    mentioning: [owner],
  })

  const afterPosting = await session.call<Activity>('activity_since', {
    since: everythingSoFar,
  })

  assert.deepEqual(afterPosting.activity, {
    bookmarkAdditions: { count: 0, newestAt: null },
    mentions: { count: 1, newestAt: fresh.discordCreatedAt },
    messages: { count: 1, newestAt: fresh.discordCreatedAt },
  })

  const beforeBookmarking = await session.call<Activity>('activity_since', {
    since: clock.anchor,
  })

  await feed.reactToMessage({ emoji: '🔖', message: fresh, reactor: owner })

  const afterBookmarking = await session.call<Activity>('activity_since', {
    since: clock.anchor,
  })

  assert.equal(
    afterBookmarking.activity.bookmarkAdditions.count,
    beforeBookmarking.activity.bookmarkAdditions.count + 1
  )
  assert.notEqual(
    afterBookmarking.activity.bookmarkAdditions.newestAt,
    beforeBookmarking.activity.bookmarkAdditions.newestAt
  )
  assert.equal(
    afterBookmarking.activity.messages.count,
    beforeBookmarking.activity.messages.count
  )
  assert.equal(
    afterBookmarking.activity.mentions.count,
    beforeBookmarking.activity.mentions.count
  )

  const answered = JSON.stringify(afterBookmarking)

  assert.ok(!answered.includes(fresh.content))
  assert.ok(!answered.includes(messages.offsite.content))
  assert.ok(!answered.includes(messages.mention.content))
  assert.ok(!answered.includes(channels.engineering.name))
  assert.ok(!answered.includes(members.priya.displayName))
})
