import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('gatewayIdentifications')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('guildId', 'text', (col) =>
      col.notNull().references('guilds.id')
    )
    .addColumn('botDiscordUserId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('gatewayIdentifications').execute()
}
