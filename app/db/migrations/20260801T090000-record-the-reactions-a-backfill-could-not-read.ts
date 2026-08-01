import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('backfillRunUnreadReactions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('backfillRunId', 'text', (col) =>
      col.notNull().references('backfillRuns.id')
    )
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('backfillRunUnreadReactionsRunIdCreatedAtIndex')
    .on('backfillRunUnreadReactions')
    .columns(['backfillRunId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('backfillRunUnreadReactions').execute()
}
