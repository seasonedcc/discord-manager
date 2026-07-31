import type { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex('messagesCreatedAtIndex')
    .on('messages')
    .columns(['createdAt desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('messagesCreatedAtIndex').execute()
}
