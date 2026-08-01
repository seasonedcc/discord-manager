import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const messageFetchFailureKind = sql`kind in ('gone', 'rejected', 'unreachable')`
const messageFetchSkipReason = sql`reason in ('message_deleted')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageFetchRequests')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageFetchRequestsMessageIdCreatedAtIndex')
    .on('messageFetchRequests')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageFetchRetrievals')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageFetchRequestId', 'text', (col) =>
      col.notNull().references('messageFetchRequests.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageFetchRetrievalsRequestIdCreatedAtIndex')
    .on('messageFetchRetrievals')
    .columns(['messageFetchRequestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageFetchFailures')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageFetchRequestId', 'text', (col) =>
      col.notNull().references('messageFetchRequests.id')
    )
    .addColumn('kind', 'text', (col) =>
      col.notNull().check(messageFetchFailureKind)
    )
    .addColumn('errorMessage', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageFetchFailuresRequestIdCreatedAtIndex')
    .on('messageFetchFailures')
    .columns(['messageFetchRequestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageFetchSkips')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageFetchRequestId', 'text', (col) =>
      col.notNull().references('messageFetchRequests.id')
    )
    .addColumn('reason', 'text', (col) =>
      col.notNull().check(messageFetchSkipReason)
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageFetchSkipsRequestIdCreatedAtIndex')
    .on('messageFetchSkips')
    .columns(['messageFetchRequestId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageFetchSkips').execute()
  await db.schema.dropTable('messageFetchFailures').execute()
  await db.schema.dropTable('messageFetchRetrievals').execute()
  await db.schema.dropTable('messageFetchRequests').execute()
}
