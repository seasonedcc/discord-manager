import assert from 'node:assert/strict'
import { nextDiscordId } from './discord-ids'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type ReasonList = {
  reasons: { name: string; reasonId: string }[]
}

test('bookmarking a link the bot never ingested says what to do next', async () => {
  const { channels, guild } = fixtures()
  const session = await openMcpSession()

  const { reasons } = await session.call<ReasonList>('bookmark_reasons_list')
  const inbox = reasons.find(({ name }) => name === 'Inbox')

  assert.ok(inbox, 'the shipped Inbox reason is missing')

  const neverIngested = `https://discord.com/channels/${guild.discordGuildId}/${channels.engineering.discordChannelId}/${nextDiscordId()}`
  const { errors } = await session.callExpectingRefusal('bookmarks_add', {
    messageLink: neverIngested,
    reasonId: inbox.reasonId,
  })

  assert.equal(errors.length, 1)
  assert.equal(
    errors[0].message,
    'That message has not been ingested yet. Let the bot catch up on that channel, then bookmark it again.'
  )
  assert.deepEqual(errors[0].path, ['messageLink'])
})
