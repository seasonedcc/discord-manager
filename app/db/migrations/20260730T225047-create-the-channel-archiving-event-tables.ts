import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('channelArchivings')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelArchivingsChannelIdCreatedAtIndex')
    .on('channelArchivings')
    .columns(['channelId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('channelUnarchivings')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('channelUnarchivingsChannelIdCreatedAtIndex')
    .on('channelUnarchivings')
    .columns(['channelId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('channelUnarchivings').execute()
  await db.schema.dropTable('channelArchivings').execute()
}
