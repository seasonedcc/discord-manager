import type { Kysely } from 'kysely'

const widenedIndexes = [
  {
    table: 'messageRevisions',
    parent: 'messageId',
    widened: 'messageRevisionsMessageIdCreatedAtIdIndex',
    replaced: 'messageRevisionsMessageIdCreatedAtIndex',
  },
  {
    table: 'channelDetailRevisions',
    parent: 'channelId',
    widened: 'channelDetailRevisionsChannelIdCreatedAtIdIndex',
    replaced: 'channelDetailRevisionsChannelIdCreatedAtIndex',
  },
  {
    table: 'memberDetailRevisions',
    parent: 'memberId',
    widened: 'memberDetailRevisionsMemberIdCreatedAtIdIndex',
    replaced: 'memberDetailRevisionsMemberIdCreatedAtIndex',
  },
]

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex('messagesDiscordCreatedAtIndex')
    .on('messages')
    .columns(['discordCreatedAt desc'])
    .execute()

  await db.schema
    .createIndex('gatewayIdentificationsGuildIdCreatedAtIdIndex')
    .on('gatewayIdentifications')
    .columns(['guildId', 'createdAt desc', 'id desc'])
    .execute()

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

  await db.schema
    .dropIndex('gatewayIdentificationsGuildIdCreatedAtIdIndex')
    .execute()

  await db.schema.dropIndex('messagesDiscordCreatedAtIndex').execute()
}
