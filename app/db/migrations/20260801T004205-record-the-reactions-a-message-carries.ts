import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageReactionAdditions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('emoji', 'text', (col) => col.notNull())
    .addColumn('reactorDiscordUserId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageReactionAdditionsMessageIdCreatedAtIndex')
    .on('messageReactionAdditions')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('messageReactionRemovals')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('emoji', 'text', (col) => col.notNull())
    .addColumn('reactorDiscordUserId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('messageReactionRemovalsMessageIdCreatedAtIndex')
    .on('messageReactionRemovals')
    .columns(['messageId', 'createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageReactionRemovals').execute()
  await db.schema.dropTable('messageReactionAdditions').execute()
}
