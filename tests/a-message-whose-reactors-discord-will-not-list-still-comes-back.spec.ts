import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    content: string
    messageId: string
    nextAction: string
    reactions?: unknown[]
    status: string
    summary: string
  }
}

const retrievalSummary = 'This is what Discord has for the message right now.'

test('a message whose reactors Discord will not list still comes back', async () => {
  const { members, messages, owner } = fixtures()
  const session = await openMcpSession()

  session.discord.holdsMessage(messages.replyPing.discordMessageId, {
    content: messages.replyPing.content,
    reactions: [
      {
        emoji: { id: null, name: '👍' },
        reactorDiscordUserIds: [
          members.maya.discordUserId,
          owner.discordUserId,
        ],
      },
    ],
  })
  session.discord.refuseReactorListingsOf(messages.replyPing.discordMessageId)

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.replyPing.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.equal(message.messageId, messages.replyPing.id)
  assert.equal(message.content, messages.replyPing.content)
  assert.equal(message.summary, retrievalSummary)
  assert.equal(Object.hasOwn(message, 'reactions'), false)
  assert.equal(JSON.stringify(message).includes('Missing Access'), false)
  assert.equal(JSON.stringify(message).includes('50001'), false)
})
