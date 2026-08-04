import { isContextError } from 'composable-functions'
import { callTool } from '~/mcp/server.server'
import {
  createChannel,
  createGatewayIdentification,
  createGuild,
  createMember,
  createMessage,
  ownerContext,
} from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

async function somebodyWhoPosted(
  channelId: string,
  details: { displayName: string; username: string }
) {
  const member = await createMember(details)

  await createMessage({ authorMemberId: member.id, channelId })

  return member
}

describe('members_list', () => {
  it('resolves part of a name into the id a mention tag needs', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const maya = await somebodyWhoPosted(channel.id, {
      displayName: 'Maya Fischer',
      username: 'maya',
    })
    await somebodyWhoPosted(channel.id, {
      displayName: 'Omar Duarte',
      username: 'omar',
    })

    const { isError, payload } = await callAsOwner(
      'members_list',
      { query: 'FISCH' },
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.members).toEqual([
      {
        discordUserId: maya.discordUserId,
        displayName: 'Maya Fischer',
        username: 'maya',
      },
    ])
  })

  it('marks the bot this deployment posts through', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const bot = await somebodyWhoPosted(channel.id, {
      displayName: 'Robin Manager',
      username: 'robin-manager',
    })

    await createGatewayIdentification({
      botDiscordUserId: bot.discordUserId,
      guildId: guild.id,
    })

    const { isError, payload } = await callAsOwner(
      'members_list',
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.members).toEqual([
      {
        discordUserId: bot.discordUserId,
        displayName: 'Robin Manager',
        isYourBot: true,
        username: 'robin-manager',
      },
    ])
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'members_list',
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
