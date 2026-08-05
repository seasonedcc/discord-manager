import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Fetched = {
  message: {
    repliedTo: {
      discordMessageId: string
      jumpUrl: string
      messageId: string | null
    } | null
    status: string
  }
}

test('a live fetch says a message answers nothing unless Discord names what it answers', async () => {
  const { channels, clock, members, messages } = fixtures()
  const session = await openMcpSession()

  const forward = await feed.postMessage({
    author: members.maya,
    channel: channels.engineering,
    content: `Passing this on from announcements — ${randomUUID()}`,
    discordCreatedAt: clock.at(30),
  })
  const unnamed = await feed.postMessage({
    author: members.omar,
    channel: channels.engineering,
    content: `Answering something Discord will not name — ${randomUUID()}`,
    discordCreatedAt: clock.at(31),
  })

  session.discord.holdsMessage(forward.discordMessageId, {
    content: forward.content,
    forwarding: {
      discordChannelId: messages.offsite.discordChannelId,
      discordMessageId: messages.offsite.discordMessageId,
    },
  })
  session.discord.holdsMessage(unnamed.discordMessageId, {
    answeringAMessageDiscordDoesNotName: {
      discordChannelId: channels.engineering.discordChannelId,
    },
    content: unnamed.content,
  })

  const forwarded = await session.call<Fetched>('messages_fetch', {
    messageId: forward.id,
  })

  assert.equal(forwarded.message.status, 'retrieved')
  assert.equal(forwarded.message.repliedTo, null)

  const answered = await session.call<Fetched>('messages_fetch', {
    messageId: unnamed.id,
  })

  assert.equal(answered.message.status, 'retrieved')
  assert.equal(answered.message.repliedTo, null)
})
