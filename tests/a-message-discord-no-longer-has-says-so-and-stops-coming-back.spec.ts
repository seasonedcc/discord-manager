import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    channelId: string
    messageId: string
    nextAction: string
    status: string
    summary: string
  }
}

const goneSummary = 'Discord no longer has this message — it was deleted there.'
const goneNextAction =
  'Tell the owner it is gone, then read `channelId` back through messages_catch_up to see what stands in that channel now.'

test('fetching a message Discord no longer has says so instead of guessing', async () => {
  const { messages } = fixtures()
  const session = await openMcpSession()

  session.discord.forgetsMessage(messages.mention.discordMessageId)

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.mention.id,
  })

  assert.equal(message.status, 'failed')
  assert.equal(message.messageId, messages.mention.id)
  assert.equal(message.channelId, messages.mention.channelId)
  assert.equal(message.summary, goneSummary)
  assert.equal(message.nextAction, goneNextAction)
  assert.equal(JSON.stringify(message).includes('Unknown Message'), false)
  assert.equal(JSON.stringify(message).includes('10008'), false)
})
