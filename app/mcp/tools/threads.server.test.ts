import { isContextError, isInputError } from 'composable-functions'
import {
  oneAnchorMessage,
  threadCreationSkipCopy,
} from '~/business/threads.common'
import { newId } from '~/framework/db.server'
import { callTool } from '~/mcp/server.server'
import { createChannel, createGuild, ownerContext } from '~/test/fixtures'
import { db, describe, expect, it } from '~/test/prelude'

async function callAsOwner(name: string, input: unknown, context: unknown) {
  const result = await callTool({ name, arguments: input }, context)
  const [content] = result.content

  if (content?.type !== 'text') throw new Error('expected a text tool result')

  return { isError: result.isError === true, payload: JSON.parse(content.text) }
}

describe('threads_create', () => {
  it('records the skip when the channel is itself a thread', async () => {
    const guild = await createGuild()
    const thread = await createChannel({ guildId: guild.id, isThread: 1 })

    const { isError, payload } = await callAsOwner(
      'threads_create',
      { channelId: thread.id, name: 'a thread inside a thread' },
      await ownerContext({ guildId: guild.id })
    )

    const skips = await db()
      .selectFrom('threadCreationSkips')
      .selectAll()
      .where('threadCreationRequestId', '=', payload.thread.requestId)
      .execute()

    expect(isError).toBe(false)
    expect(payload.thread).toMatchObject({
      status: 'skipped',
      reason: 'channel_is_a_thread',
      ...threadCreationSkipCopy.channel_is_a_thread,
    })
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('channel_is_a_thread')
  })

  it('refuses a request naming both a channel and a message', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'threads_create',
      { channelId: channel.id, messageId: newId(), name: 'which one' },
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(true)
    expect(isInputError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].message).toBe(oneAnchorMessage)
  })

  it('refuses a context that cannot send messages', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'threads_create',
      { channelId: channel.id, name: 'not allowed' },
      { ...context, canSendMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canSendMessages'])
  })
})
