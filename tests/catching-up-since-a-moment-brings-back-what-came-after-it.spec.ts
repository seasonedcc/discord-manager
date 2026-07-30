import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    authorDisplayName: string
    channelId: string
    channelName: string
    content: string
    discordCreatedAt: string
    discordMessageId: string
    id: string
    jumpUrl: string
  }[]
  truncated: boolean
}

test('catching up since a moment brings back what came after it', async () => {
  const { backfill, channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    since: clock.at(5),
  })
  const offsite = digest.messages.filter(({ id }) => id === messages.offsite.id)

  assert.equal(offsite.length, 1)
  assert.equal(offsite[0].content, messages.offsite.content)
  assert.equal(offsite[0].channelName, channels.announcements.name)
  assert.equal(
    offsite[0].authorDisplayName,
    messages.offsite.author.displayName
  )
  assert.equal(offsite[0].discordCreatedAt, messages.offsite.discordCreatedAt)
  assert.equal(offsite[0].jumpUrl, messages.offsite.jumpUrl)
  assert.equal(digest.truncated, false)

  for (const older of backfill.messages) {
    assert.equal(
      digest.messages.filter(
        ({ discordMessageId }) => discordMessageId === older.discordMessageId
      ).length,
      0
    )
  }

  const inEngineering = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: clock.at(5),
  })

  assert.equal(
    inEngineering.messages.filter(({ id }) => id === messages.mention.id)
      .length,
    1
  )
  assert.equal(
    inEngineering.messages.filter(({ id }) => id === messages.offsite.id)
      .length,
    0
  )
  assert.ok(
    inEngineering.messages.every(
      ({ channelId }) => channelId === channels.engineering.id
    )
  )
})
