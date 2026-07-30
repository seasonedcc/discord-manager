import { isContextError } from 'composable-functions'
import { callTool } from '~/mcp/server.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

describe('channels_list', () => {
  it('lists the channels of the server the deployment manages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id, name: 'roadmap' })

    const { isError, payload } = await callAsOwner(
      'channels_list',
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.channels).toContainEqual(
      expect.objectContaining({ channelId: channel.id, name: 'roadmap' })
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'channels_list',
      {},
      {
        ...context,
        canReadMessages: false,
      }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
