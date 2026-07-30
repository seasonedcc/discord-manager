import { inboxBookmarkReasonId } from '~/business/bookmarks.common'
import { db, describe, expect, it } from '~/test/prelude'

describe('the seeded default bookmark reasons', () => {
  it('pins inboxBookmarkReasonId to the Inbox reason a fresh store was migrated with', async () => {
    const reason = await db()
      .selectFrom('bookmarkReasons')
      .innerJoin(
        'bookmarkReasonDetailRevisions',
        'bookmarkReasonDetailRevisions.reasonId',
        'bookmarkReasons.id'
      )
      .select(['bookmarkReasons.id', 'name', 'description'])
      .where('bookmarkReasons.id', '=', inboxBookmarkReasonId)
      .execute()

    expect(reason).toEqual([
      {
        id: inboxBookmarkReasonId,
        name: 'Inbox',
        description: 'Where a bookmark lands until it is sorted into a reason.',
      },
    ])
  })

  it('ships the six reasons every deployment starts with', async () => {
    const reasons = await db()
      .selectFrom('bookmarkReasonDetailRevisions')
      .select('name')
      .execute()

    expect(reasons.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'Answer later',
        'To-do',
        'Follow up',
        'Read later',
        'Reference',
        'Inbox',
      ])
    )
  })
})
