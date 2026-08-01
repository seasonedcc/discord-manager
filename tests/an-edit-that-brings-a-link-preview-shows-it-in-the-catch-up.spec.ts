import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { feed } from './seed/feed'
import { test } from './spec'

type Digest = {
  messages: {
    attachments: { filename: string; size: number; url: string }[]
    embeds: string[]
    messageId: string
  }[]
}

const preview = {
  description: 'Every decision the team agreed to keep, in one place.',
  title: 'Decisions',
  url: 'https://handbook.example.test/decisions',
}

const attached = {
  filename: 'decisions.pdf',
  size: 8400,
  url: 'https://cdn.example.test/decisions.pdf',
}

test('an edit that brings a link preview shows it in the catch-up', async () => {
  const { channels, clock, members } = fixtures()
  const session = await openMcpSession()
  const postedAt = clock.at(51)
  const posted = await feed.postMessage({
    author: members.maya,
    channel: channels.engineering,
    content: `The decision log moved — ${randomUUID()}`,
    discordCreatedAt: postedAt,
  })
  const readBack = async () => {
    const digest = await session.call<Digest>('messages_catch_up', {
      channelId: channels.engineering.id,
      since: postedAt,
    })
    const [message] = digest.messages.filter(
      ({ messageId }) => messageId === posted.id
    )

    assert.ok(message, 'the posted message never reached the catch-up')

    return message
  }

  const before = await readBack()

  assert.deepEqual(before.embeds, [])
  assert.deepEqual(before.attachments, [])

  await feed.editMessage(posted, `${posted.content} ${preview.url}`, {
    attachments: [attached],
    embeds: [preview],
  })

  const after = await readBack()

  assert.deepEqual(after.embeds, [
    `${preview.title} (${preview.url})\n${preview.description}`,
  ])
  assert.deepEqual(after.attachments, [attached])
})
