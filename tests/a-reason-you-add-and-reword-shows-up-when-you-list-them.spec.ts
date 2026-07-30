import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openMcpSession } from './mcp-client'
import { test } from './spec'

type AddedReason = {
  reason: { description: string; name: string; reasonId: string }
}

type ReasonList = {
  reasons: {
    bookmarkCount: number
    description: string
    name: string
    reasonId: string
  }[]
}

test('a reason you add and reword shows up when you list them', async () => {
  const session = await openMcpSession()

  const name = `Delegate ${randomUUID()}`
  const renamed = `Hand off ${randomUUID()}`

  const added = await session.call<AddedReason>('bookmark_reasons_add', {
    name,
    description: 'Someone else should pick this up.',
  })

  assert.equal(added.reason.name, name)

  const afterAdding = await session.call<ReasonList>('bookmark_reasons_list')
  const listed = afterAdding.reasons.filter(
    ({ reasonId }) => reasonId === added.reason.reasonId
  )

  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, name)
  assert.equal(listed[0].description, 'Someone else should pick this up.')
  assert.equal(listed[0].bookmarkCount, 0)

  const edited = await session.call<AddedReason>('bookmark_reasons_edit', {
    reasonId: added.reason.reasonId,
    name: renamed,
    description: 'Route this to whoever owns the area.',
  })

  assert.equal(edited.reason.name, renamed)

  const afterEditing = await session.call<ReasonList>('bookmark_reasons_list')
  const reworded = afterEditing.reasons.filter(
    ({ reasonId }) => reasonId === added.reason.reasonId
  )

  assert.equal(reworded.length, 1)
  assert.equal(reworded[0].name, renamed)
  assert.equal(reworded[0].description, 'Route this to whoever owns the area.')

  const inbox = afterEditing.reasons.find(({ name }) => name === 'Inbox')

  assert.ok(inbox, 'the shipped Inbox reason is missing')

  const refusedEdit = await session.callExpectingRefusal(
    'bookmark_reasons_edit',
    {
      reasonId: inbox.reasonId,
      name: 'Unsorted',
      description: 'Anything at all.',
    }
  )

  assert.equal(
    refusedEdit.errors[0].message,
    'Inbox is where every unsorted bookmark lands, so its name and description belong to the product. Add a reason of your own instead.'
  )

  const refusedRetirement = await session.callExpectingRefusal(
    'bookmark_reasons_retire',
    { reasonId: inbox.reasonId }
  )

  assert.equal(
    refusedRetirement.errors[0].message,
    'Inbox is where every unsorted bookmark lands, so it cannot be retired. Retire a reason of your own instead.'
  )
})
