import { isContextError } from 'composable-functions'
import { callTool } from '~/mcp/server.server'
import {
  createChannel,
  createGuild,
  createMessage,
  ownerContext,
  snowflake,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60_000).toISOString()
}

describe('messages_catch_up', () => {
  it('reads the messages a channel collected since a moment in time', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const message = await createMessage({
      channelId: channel.id,
      content: 'the release is out',
    })

    const { isError, payload } = await callAsOwner(
      'messages_catch_up',
      { since: hoursAgo(1), channelId: channel.id },
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.truncated).toBe(false)
    expect(payload.messages).toContainEqual(
      expect.objectContaining({
        messageId: message.id,
        content: 'the release is out',
      })
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'messages_catch_up',
      { since: hoursAgo(1) },
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})

describe('mentions_list', () => {
  it('reads the messages that name the owner since a moment in time', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const discordUserId = snowflake()
    const message = await createMessage({
      channelId: channel.id,
      content: `can you look at this <@${discordUserId}>`,
    })

    const { isError, payload } = await callAsOwner(
      'mentions_list',
      { since: hoursAgo(1) },
      await ownerContext({ guildId: guild.id, discordUserId })
    )

    expect(isError).toBe(false)
    expect(payload.messages).toContainEqual(
      expect.objectContaining({ messageId: message.id })
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'mentions_list',
      { since: hoursAgo(1) },
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
