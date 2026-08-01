import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from '~/test/prelude'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)
const committedTypesPath = path.join(repositoryRoot, 'app', 'db', 'types.d.ts')

function generateTypes(configuredDatabasePath?: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'discord-manager-types-'))
  const outFile = path.join(workspace, 'types.d.ts')

  try {
    const finished = spawnSync(
      'pnpm',
      ['exec', 'tsx', './app/db/scripts/generate.ts', outFile],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: configuredDatabasePath
          ? { ...process.env, DATABASE_PATH: configuredDatabasePath }
          : process.env,
      }
    )

    expect(finished.status, finished.stderr || finished.error?.message).toBe(0)

    return readFileSync(outFile, 'utf8')
  } finally {
    rmSync(workspace, { force: true, recursive: true })
  }
}

function storeCarryingATableNoMigrationCreates() {
  const storePath = path.join(
    repositoryRoot,
    'tests',
    '.artifacts',
    'generate-test-other-branch.db'
  )

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${storePath}${suffix}`, { force: true })
  }

  const store = new Database(storePath)

  store.exec(
    'create table other_branch_notes (id text primary key not null, note text not null)'
  )
  store.close()

  return storePath
}

describe('db:generate', () => {
  it('rebuilds the committed types byte for byte from the migrations folder', () => {
    expect(
      generateTypes(),
      'app/db/types.d.ts no longer matches app/db/migrations. Run pnpm run db:generate and commit the result.'
    ).toBe(readFileSync(committedTypesPath, 'utf8'))
  })

  it('ignores whatever schema the configured DATABASE_PATH store carries', () => {
    const fromTheMigrations = generateTypes()
    const fromAStoreAheadOfThem = generateTypes(
      storeCarryingATableNoMigrationCreates()
    )

    expect(fromAStoreAheadOfThem).not.toContain('OtherBranchNotes')
    expect(fromAStoreAheadOfThem).toBe(fromTheMigrations)
  })
})
