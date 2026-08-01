import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: {
    messageId: string
    nextAction: string
    reason: string
    status: string
    summary: string
  }
}

const skipSummary =
  'That message was deleted in Discord, so nothing was fetched.'
const skipNextAction =
  'Pick another message — read `channelId` back through messages_catch_up to see what stands in that channel now.'

test('a message deleted in Discord is never asked of Discord again', async () => {
  const { messages } = fixtures()
  const session = await openMcpSession()

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.withdrawn.id,
  })

  assert.equal(message.status, 'skipped')
  assert.equal(message.reason, 'message_deleted')
  assert.equal(message.messageId, messages.withdrawn.id)
  assert.equal(message.summary, skipSummary)
  assert.equal(message.nextAction, skipNextAction)
})
