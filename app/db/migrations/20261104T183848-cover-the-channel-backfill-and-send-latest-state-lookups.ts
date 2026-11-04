import type { Kysely } from 'kysely'

const widenedIndexes = [
  {
    table: 'backfillRuns',
    parent: 'channelId',
    widened: 'backfillRunsChannelIdCreatedAtIdIndex',
    replaced: 'backfillRunsChannelIdCreatedAtIndex',
  },
  {
    table: 'channelTopicChanges',
    parent: 'channelId',
    widened: 'channelTopicChangesChannelIdCreatedAtIdIndex',
    replaced: 'channelTopicChangesChannelIdCreatedAtIndex',
  },
  {
    table: 'channelTopicClearings',
    parent: 'channelId',
    widened: 'channelTopicClearingsChannelIdCreatedAtIdIndex',
    replaced: 'channelTopicClearingsChannelIdCreatedAtIndex',
  },
  {
    table: 'channelCategoryChanges',
    parent: 'channelId',
    widened: 'channelCategoryChangesChannelIdCreatedAtIdIndex',
    replaced: 'channelCategoryChangesChannelIdCreatedAtIndex',
  },
  {
    table: 'channelCategoryClearings',
    parent: 'channelId',
    widened: 'channelCategoryClearingsChannelIdCreatedAtIdIndex',
    replaced: 'channelCategoryClearingsChannelIdCreatedAtIndex',
  },
  {
    table: 'channelPositionChanges',
    parent: 'channelId',
    widened: 'channelPositionChangesChannelIdCreatedAtIdIndex',
    replaced: 'channelPositionChangesChannelIdCreatedAtIndex',
  },
  {
    table: 'channelPositionClearings',
    parent: 'channelId',
    widened: 'channelPositionClearingsChannelIdCreatedAtIdIndex',
    replaced: 'channelPositionClearingsChannelIdCreatedAtIndex',
  },
  {
    table: 'channelArchivings',
    parent: 'channelId',
    widened: 'channelArchivingsChannelIdCreatedAtIdIndex',
    replaced: 'channelArchivingsChannelIdCreatedAtIndex',
  },
  {
    table: 'channelUnarchivings',
    parent: 'channelId',
    widened: 'channelUnarchivingsChannelIdCreatedAtIdIndex',
    replaced: 'channelUnarchivingsChannelIdCreatedAtIndex',
  },
  {
    table: 'messageSendDeliveries',
    parent: 'messageSendRequestId',
    widened: 'messageSendDeliveriesRequestIdCreatedAtIdIndex',
    replaced: 'messageSendDeliveriesRequestIdCreatedAtIndex',
  },
  {
    table: 'messageSendFailures',
    parent: 'messageSendRequestId',
    widened: 'messageSendFailuresRequestIdCreatedAtIdIndex',
    replaced: 'messageSendFailuresRequestIdCreatedAtIndex',
  },
  {
    table: 'messageSendSkips',
    parent: 'messageSendRequestId',
    widened: 'messageSendSkipsRequestIdCreatedAtIdIndex',
    replaced: 'messageSendSkipsRequestIdCreatedAtIndex',
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
