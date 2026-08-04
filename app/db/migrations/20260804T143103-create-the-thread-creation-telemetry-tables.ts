import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const threadCreationFailureKind = sql`kind in ('gone', 'rejected', 'thread_already_exists', 'unreachable')`
const threadCreationSkipReason = sql`reason in ('anchor_message_deleted', 'channel_is_a_thread', 'channel_not_found', 'channel_not_in_guild', 'thread_already_exists')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('threadCreationRequests')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('threadCreationRequestAnchors')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('threadCreationRequestId', 'text', (col) =>
      col.notNull().references('threadCreationRequests.id')
    )
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('threadCreations')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('threadCreationRequestId', 'text', (col) =>
      col.notNull().references('threadCreationRequests.id')
    )
    .addColumn('channelId', 'text', (col) =>
      col.notNull().references('channels.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('threadCreationFailures')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('threadCreationRequestId', 'text', (col) =>
      col.notNull().references('threadCreationRequests.id')
    )
    .addColumn('kind', 'text', (col) =>
      col.notNull().check(threadCreationFailureKind)
    )
    .addColumn('errorMessage', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('threadCreationSkips')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('threadCreationRequestId', 'text', (col) =>
      col.notNull().references('threadCreationRequests.id')
    )
    .addColumn('reason', 'text', (col) =>
      col.notNull().check(threadCreationSkipReason)
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('threadCreationSkips').execute()
  await db.schema.dropTable('threadCreationFailures').execute()
  await db.schema.dropTable('threadCreations').execute()
  await db.schema.dropTable('threadCreationRequestAnchors').execute()
  await db.schema.dropTable('threadCreationRequests').execute()
}
