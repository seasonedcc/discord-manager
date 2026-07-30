import { sql } from 'kysely'
import { newId } from '~/framework/db.server'
import { createMessage } from './fixtures'
import { db, describe, expect, it } from './prelude'

function latestMessageRevision(messageId: string) {
  const rankedRevisions = db()
    .selectFrom('messageRevisions')
    .select((eb) => [
      'messageId',
      'content',
      'createdAt',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('messageId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])

  return db()
    .selectFrom(rankedRevisions.as('rankedRevisions'))
    .selectAll()
    .where('rowNumber', '=', 1)
    .where('messageId', '=', messageId)
    .executeTakeFirstOrThrow()
}

function latestBookmarkEvent(messageId: string) {
  const bookmarkEvents = db()
    .selectFrom('bookmarkAdditions')
    .select([
      'id',
      'messageId',
      'source',
      'createdAt',
      sql<number>`1`.as('bookmarked'),
    ])
    .unionAll(
      db()
        .selectFrom('bookmarkRemovals')
        .select([
          'id',
          'messageId',
          'source',
          'createdAt',
          sql<number>`0`.as('bookmarked'),
        ])
    )

  const rankedBookmarkEvents = db()
    .selectFrom(bookmarkEvents.as('bookmarkEvents'))
    .select((eb) => [
      'messageId',
      'source',
      'bookmarked',
      'createdAt',
      eb.fn
        .agg<number>('row_number')
        .over((over) =>
          over
            .partitionBy('messageId')
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
        )
        .as('rowNumber'),
    ])

  return db()
    .selectFrom(rankedBookmarkEvents.as('rankedBookmarkEvents'))
    .selectAll()
    .where('rowNumber', '=', 1)
    .where('messageId', '=', messageId)
    .executeTakeFirstOrThrow()
}

describe('the unit database', () => {
  it('answers queries against the migrated schema', async () => {
    const { count } = await db()
      .selectFrom('guilds')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()

    expect(count).toBeGreaterThanOrEqual(0)
  })
})

describe('latest revision wins', () => {
  it('returns the newest snapshot of a message', async () => {
    const message = await createMessage({ content: 'as first ingested' })

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'after the first edit',
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()

    await db()
      .insertInto('messageRevisions')
      .values({
        id: newId(),
        messageId: message.id,
        content: 'after the second edit',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    const revision = await latestMessageRevision(message.id)

    expect(revision.content).toEqual('after the second edit')
    expect(revision.createdAt).toEqual('2099-01-02T00:00:00.000Z')
  })
})

describe('bookmark addition and removal pairs', () => {
  it('returns the newer of the two latest events', async () => {
    const message = await createMessage()

    await db()
      .insertInto('bookmarkAdditions')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'reaction',
        createdAt: '2099-01-01T00:00:00.000Z',
      })
      .execute()

    await db()
      .insertInto('bookmarkRemovals')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'mcp',
        createdAt: '2099-01-02T00:00:00.000Z',
      })
      .execute()

    const afterRemoval = await latestBookmarkEvent(message.id)

    expect(afterRemoval.bookmarked).toEqual(0)
    expect(afterRemoval.source).toEqual('mcp')

    await db()
      .insertInto('bookmarkAdditions')
      .values({
        id: newId(),
        messageId: message.id,
        source: 'reaction',
        createdAt: '2099-01-03T00:00:00.000Z',
      })
      .execute()

    const afterReAdding = await latestBookmarkEvent(message.id)

    expect(afterReAdding.bookmarked).toEqual(1)
    expect(afterReAdding.source).toEqual('reaction')
  })
})
