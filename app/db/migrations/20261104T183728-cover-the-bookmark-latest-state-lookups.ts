import type { Kysely } from 'kysely'

const widenedIndexes = [
  {
    table: 'bookmarkAdditions',
    parent: 'messageId',
    widened: 'bookmarkAdditionsMessageIdCreatedAtIdIndex',
    replaced: 'bookmarkAdditionsMessageIdCreatedAtIndex',
  },
  {
    table: 'bookmarkRemovals',
    parent: 'messageId',
    widened: 'bookmarkRemovalsMessageIdCreatedAtIdIndex',
    replaced: 'bookmarkRemovalsMessageIdCreatedAtIndex',
  },
  {
    table: 'bookmarkSnoozes',
    parent: 'messageId',
    widened: 'bookmarkSnoozesMessageIdCreatedAtIdIndex',
    replaced: 'bookmarkSnoozesMessageIdCreatedAtIndex',
  },
  {
    table: 'bookmarkReasonAssignments',
    parent: 'messageId',
    widened: 'bookmarkReasonAssignmentsMessageIdCreatedAtIdIndex',
    replaced: 'bookmarkReasonAssignmentsMessageIdCreatedAtIndex',
  },
  {
    table: 'bookmarkReasonDetailRevisions',
    parent: 'reasonId',
    widened: 'bookmarkReasonDetailRevisionsReasonIdCreatedAtIdIndex',
    replaced: 'bookmarkReasonDetailRevisionsReasonIdCreatedAtIndex',
  },
]

export async function up(db: Kysely<any>): Promise<void> {
  for (const { table, parent, widened, replaced } of widenedIndexes) {
    await db.schema
      .createIndex(widened)
      .on(table)
      .columns([parent, 'createdAt desc', 'id desc'])
      .execute()
    await db.schema.dropIndex(replaced).execute()
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const { table, parent, widened, replaced } of widenedIndexes) {
    await db.schema
      .createIndex(replaced)
      .on(table)
      .columns([parent, 'createdAt desc'])
      .execute()
    await db.schema.dropIndex(widened).execute()
  }
}
