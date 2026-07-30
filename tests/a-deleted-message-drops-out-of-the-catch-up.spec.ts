import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: { discordMessageId: string; messageId: string }[]
}

test('a deleted message drops out of the catch-up', async () => {
  const { channels, clock, messages } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.announcements.id,
    since: clock.at(5),
  })

  assert.equal(
    digest.messages.filter(({ messageId }) => messageId === messages.offsite.id)
      .length,
    1
  )
  assert.equal(
    digest.messages.filter(
      ({ messageId }) => messageId === messages.withdrawn.id
    ).length,
    0
  )
})
