import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const permissionFetchReading = sql`reading in ('channel_access', 'roles')`
const permissionFetchFailureKind = sql`kind in ('owner_not_member', 'rejected', 'server_unknown', 'unreachable')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('permissionFetchRequests')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('reading', 'text', (col) =>
      col.notNull().check(permissionFetchReading)
    )
    .addColumn('discordGuildId', 'text', (col) => col.notNull())
    .addColumn('ownerDiscordUserId', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('permissionFetchRetrievals')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('permissionFetchRequestId', 'text', (col) =>
      col.notNull().references('permissionFetchRequests.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('permissionFetchFailures')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('permissionFetchRequestId', 'text', (col) =>
      col.notNull().references('permissionFetchRequests.id')
    )
    .addColumn('kind', 'text', (col) =>
      col.notNull().check(permissionFetchFailureKind)
    )
    .addColumn('errorMessage', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('permissionFetchFailures').execute()
  await db.schema.dropTable('permissionFetchRetrievals').execute()
  await db.schema.dropTable('permissionFetchRequests').execute()
}
