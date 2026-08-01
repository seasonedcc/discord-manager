import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: { messageId: string }[]
}

type Fetched = {
  message: {
    messageId: string
    nextAction: string
    status: string
    summary: string
  }
}

const refusalSummary =
  'Discord refused to hand this message over, so nothing was read.'
const refusalNextAction =
  'Open `jumpUrl` to find the channel, give the bot View Channel and Read Message History there, check DISCORD_BOT_TOKEN, then fetch it again.'

test('a message Discord refuses to hand over is not treated as deleted', async () => {
  const { channels, messages } = fixtures()
  const session = await openMcpSession()
  const stillStanding = messages.suppressedPing

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: stillStanding.id,
  })

  assert.equal(message.status, 'failed')
  assert.equal(message.messageId, stillStanding.id)
  assert.equal(message.summary, refusalSummary)
  assert.equal(message.nextAction, refusalNextAction)
  assert.equal(JSON.stringify(message).includes('Unknown Channel'), false)
  assert.equal(JSON.stringify(message).includes('10003'), false)

  const digest = await session.call<Digest>('messages_catch_up', {
    channelId: channels.engineering.id,
    since: stillStanding.discordCreatedAt,
  })

  assert.equal(
    digest.messages.filter(({ messageId }) => messageId === stillStanding.id)
      .length,
    1
  )
})
