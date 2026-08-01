import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    reactions: { count: number; emoji: string; ownerReacted: boolean }[]
    status: string
  }
}

test('a super reaction of yours still counts as yours', async () => {
  const { members, messages, owner } = fixtures()
  const session = await openMcpSession()

  session.discord.holdsMessage(messages.corrected.discordMessageId, {
    content: messages.corrected.content,
    reactions: [
      {
        emoji: { id: null, name: '🔥' },
        reactorDiscordUserIds: [members.maya.discordUserId],
        superReactorDiscordUserIds: [owner.discordUserId],
      },
      {
        emoji: { id: null, name: '👀' },
        reactorDiscordUserIds: [members.omar.discordUserId],
      },
    ],
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.corrected.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.deepEqual(message.reactions, [
    { count: 2, emoji: '🔥', ownerReacted: true },
    { count: 1, emoji: '👀', ownerReacted: false },
  ])
})
