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

function afterAMoment() {
  return new Promise((resolve) => setTimeout(resolve, 500))
}

test('waiting for activity comes back the moment a message arrives', async () => {
  const { channels, clock, members, owner } = fixtures()
  const session = await openMcpSession()

  const everything = await session.call<Activity>('activity_since', {
    since: clock.anchor,
  })
  const caughtUp = nextCursor(everything)

  const startedWaiting = Date.now()
  const quiet = await session.call<Activity>('activity_since', {
    since: caughtUp,
    waitSeconds: 2,
  })
  const waitedFor = Date.now() - startedWaiting

  assert.deepEqual(quiet.activity, nothingNew)
  assert.ok(
    waitedFor >= 1900,
    `the quiet wait answered after ${waitedFor}ms instead of holding its two seconds open`
  )

  const startedWatching = Date.now()
  const watching = session.call<Activity>('activity_since', {
    since: caughtUp,
    waitSeconds: 10,
  })

  await afterAMoment()

  const arrived = await feed.postMessage({
    author: members.maya,
    channel: channels.lobby,
    content: `Anyone else seeing the staging deploy hang? — ${randomUUID()}`,
    discordCreatedAt: clock.at(90),
    mentioning: [owner],
  })
  const woke = await watching
  const watchedFor = Date.now() - startedWatching

  assert.equal(woke.activity.messages.count, 1)
  assert.equal(woke.activity.mentions.count, 1)
  assert.ok(
    watchedFor < 8000,
    `the watch answered after ${watchedFor}ms, which is its deadline rather than the arrival`
  )

  const wokeAt = woke.activity.messages.newestAt

  assert.ok(wokeAt && wokeAt > caughtUp)
  assert.equal(woke.activity.mentions.newestAt, wokeAt)
  assert.ok(!JSON.stringify(woke).includes(arrived.content))

  const settledAgain = await session.call<Activity>('activity_since', {
    since: nextCursor(woke),
    waitSeconds: 1,
  })

  assert.deepEqual(settledAgain.activity, nothingNew)
})
