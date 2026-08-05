import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageReplyReferences')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('repliedToDiscordGuildId', 'text', (col) => col.notNull())
    .addColumn('repliedToDiscordChannelId', 'text', (col) => col.notNull())
    .addColumn('repliedToDiscordMessageId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .addUniqueConstraint('messageReplyReferencesMessageUnique', ['messageId'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageReplyReferences').execute()
}
