import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageSendRequestRetries')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('requestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('retriedRequestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendRequestRetriesRequestIdCreatedAtIndex')
    .on('messageSendRequestRetries')
    .columns(['requestId', 'createdAt desc'])
    .execute()

  await db.schema
    .createIndex('messageSendRequestRetriesRetriedRequestIdCreatedAtIndex')
    .on('messageSendRequestRetries')
    .columns(['retriedRequestId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageSendRequestRetries').execute()
}
