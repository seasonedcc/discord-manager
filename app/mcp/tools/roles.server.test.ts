import { isContextError, isInputError } from 'composable-functions'
import { everyoneSetAsideMessage } from '~/business/roles.common'
import { db } from '~/db/db.server'
import { callTool } from '~/mcp/server.server'
import { createGuild, ownerContext } from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

describe('roles_list', () => {
  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'roles_list',
      {},
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})

describe('channels_access', () => {
  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'channels_access',
      {},
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })

  it('refuses @everyone without asking Discord', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'channels_access',
      { withoutDiscordRoleId: context.owner.guildId },
      context
    )
    const requests = await db()
      .selectFrom('permissionFetchRequests')
      .select('id')
      .where('discordGuildId', '=', context.owner.guildId)
      .execute()

    expect(isError).toBe(true)
    expect(isInputError(payload.errors[0])).toBe(true)
    expect(payload.errors[0]).toMatchObject({
      message: everyoneSetAsideMessage,
      path: ['withoutDiscordRoleId'],
    })
    expect(requests).toHaveLength(0)
  })
})
