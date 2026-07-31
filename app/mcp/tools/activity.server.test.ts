import { isContextError } from 'composable-functions'
import { callTool } from '~/mcp/server.server'
import {
  createBookmarkedMessage,
  createChannel,
  createGuild,
  ownerContext,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return {
    isError: result.isError === true,
    payload: JSON.parse(content.text),
    text: content.text,
  }
}

describe('activity_since', () => {
  it('counts what the store recorded after an instant without giving up any content', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    await createBookmarkedMessage({
      channelId: channel.id,
      content: `<@${context.owner.discordUserId}> the release notes need a look`,
      recordedAt: '2101-01-02T00:00:00.000Z',
      bookmarkedAt: '2101-01-02T00:00:00.000Z',
    })

    const { isError, payload, text } = await callAsOwner(
      'activity_since',
      { since: '2101-01-01T00:00:00.000Z' },
      context
    )

    expect(isError).toBe(false)
    expect(payload.activity).toEqual({
      messages: { count: 1, newestAt: '2101-01-02T00:00:00.000Z' },
      mentions: { count: 1, newestAt: '2101-01-02T00:00:00.000Z' },
      bookmarkAdditions: { count: 1, newestAt: '2101-01-02T00:00:00.000Z' },
    })
    expect(text).not.toContain('the release notes need a look')
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'activity_since',
      { since: '2101-01-01T00:00:00.000Z' },
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
