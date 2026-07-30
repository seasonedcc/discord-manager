import { newId } from '~/framework/db.server'
import { describe, expect, it } from '~/test/prelude'

describe('newId', () => {
  it('issues ids that sort in the order they were issued, even within one millisecond', () => {
    const ids = Array.from({ length: 10000 }, () => newId())

    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('issues well-formed version 7 uuids', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})
