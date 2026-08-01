import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { environmentSchema } from '~/env.server'
import { environmentSchema as frameworkEnvironmentSchema } from '~/framework/env.server'
import { describe, expect, it } from '~/test/prelude'

const exemptions = [
  {
    key: 'NODE_ENV',
    reason:
      'whatever starts Discord Manager sets NODE_ENV — the test runner, a process manager, a shell — so an owner never writes it into their own .env',
  },
]

const exampleLines = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.example'),
  'utf8'
).split('\n')

const uncommentedKeys = exampleLines.flatMap(
  (line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1] ?? []
)

const commentedOutKeys = exampleLines.flatMap(
  (line) => line.match(/^#\s*([A-Z][A-Z0-9_]*)=/)?.[1] ?? []
)

const documentedKeys = [...uncommentedKeys, ...commentedOutKeys]

const declaredFields = [
  ...Object.entries(environmentSchema.shape),
  ...Object.entries(frameworkEnvironmentSchema.shape),
]

const declaredKeys = [...new Set(declaredFields.map(([key]) => key))]

const requiredKeys = [
  ...new Set(
    declaredFields
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key)
  ),
]

const exemptedKeys = exemptions.map(({ key }) => key)

describe('.env.example', () => {
  it('documents every key the env schemas declare', () => {
    const undocumented = declaredKeys.filter(
      (key) => !documentedKeys.includes(key) && !exemptedKeys.includes(key)
    )

    expect(
      undocumented,
      'app/env.server.ts or app/framework/env.server.ts declares these keys and .env.example never names them, so an owner copying the example never learns to set them. Add each one with a comment saying what it is and where its value comes from — or, when the owner is never the one who sets it, add it to the exemptions in this test with the reason why'
    ).toEqual([])
  })

  it('names no key the env schemas would ignore', () => {
    const undeclared = documentedKeys.filter(
      (key) => !declaredKeys.includes(key) && !exemptedKeys.includes(key)
    )

    expect(
      undeclared,
      'These keys sit in .env.example but no env schema declares them, so an owner who fills one in changes nothing and has no way to find that out. Drop them from .env.example, or declare them in app/env.server.ts — and in app/framework/env.server.ts too when framework code reads them'
    ).toEqual([])
  })

  it('leaves every key the owner must fill in ready to fill in', () => {
    const notReadyToFillIn = requiredKeys.filter(
      (key) => !uncommentedKeys.includes(key)
    )

    expect(
      notReadyToFillIn,
      'Discord Manager refuses to start without these keys, so .env.example has to carry each as a live blank assignment — KEY= on its own line — rather than commented out, where copying the file to .env leaves the owner with a process that exits on startup'
    ).toEqual([])
  })

  it('carries no exemption that has stopped being true', () => {
    const stale = exemptions
      .filter(
        ({ key }) => documentedKeys.includes(key) === declaredKeys.includes(key)
      )
      .map(({ key, reason }) => `${key} — exempted because ${reason}`)

    expect(
      stale,
      'These exemptions no longer describe reality: each names a key that is now either in both .env.example and an env schema, so it needs no exemption, or in neither, so it is gone. Remove the entry from this test'
    ).toEqual([])
  })
})
