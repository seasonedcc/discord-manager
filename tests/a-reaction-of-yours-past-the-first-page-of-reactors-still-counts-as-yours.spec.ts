import assert from 'node:assert/strict'
import { nextDiscordId } from './discord-ids'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    reactions: { count: number; emoji: string; ownerReacted: boolean }[]
    status: string
  }
}

test('a reaction of yours past the first page of reactors still counts as yours', async () => {
  const { messages, owner } = fixtures()
  const session = await openMcpSession()
  const reactorDiscordUserIds = [
    ...Array.from({ length: 100 }, () => nextDiscordId()),
    owner.discordUserId,
  ]

  session.discord.holdsMessage(messages.offsite.discordMessageId, {
    content: messages.offsite.content,
    reactions: [{ emoji: { id: null, name: '👍' }, reactorDiscordUserIds }],
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.offsite.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.deepEqual(message.reactions, [
    { count: 101, emoji: '👍', ownerReacted: true },
  ])
})
