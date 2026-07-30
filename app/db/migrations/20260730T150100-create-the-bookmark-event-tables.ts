import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const bookmarkSource = sql`source in ('reaction', 'mcp')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('bookmarkAdditions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('source', 'text', (col) => col.notNull().check(bookmarkSource))
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkAdditionsMessageIdCreatedAtIndex')
    .on('bookmarkAdditions')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('bookmarkRemovals')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('source', 'text', (col) => col.notNull().check(bookmarkSource))
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkRemovalsMessageIdCreatedAtIndex')
    .on('bookmarkRemovals')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('bookmarkSnoozes')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('until', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkSnoozesMessageIdCreatedAtIndex')
    .on('bookmarkSnoozes')
    .columns(['messageId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('bookmarkSnoozes').execute()
  await db.schema.dropTable('bookmarkRemovals').execute()
  await db.schema.dropTable('bookmarkAdditions').execute()
}
