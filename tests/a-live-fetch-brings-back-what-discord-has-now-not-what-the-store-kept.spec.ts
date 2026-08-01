import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    attachments: { filename: string; size: number; url: string }[]
    channelId: string
    content: string
    embeds: string[]
    fetchedAt: string
    jumpUrl: string
    messageId: string
    nextAction: string
    reactions: { count: number; emoji: string; ownerReacted: boolean }[]
    status: string
    summary: string
  }
}

const retrievalSummary = 'This is what Discord has for the message right now.'
const retrievalNextAction =
  'Read it to the owner — any attachment link in it is freshly signed and stops working after about a day.'

test('a live fetch brings back what Discord has now, not what the store kept', async () => {
  const { alert, members, owner } = fixtures()
  const session = await openMcpSession()
  const freshUrl = `https://cdn.example.test/checkout-errors.png?ex=${randomUUID()}`

  session.discord.holdsMessage(alert.message.discordMessageId, {
    attachments: [
      { filename: 'checkout-errors.png', size: 20480, url: freshUrl },
    ],
    content: 'Checkout recovered at 10:41.',
    embeds: [
      {
        author: { name: 'Uptime Watch' },
        description: 'Checkout has been answering 200 for ten minutes.',
        title: 'Checkout recovered',
        url: 'https://status.example.test/incidents/412',
      },
    ],
    reactions: [
      {
        emoji: { id: null, name: '🎉' },
        reactorDiscordUserIds: [
          members.maya.discordUserId,
          owner.discordUserId,
        ],
      },
      {
        botReacted: true,
        emoji: {
          animated: true,
          id: '4100000000000000001',
          name: 'partyparrot',
        },
        reactorDiscordUserIds: [members.omar.discordUserId],
      },
      {
        emoji: { id: '4100000000000000002', name: null },
        reactorDiscordUserIds: [owner.discordUserId],
      },
      {
        emoji: { animated: true, id: '4100000000000000003', name: null },
        reactorDiscordUserIds: [members.maya.discordUserId],
      },
    ],
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: alert.message.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.equal(message.messageId, alert.message.id)
  assert.equal(message.channelId, alert.message.channelId)
  assert.equal(message.jumpUrl, alert.message.jumpUrl)
  assert.equal(message.content, 'Checkout recovered at 10:41.')
  assert.deepEqual(message.embeds, [
    [
      'Uptime Watch',
      'Checkout recovered (https://status.example.test/incidents/412)',
      'Checkout has been answering 200 for ten minutes.',
    ].join('\n'),
  ])
  assert.deepEqual(message.attachments, [
    { filename: 'checkout-errors.png', size: 20480, url: freshUrl },
  ])
  assert.notEqual(message.attachments[0].url, alert.message.attachments[0].url)
  assert.deepEqual(message.reactions, [
    { count: 2, emoji: '🎉', ownerReacted: true },
    {
      count: 1,
      emoji: 'a:partyparrot:4100000000000000001',
      ownerReacted: false,
    },
    { count: 1, emoji: ':4100000000000000002', ownerReacted: true },
    { count: 1, emoji: ':4100000000000000003', ownerReacted: false },
  ])
  assert.equal(message.summary, retrievalSummary)
  assert.equal(message.nextAction, retrievalNextAction)
  assert.equal(message.fetchedAt, new Date(message.fetchedAt).toISOString())
})
