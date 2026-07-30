import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

const defaultReasons = [
  {
    id: '019fb556-c240-7000-a918-24f9d83810fc',
    revisionId: '019fb556-c240-7001-803e-0d8210a5c05f',
    name: 'Answer later',
    description: "A message that's waiting on a reply from you.",
  },
  {
    id: '019fb556-c240-7002-9f26-a4dbfc59176c',
    revisionId: '019fb556-c240-7003-bc97-0d3a177e8b8e',
    name: 'To-do',
    description: "Something you've committed to doing.",
  },
  {
    id: '019fb556-c240-7004-9721-b4b2ce314e1e',
    revisionId: '019fb556-c240-7005-8cb5-88d75fd11663',
    name: 'Follow up',
    description: "You're waiting on someone else — check back on it.",
  },
  {
    id: '019fb556-c240-7006-afe2-d03dd5edf4c1',
    revisionId: '019fb556-c240-7007-b133-9682228add53',
    name: 'Read later',
    description: "Longer content to come back to when there's time.",
  },
  {
    id: '019fb556-c240-7008-9ee6-98138d45d639',
    revisionId: '019fb556-c241-7000-83f0-e60f45695543',
    name: 'Reference',
    description:
      "Worth keeping findable — docs, decisions, links you'll look up again.",
  },
  {
    id: '019fb556-c241-7001-b011-99f205b9fa06',
    revisionId: '019fb556-c241-7002-9d51-e544217113ac',
    name: 'Inbox',
    description: 'Where a bookmark lands until it is sorted into a reason.',
  },
]

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('bookmarkReasons')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createTable('bookmarkReasonDetailRevisions')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('reasonId', 'text', (col) =>
      col.notNull().references('bookmarkReasons.id')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkReasonDetailRevisionsReasonIdCreatedAtIndex')
    .on('bookmarkReasonDetailRevisions')
    .columns(['reasonId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('bookmarkReasonRetirements')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('reasonId', 'text', (col) =>
      col.notNull().references('bookmarkReasons.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkReasonRetirementsReasonIdCreatedAtIndex')
    .on('bookmarkReasonRetirements')
    .columns(['reasonId', 'createdAt desc'])
    .execute()

  await db.schema
    .createTable('bookmarkReasonAssignments')
    .addColumn('id', 'text', (col) => col.primaryKey().notNull())
    .addColumn('messageId', 'text', (col) =>
      col.notNull().references('messages.id')
    )
    .addColumn('reasonId', 'text', (col) =>
      col.notNull().references('bookmarkReasons.id')
    )
    .addColumn('createdAt', 'text', (col) => col.notNull().defaultTo(nowIso))
    .execute()

  await db.schema
    .createIndex('bookmarkReasonAssignmentsMessageIdCreatedAtIndex')
    .on('bookmarkReasonAssignments')
    .columns(['messageId', 'createdAt desc'])
    .execute()

  await db
    .insertInto('bookmarkReasons')
    .values(defaultReasons.map(({ id }) => ({ id })))
    .execute()

  await db
    .insertInto('bookmarkReasonDetailRevisions')
    .values(
      defaultReasons.map(({ id, revisionId, name, description }) => ({
        id: revisionId,
        reasonId: id,
        name,
        description,
      }))
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('bookmarkReasonAssignments').execute()
  await db.schema.dropTable('bookmarkReasonRetirements').execute()
  await db.schema.dropTable('bookmarkReasonDetailRevisions').execute()
  await db.schema.dropTable('bookmarkReasons').execute()
}
