import { sql } from 'kysely'
import { createBusyGuild, createMessage } from './fixtures'
import { beforeAll, db, describe, expect, it } from './prelude'
import { expectEveryPlan } from './query-plans'

const latestStateTables = ['message_revisions']

const latestRevisionStep =
  'SEARCH message_revisions USING COVERING INDEX message_revisions_message_id_created_at_id_index (message_id=?)'

const embedsAsJsonArray = sql<string>`json_group_array(
  message_revision_embeds.content order by message_revision_embeds.position
)`.as('embeds')

let busyGuild: Awaited<ReturnType<typeof createBusyGuild>>

beforeAll(async () => {
  busyGuild = await createBusyGuild({ channelCount: 4, messageCount: 2000 })
})

describe('expectEveryPlan', () => {
  it('fails a read that runs no statement', async () => {
    await expect(
      expectEveryPlan(async () => {}, {
        latestStateTables,
        scanning: [],
        reaches: [],
      })
    ).rejects.toThrow('statements the read ran')
  })

  it('plans the statements a read runs inside a transaction', async () => {
    await expect(
      expectEveryPlan(
        () =>
          db()
            .transaction()
            .execute(async (trx) =>
              trx
                .selectFrom('messageRevisions')
                .select('messageRevisions.id')
                .where('messageRevisions.content', '=', 'needle')
                .execute()
            ),
        { latestStateTables, scanning: [], reaches: [] }
      )
    ).rejects.toMatchObject({ actual: ['SCAN message_revisions'] })
  })

  it('fails a lookup run as a statement of its own that sorts', async () => {
    await expect(
      expectEveryPlan(
        () =>
          db()
            .selectFrom('messageRevisions')
            .select('messageRevisions.id')
            .where('messageRevisions.messageId', '=', busyGuild.messageIds[0])
            .orderBy('messageRevisions.id', 'desc')
            .limit(1)
            .executeTakeFirst(),
        { latestStateTables, scanning: [], reaches: [] }
      )
    ).rejects.toMatchObject({
      actual: [
        [
          'the statement itself',
          latestRevisionStep,
          'USE TEMP B-TREE FOR ORDER BY',
        ],
      ],
    })
  })

  it('fails a lookup named with .with() that sorts', async () => {
    const [messageId] = busyGuild.messageIds

    await expect(
      expectEveryPlan(
        () =>
          db()
            .with('latestRevision', (cte) =>
              cte
                .selectFrom('messageRevisions')
                .select('messageRevisions.content')
                .where('messageRevisions.messageId', '=', messageId)
                .orderBy('messageRevisions.id', 'desc')
                .limit(1)
            )
            .selectFrom('messages')
            .innerJoin('latestRevision', (join) => join.onTrue())
            .select(['messages.id', 'latestRevision.content'])
            .where('messages.id', '=', messageId)
            .execute(),
        { latestStateTables, scanning: [], reaches: [] }
      )
    ).rejects.toMatchObject({
      actual: [
        [
          'CO-ROUTINE latest_revision',
          'SEARCH message_revisions USING INDEX message_revisions_message_id_created_at_id_index (message_id=?)',
          'USE TEMP B-TREE FOR ORDER BY',
        ],
      ],
    })
  })

  it('charges an aggregate’s sort to its own subquery, not to a lookup nested in it', async () => {
    const message = await createMessage({ embeds: ['first', 'second'] })

    await expectEveryPlan(
      () =>
        db()
          .selectFrom('messages')
          .select((eb) => [
            'messages.id',
            eb
              .selectFrom('messageRevisionEmbeds')
              .select(embedsAsJsonArray)
              .where(
                'messageRevisionEmbeds.messageRevisionId',
                '=',
                eb
                  .selectFrom('messageRevisions')
                  .select('messageRevisions.id')
                  .whereRef('messageRevisions.messageId', '=', 'messages.id')
                  .orderBy('messageRevisions.createdAt', 'desc')
                  .orderBy('messageRevisions.id', 'desc')
                  .limit(1)
              )
              .as('embeds'),
          ])
          .where('messages.id', '=', message.id)
          .execute(),
      {
        latestStateTables,
        scanning: ['message_revision_embeds'],
        reaches: [
          'USE TEMP B-TREE FOR json_group_array(ORDER BY)',
          latestRevisionStep,
        ],
      }
    )
  })

  it('charges an aggregate’s sort to its own subquery, not to the lookup it is nested in', async () => {
    const message = await createMessage({ embeds: ['first', 'second'] })

    await expectEveryPlan(
      () =>
        db()
          .selectFrom('messages')
          .select((eb) => [
            'messages.id',
            eb
              .selectFrom('messageRevisions')
              .select('messageRevisions.id')
              .whereRef('messageRevisions.messageId', '=', 'messages.id')
              .where(
                (inner) =>
                  inner
                    .selectFrom('messageRevisionEmbeds')
                    .select(embedsAsJsonArray)
                    .whereRef(
                      'messageRevisionEmbeds.messageRevisionId',
                      '=',
                      'messageRevisions.id'
                    ),
                '!=',
                '[]'
              )
              .orderBy('messageRevisions.createdAt', 'desc')
              .orderBy('messageRevisions.id', 'desc')
              .limit(1)
              .as('latestRevisionWithEmbeds'),
          ])
          .where('messages.id', '=', message.id)
          .execute(),
      {
        latestStateTables,
        scanning: ['message_revision_embeds'],
        reaches: [
          'USE TEMP B-TREE FOR json_group_array(ORDER BY)',
          latestRevisionStep,
        ],
      }
    )
  })

  it('lets a reader sort the rows it lists', async () => {
    await expectEveryPlan(
      () =>
        db()
          .selectFrom('messages')
          .innerJoin('messageRevisions as latestRevisions', (join) =>
            join.on((eb) =>
              eb(
                'latestRevisions.id',
                '=',
                eb
                  .selectFrom('messageRevisions')
                  .select('messageRevisions.id')
                  .whereRef('messageRevisions.messageId', '=', 'messages.id')
                  .orderBy('messageRevisions.createdAt', 'desc')
                  .orderBy('messageRevisions.id', 'desc')
                  .limit(1)
              )
            )
          )
          .select(['messages.id', 'latestRevisions.content'])
          .where('messages.channelId', '=', busyGuild.channelIds[0])
          .orderBy('latestRevisions.content')
          .execute(),
      {
        latestStateTables,
        scanning: [],
        reaches: [latestRevisionStep, 'USE TEMP B-TREE FOR ORDER BY'],
      }
    )
  })
})
