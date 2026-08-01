import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Fetched = {
  message: { content: string; embeds: string[]; status: string }
}

const suppressEmbedsFlag = 4

test('an embed the poster suppressed stays out of the fetch', async () => {
  const { messages } = fixtures()
  const session = await openMcpSession()

  session.discord.holdsMessage(messages.offsite.discordMessageId, {
    content: messages.offsite.content,
    embeds: [
      {
        description: 'The agenda is in the handbook.',
        title: 'Team offsite',
        url: 'https://handbook.example.test/offsite',
      },
    ],
    flags: suppressEmbedsFlag,
  })

  const { message } = await session.call<Fetched>('messages_fetch', {
    messageId: messages.offsite.id,
  })

  assert.equal(message.status, 'retrieved')
  assert.equal(message.content, messages.offsite.content)
  assert.deepEqual(message.embeds, [])
})
