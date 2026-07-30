import { isContextError } from 'composable-functions'
import { backfillStatusCopy } from '~/business/ingestion-status.common'
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

describe('ingestion_status', () => {
  it('reads how far the backfills of this server have got', async () => {
    const guild = await createGuild()
    const channel = await createChannel({ guildId: guild.id })
    const run = await db()
      .insertInto('backfillRuns')
      .values({ id: newId(), channelId: channel.id })
      .returningAll()
      .executeTakeFirstOrThrow()

    await db()
      .insertInto('backfillRunProgress')
      .values({
        id: newId(),
        backfillRunId: run.id,
        fetchedMessageCount: 60,
        storedMessageCount: 25,
      })
      .execute()
    await db()
      .insertInto('backfillRunCompletions')
      .values({
        id: newId(),
        backfillRunId: run.id,
        fetchedMessageCount: 60,
        storedMessageCount: 25,
      })
      .execute()

    const { isError, payload } = await callAsOwner(
      'ingestion_status',
      {},
      await ownerContext({ guildId: guild.id })
    )

    expect(isError).toBe(false)
    expect(payload.ingestion.backfill).toMatchObject({
      status: 'completed',
      channels: { completed: 1, failed: 0, running: 0, stalled: 0 },
      fetchedMessageCount: 60,
      storedMessageCount: 25,
      ...backfillStatusCopy.completed,
    })
    expect(payload.ingestion.gateway.activity).toMatch(
      /^(never|quiet|receiving)$/
    )
  })

  it('refuses a context that cannot read messages', async () => {
    const guild = await createGuild()
    const context = await ownerContext({ guildId: guild.id })

    const { isError, payload } = await callAsOwner(
      'ingestion_status',
      {},
      { ...context, canReadMessages: false }
    )

    expect(isError).toBe(true)
    expect(isContextError(payload.errors[0])).toBe(true)
    expect(payload.errors[0].path).toEqual(['canReadMessages'])
  })
})
