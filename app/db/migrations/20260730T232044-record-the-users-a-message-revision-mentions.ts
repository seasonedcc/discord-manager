import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageRevisionUserMentions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageRevisionId', 'text', (col) =>
      col.notNull().references('messageRevisions.id')
    )
    .addColumn('mentionedDiscordUserId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .addUniqueConstraint('messageRevisionUserMentionsRevisionAndUserUnique', [
      'messageRevisionId',
      'mentionedDiscordUserId',
    ])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageRevisionUserMentions').execute()
}
