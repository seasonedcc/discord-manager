import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageSendRequestReplyTargets')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('requestId', 'text', (col) =>
      col.notNull().references('messageSendRequests.id')
    )
    .addColumn('replyToMessageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageSendRequestReplyTargetsRequestIdCreatedAtIndex')
    .on('messageSendRequestReplyTargets')
    .columns(['requestId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageSendRequestReplyTargets').execute()
}
