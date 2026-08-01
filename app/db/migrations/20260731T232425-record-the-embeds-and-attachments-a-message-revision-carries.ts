import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messageRevisionEmbeds')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageRevisionId', 'text', (col) =>
      col.notNull().references('messageRevisions.id')
    )
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .addUniqueConstraint('messageRevisionEmbedsRevisionAndPositionUnique', [
      'messageRevisionId',
      'position',
    ])
    .execute()

  await db.schema
    .createTable('messageRevisionAttachments')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageRevisionId', 'text', (col) =>
      col.notNull().references('messageRevisions.id')
    )
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('filename', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('url', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .addUniqueConstraint(
      'messageRevisionAttachmentsRevisionAndPositionUnique',
      ['messageRevisionId', 'position']
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messageRevisionAttachments').execute()
  await db.schema.dropTable('messageRevisionEmbeds').execute()
}
