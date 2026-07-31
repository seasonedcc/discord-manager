import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  appendStableChunkByteCap,
  exportDatabase,
  importDatabase,
} from '~/framework/db-backup.server'
import { describe, expect, it } from '~/test/prelude'

const repositoryRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
)
const artifactsFolder = path.join('tests', '.artifacts')

const eventStoreSchema = `create table events (
  id text primary key,
  payload text,
  amount real,
  attachment blob,
  sequence integer
);
create index events_sequence_index on events (sequence);
create table event_notes (
  id text primary key,
  event_id text not null references events (id),
  note text not null,
  created_at text not null
);
create index alphabetically_first_index on event_notes (created_at);`

type EventAttributes = {
  id: string
  payload?: string | null
  amount?: number | null
  attachment?: Buffer | null
  sequence?: number | bigint | null
}

type NoteAttributes = {
  id: string
  eventId: string
  note: string
  createdAt: string
}

function unitPath(label: string) {
  mkdirSync(artifactsFolder, { recursive: true })

  return path.join(artifactsFolder, `db-backup-${label}-unit-${randomUUID()}`)
}

function createEventStore(label: string) {
  const databasePath = `${unitPath(label)}.db`
  const database = new Database(databasePath)

  database.pragma('journal_mode = WAL')
  database.exec(eventStoreSchema)
  database.close()

  return databasePath
}

function appendEvents(databasePath: string, events: EventAttributes[]) {
  const database = new Database(databasePath)
  const insert = database.prepare(
    'insert into events (id, payload, amount, attachment, sequence) values (?, ?, ?, ?, ?)'
  )

  database.exec('BEGIN')

  for (const event of events) {
    insert.run(
      event.id,
      event.payload ?? null,
      event.amount ?? null,
      event.attachment ?? null,
      event.sequence ?? null
    )
  }

  database.exec('COMMIT')
  database.close()
}

function appendNotes(databasePath: string, notes: NoteAttributes[]) {
  const database = new Database(databasePath)
  const insert = database.prepare(
    'insert into event_notes (id, event_id, note, created_at) values (?, ?, ?, ?)'
  )

  database.exec('BEGIN')

  for (const note of notes) {
    insert.run(note.id, note.eventId, note.note, note.createdAt)
  }

  database.exec('COMMIT')
  database.close()
}

function paddedEvents(from: number, count: number, payloadWidth = 80) {
  return Array.from({ length: count }, (_, offset) => ({
    id: String(from + offset).padStart(9, '0'),
    payload: `payload-${from + offset}`.padEnd(payloadWidth, '.'),
  }))
}

function chunkNamesOf(dumpDirectory: string, table: string) {
  return readdirSync(path.join(dumpDirectory, table)).sort()
}

function manifestOf(dumpDirectory: string) {
  return JSON.parse(
    readFileSync(path.join(dumpDirectory, 'manifest.json'), 'utf8')
  ) as { rows: Record<string, number> }
}

function writeManifest(dumpDirectory: string, rows: Record<string, number>) {
  writeFileSync(
    path.join(dumpDirectory, 'manifest.json'),
    `${JSON.stringify({ rows }, null, 2)}\n`
  )
}

function readChunk(dumpDirectory: string, table: string, chunk: string) {
  return readFileSync(path.join(dumpDirectory, table, chunk), 'utf8')
}

function chunkSizesOf(dumpDirectory: string, table: string) {
  return chunkNamesOf(dumpDirectory, table).map(
    (chunk) => statSync(path.join(dumpDirectory, table, chunk)).size
  )
}

function digestOf(filePath: string) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function failureOf(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  throw new Error('Expected the call to throw, and it did not')
}

function tableRowCountsOf(databasePath: string) {
  const database = new Database(databasePath, { readonly: true })
  const tables = database
    .prepare<[], { name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
    )
    .all()
  const counts = tables.map((table) => ({
    name: table.name,
    rows: database
      .prepare<[], { rows: number }>(
        `select count(*) as rows from "${table.name}"`
      )
      .all()[0].rows,
  }))

  database.close()

  return counts
}

function latestNotesOf(databasePath: string) {
  const database = new Database(databasePath, { readonly: true })
  const latest = database
    .prepare<[], { eventId: string; note: string }>(
      `select event_id as eventId, note
       from (
         select event_id, note,
                row_number() over (partition by event_id order by created_at desc, id desc) as rank
         from event_notes
       )
       where rank = 1
       order by event_id`
    )
    .all()

  database.close()

  return latest
}

function runScript(
  script: string,
  databasePath: string,
  dumpDirectory: string
) {
  return spawnSync('pnpm', ['exec', 'tsx', script, dumpDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: databasePath },
  })
}

describe('exportDatabase', () => {
  it('writes every row as one insert statement in SQLite own literal forms', () => {
    const databasePath = createEventStore('literals')
    const dumpDirectory = unitPath('literals-dump')

    appendEvents(databasePath, [
      {
        id: '000001',
        payload: `it's a "quoted" line\nwith a newline and ünïcødé`,
        amount: 1.5,
        attachment: Buffer.from([0, 255, 16]),
        sequence: 9007199254740993n,
      },
      { id: '000002' },
      {
        id: '000003',
        payload: 'plain',
        amount: 2,
        attachment: Buffer.alloc(0),
        sequence: 42,
      },
    ])

    exportDatabase({ databasePath, dumpDirectory })

    expect(readChunk(dumpDirectory, 'events', '000000.sql')).toBe(
      `INSERT INTO events VALUES('000001','it''s a "quoted" line\nwith a newline and ünïcødé',1.5,X'00ff10',9007199254740993);\n` +
        `INSERT INTO events VALUES('000002',NULL,NULL,NULL,NULL);\n` +
        `INSERT INTO events VALUES('000003','plain',2.0,X'',42);\n`
    )
  })

  it('orders rows by the primary key of the table rather than by insert order', () => {
    const databasePath = createEventStore('ordering')
    const dumpDirectory = unitPath('ordering-dump')

    appendEvents(databasePath, [
      { id: '000003', payload: 'third' },
      { id: '000001', payload: 'first' },
      { id: '000002', payload: 'second' },
    ])

    exportDatabase({ databasePath, dumpDirectory })

    expect(readChunk(dumpDirectory, 'events', '000000.sql')).toBe(
      `INSERT INTO events VALUES('000001','first',NULL,NULL,NULL);\n` +
        `INSERT INTO events VALUES('000002','second',NULL,NULL,NULL);\n` +
        `INSERT INTO events VALUES('000003','third',NULL,NULL,NULL);\n`
    )
  })

  it('writes the schema with every index after the table it belongs to', () => {
    const databasePath = createEventStore('schema')
    const dumpDirectory = unitPath('schema-dump')

    appendEvents(databasePath, [{ id: '000001' }])
    exportDatabase({ databasePath, dumpDirectory })

    const schema = readFileSync(path.join(dumpDirectory, 'schema.sql'), 'utf8')

    expect(schema).toContain('CREATE TABLE events')
    expect(schema).toContain('CREATE TABLE event_notes')
    expect(schema).toContain('CREATE INDEX events_sequence_index')
    expect(
      schema.indexOf('CREATE INDEX alphabetically_first_index')
    ).toBeGreaterThan(schema.indexOf('CREATE TABLE event_notes'))
    expect(schema.endsWith(';\n')).toBe(true)
  })

  it('leaves a table with no rows out of the dump', () => {
    const databasePath = createEventStore('empty')
    const dumpDirectory = unitPath('empty-dump')

    appendEvents(databasePath, [{ id: '000001' }])
    exportDatabase({ databasePath, dumpDirectory })

    expect(existsSync(path.join(dumpDirectory, 'events'))).toBe(true)
    expect(existsSync(path.join(dumpDirectory, 'event_notes'))).toBe(false)
  })

  it('leaves the store it exports byte for byte untouched', () => {
    const databasePath = createEventStore('read-only')
    const dumpDirectory = unitPath('read-only-dump')

    appendEvents(databasePath, paddedEvents(0, 20))

    const before = digestOf(databasePath)

    exportDatabase({ databasePath, dumpDirectory })

    expect(digestOf(databasePath)).toBe(before)
  })

  it('says which database file it looked for when there is none', () => {
    const databasePath = `${unitPath('missing')}.db`
    const failure = failureOf(() =>
      exportDatabase({ databasePath, dumpDirectory: unitPath('missing-dump') })
    )

    expect(failure).toContain(path.resolve(databasePath))
    expect(failure).toContain('DATABASE_PATH')
  })

  it('removes a chunk directory left behind by a table the store no longer has', () => {
    const databasePath = createEventStore('replace')
    const dumpDirectory = unitPath('replace-dump')

    appendEvents(databasePath, paddedEvents(0, 40))
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 512 })

    const staleChunks = chunkNamesOf(dumpDirectory, 'events')
    const stale = path.join(dumpDirectory, 'events_that_no_longer_exist')

    mkdirSync(stale, { recursive: true })
    writeFileSync(
      path.join(stale, '000000.sql'),
      "INSERT INTO events_that_no_longer_exist VALUES('000001');\n"
    )
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 4096 })

    expect(existsSync(stale)).toBe(false)
    expect(chunkNamesOf(dumpDirectory, 'events').length).toBeLessThan(
      staleChunks.length
    )
  })

  it('replaces the artifacts it owns and leaves every other entry alone', () => {
    const databasePath = createEventStore('bystanders')
    const dumpDirectory = unitPath('bystanders-dump')

    appendEvents(databasePath, paddedEvents(0, 40))
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 512 })

    const repositoryConfig = path.join(dumpDirectory, '.git', 'config')
    const notes = path.join(dumpDirectory, 'NOTES.md')
    const emptyFolder = path.join(dumpDirectory, 'thoughts')

    mkdirSync(path.join(dumpDirectory, '.git'), { recursive: true })
    writeFileSync(
      repositoryConfig,
      '[remote "origin"]\n\turl = git@example.com:me/backup.git\n'
    )
    writeFileSync(notes, 'restored from tape on the third\n')
    mkdirSync(emptyFolder, { recursive: true })

    const configDigest = digestOf(repositoryConfig)
    const notesDigest = digestOf(notes)
    const chunksBefore = chunkNamesOf(dumpDirectory, 'events').length

    appendEvents(databasePath, paddedEvents(40, 40))
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 512 })

    expect(digestOf(repositoryConfig)).toBe(configDigest)
    expect(digestOf(notes)).toBe(notesDigest)
    expect(existsSync(emptyFolder)).toBe(true)
    expect(chunkNamesOf(dumpDirectory, 'events').length).toBeGreaterThan(
      chunksBefore
    )
    expect(manifestOf(dumpDirectory).rows.events).toBe(80)
  })

  it('refuses to replace a chunk directory that picked up a file it did not write', () => {
    const databasePath = createEventStore('intruder')
    const dumpDirectory = unitPath('intruder-dump')

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })

    const intruder = path.join(dumpDirectory, 'events', 'NOTES.md')

    writeFileSync(intruder, 'why is this in here\n')

    const intruderDigest = digestOf(intruder)
    const schemaDigest = digestOf(path.join(dumpDirectory, 'schema.sql'))
    const failure = failureOf(() =>
      exportDatabase({ databasePath, dumpDirectory })
    )

    expect(failure).toContain(path.join(dumpDirectory, 'events'))
    expect(failure).toContain('Move it aside')
    expect(digestOf(intruder)).toBe(intruderDigest)
    expect(digestOf(path.join(dumpDirectory, 'schema.sql'))).toBe(schemaDigest)
    expect(chunkNamesOf(dumpDirectory, 'events')).toContain('000000.sql')
  })

  it('writes a manifest of the exact row count of every table it saw', () => {
    const databasePath = createEventStore('manifest')
    const dumpDirectory = unitPath('manifest-dump')

    appendEvents(databasePath, paddedEvents(0, 7))
    appendNotes(
      databasePath,
      Array.from({ length: 3 }, (_, offset) => ({
        id: String(offset).padStart(9, '0'),
        eventId: String(offset).padStart(9, '0'),
        note: `note-${offset}`,
        createdAt: '2026-07-01T10:00:00.000Z',
      }))
    )
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 256 })

    expect(
      readFileSync(path.join(dumpDirectory, 'manifest.json'), 'utf8')
    ).toBe(`{\n  "rows": {\n    "event_notes": 3,\n    "events": 7\n  }\n}\n`)
    expect(
      Object.entries(manifestOf(dumpDirectory).rows).map(([name, rows]) => ({
        name,
        rows,
      }))
    ).toEqual(tableRowCountsOf(databasePath))
  })

  it('counts a table with no rows in the manifest rather than omitting it', () => {
    const databasePath = createEventStore('manifest-empty')
    const dumpDirectory = unitPath('manifest-empty-dump')

    appendEvents(databasePath, [{ id: '000001' }])
    exportDatabase({ databasePath, dumpDirectory })

    expect(manifestOf(dumpDirectory).rows).toEqual({
      event_notes: 0,
      events: 1,
    })
    expect(existsSync(path.join(dumpDirectory, 'event_notes'))).toBe(false)
  })

  it('refuses to replace a directory that holds something other than a dump', () => {
    const databasePath = createEventStore('bystander')
    const occupied = unitPath('bystander-directory')
    const bystander = path.join(occupied, 'something-precious.txt')
    const empty = unitPath('bystander-empty')

    appendEvents(databasePath, [{ id: '000001' }])
    mkdirSync(occupied, { recursive: true })
    writeFileSync(bystander, 'not a dump')

    const failure = failureOf(() =>
      exportDatabase({ databasePath, dumpDirectory: occupied })
    )

    expect(failure).toContain(path.resolve(occupied))
    expect(failure).toContain('schema.sql')
    expect(existsSync(bystander)).toBe(true)

    mkdirSync(empty, { recursive: true })
    exportDatabase({ databasePath, dumpDirectory: empty })

    expect(existsSync(path.join(empty, 'schema.sql'))).toBe(true)
  })

  it('keeps every chunk but the last of each table identical when events are appended', () => {
    const databasePath = createEventStore('stability')
    const before = unitPath('stability-before')
    const after = unitPath('stability-after')

    appendEvents(databasePath, paddedEvents(0, 400))
    exportDatabase({ databasePath, dumpDirectory: before, chunkByteCap: 2048 })

    appendEvents(databasePath, paddedEvents(400, 120))
    exportDatabase({ databasePath, dumpDirectory: after, chunkByteCap: 2048 })

    expect(readFileSync(path.join(after, 'schema.sql'))).toEqual(
      readFileSync(path.join(before, 'schema.sql'))
    )

    const chunks = chunkNamesOf(before, 'events')

    expect(chunks.length).toBeGreaterThan(3)

    for (const chunk of chunks.slice(0, -1)) {
      expect(readChunk(after, 'events', chunk)).toEqual(
        readChunk(before, 'events', chunk)
      )
    }

    const lastChunk = chunks[chunks.length - 1]

    expect(
      readChunk(after, 'events', lastChunk).startsWith(
        readChunk(before, 'events', lastChunk)
      )
    ).toBe(true)
    expect(chunkNamesOf(after, 'events').length).toBeGreaterThan(chunks.length)
    expect(manifestOf(before).rows.events).toBe(400)
    expect(manifestOf(after).rows.events).toBe(520)
  })

  it('closes a chunk as soon as it reaches the byte cap', () => {
    const databasePath = createEventStore('rollover')
    const dumpDirectory = unitPath('rollover-dump')

    appendEvents(databasePath, paddedEvents(0, 200))
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 1024 })

    const sizes = chunkSizesOf(dumpDirectory, 'events')
    const longestLine = Math.max(
      ...readChunk(dumpDirectory, 'events', '000000.sql')
        .split('\n')
        .map((line) => Buffer.byteLength(`${line}\n`))
    )

    expect(sizes.length).toBeGreaterThan(5)

    for (const size of sizes.slice(0, -1)) {
      expect(size).toBeGreaterThanOrEqual(1024)
      expect(size).toBeLessThan(1024 + longestLine)
    }
  })

  it('writes a row that is bigger than the cap into a chunk of its own', () => {
    const databasePath = createEventStore('oversized')
    const dumpDirectory = unitPath('oversized-dump')

    appendEvents(databasePath, paddedEvents(0, 5, 300))
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 64 })

    const chunks = chunkNamesOf(dumpDirectory, 'events')

    expect(chunks).toEqual([
      '000000.sql',
      '000001.sql',
      '000002.sql',
      '000003.sql',
      '000004.sql',
    ])

    for (const chunk of chunks) {
      expect(
        readChunk(dumpDirectory, 'events', chunk).split('\n')
      ).toHaveLength(2)
    }
  })

  it('rolls the shipped dump over at its frozen 16 MiB chunk cap', () => {
    expect(appendStableChunkByteCap).toBe(16777216)

    const databasePath = createEventStore('frozen-cap')
    const dumpDirectory = unitPath('frozen-cap-dump')
    const payload = 'x'.repeat(16 * 1024)

    appendEvents(
      databasePath,
      Array.from({ length: 1040 }, (_, offset) => ({
        id: String(offset).padStart(9, '0'),
        payload,
      }))
    )

    const dump = exportDatabase({ databasePath, dumpDirectory })
    const sizes = chunkSizesOf(dumpDirectory, 'events')

    expect(chunkNamesOf(dumpDirectory, 'events')).toEqual([
      '000000.sql',
      '000001.sql',
    ])
    expect(sizes[0]).toBeGreaterThanOrEqual(appendStableChunkByteCap)
    expect(sizes[0]).toBeLessThan(appendStableChunkByteCap + 17 * 1024)
    expect(dump.largestChunkBytes).toBe(sizes[0])

    rmSync(databasePath, { force: true })
    rmSync(dumpDirectory, { force: true, recursive: true })
  })
})

describe('importDatabase', () => {
  it('restores every row, and derived state reads the same on the restored store', () => {
    const databasePath = createEventStore('round-trip')
    const dumpDirectory = unitPath('round-trip-dump')
    const restoredPath = `${unitPath('round-trip-restored')}.db`

    appendEvents(databasePath, [
      { id: '000001', payload: 'first', amount: 0.25 },
      { id: '000002', payload: 'second', attachment: Buffer.from([1, 2, 3]) },
      { id: '000003', payload: 'third', sequence: 7 },
    ])
    appendNotes(databasePath, [
      {
        id: '000001',
        eventId: '000001',
        note: 'superseded',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
      {
        id: '000002',
        eventId: '000001',
        note: 'current',
        createdAt: '2026-07-02T10:00:00.000Z',
      },
      {
        id: '000003',
        eventId: '000002',
        note: 'only',
        createdAt: '2026-07-02T10:00:00.000Z',
      },
    ])

    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 128 })

    const restored = importDatabase({
      databasePath: restoredPath,
      dumpDirectory,
    })

    expect(restored.tables).toEqual([
      { name: 'event_notes', rows: 3 },
      { name: 'events', rows: 3 },
    ])
    expect(tableRowCountsOf(restoredPath)).toEqual(
      tableRowCountsOf(databasePath)
    )
    expect(latestNotesOf(restoredPath)).toEqual(latestNotesOf(databasePath))
    expect(latestNotesOf(restoredPath)).toContainEqual({
      eventId: '000001',
      note: 'current',
    })
  })

  it('refuses to restore over a store that already exists', () => {
    const databasePath = createEventStore('occupied')
    const dumpDirectory = unitPath('occupied-dump')

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })

    const before = digestOf(databasePath)
    const failure = failureOf(() =>
      importDatabase({ databasePath, dumpDirectory })
    )

    expect(failure).toContain(path.resolve(databasePath))
    expect(failure).toContain('already a database file')
    expect(digestOf(databasePath)).toBe(before)
  })

  it('says what is missing when the dump has no schema file', () => {
    const dumpDirectory = unitPath('schemaless-dump')

    mkdirSync(dumpDirectory, { recursive: true })

    const failure = failureOf(() =>
      importDatabase({
        databasePath: `${unitPath('schemaless-restored')}.db`,
        dumpDirectory,
      })
    )

    expect(failure).toContain(path.resolve(dumpDirectory))
    expect(failure).toContain('schema.sql')
  })

  it('fails on a truncated chunk and takes the half-written file with it', () => {
    const databasePath = createEventStore('truncated')
    const dumpDirectory = unitPath('truncated-dump')
    const restoredPath = `${unitPath('truncated-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 20))
    exportDatabase({ databasePath, dumpDirectory })

    const chunk = path.join(dumpDirectory, 'events', '000000.sql')

    writeFileSync(chunk, readFileSync(chunk, 'utf8').slice(0, 40))

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain(path.join('events', '000000.sql'))
    expect(failure).toContain('Nothing was restored')
    expect(existsSync(restoredPath)).toBe(false)
  })

  it('maps a schema that will not run, clears the file it made, and lets the next run through', () => {
    const databasePath = createEventStore('broken-schema')
    const dumpDirectory = unitPath('broken-schema-dump')
    const restoredPath = `${unitPath('broken-schema-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })

    const schemaFile = path.join(dumpDirectory, 'schema.sql')
    const schema = readFileSync(schemaFile, 'utf8')

    writeFileSync(schemaFile, 'CREATE TABLE events (;\n')

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain('schema.sql did not restore:')
    expect(failure).toContain('Nothing was restored')
    expect(failure).toContain(path.resolve(restoredPath))
    expect(existsSync(restoredPath)).toBe(false)

    writeFileSync(schemaFile, schema)

    const restored = importDatabase({
      databasePath: restoredPath,
      dumpDirectory,
    })

    expect(restored.tables).toEqual([
      { name: 'event_notes', rows: 0 },
      { name: 'events', rows: 5 },
    ])
  })

  it('fails when the dump lost the last chunk of a table nothing points at', () => {
    const databasePath = createEventStore('short-count')
    const dumpDirectory = unitPath('short-count-dump')
    const restoredPath = `${unitPath('short-count-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 30))
    appendNotes(
      databasePath,
      Array.from({ length: 30 }, (_, offset) => ({
        id: String(offset).padStart(9, '0'),
        eventId: String(offset).padStart(9, '0'),
        note: `note-${offset}`.padEnd(80, '.'),
        createdAt: '2026-07-01T10:00:00.000Z',
      }))
    )
    exportDatabase({ databasePath, dumpDirectory, chunkByteCap: 512 })

    const chunks = chunkNamesOf(dumpDirectory, 'event_notes')
    const lastChunk = chunks[chunks.length - 1]
    const lostRows = readChunk(dumpDirectory, 'event_notes', lastChunk)
      .trimEnd()
      .split('\n').length

    expect(chunks.length).toBeGreaterThan(1)
    rmSync(path.join(dumpDirectory, 'event_notes', lastChunk), { force: true })

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain(
      `event_notes should carry 30 rows and carries ${30 - lostRows}`
    )
    expect(failure).toContain('NOT trustworthy')
    expect(existsSync(restoredPath)).toBe(true)
  })

  it('fails when the manifest names a table the dump does not carry', () => {
    const databasePath = createEventStore('phantom')
    const dumpDirectory = unitPath('phantom-dump')
    const restoredPath = `${unitPath('phantom-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })
    writeManifest(dumpDirectory, {
      ...manifestOf(dumpDirectory).rows,
      chronicles: 5,
    })

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain(
      'chronicles should carry 5 rows and is not in the restored store at all'
    )
    expect(failure).toContain('NOT trustworthy')
  })

  it('says what is missing when the dump has no manifest', () => {
    const databasePath = createEventStore('manifestless')
    const dumpDirectory = unitPath('manifestless-dump')
    const restoredPath = `${unitPath('manifestless-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })
    rmSync(path.join(dumpDirectory, 'manifest.json'), { force: true })

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain(path.resolve(dumpDirectory))
    expect(failure).toContain('manifest.json')
    expect(existsSync(restoredPath)).toBe(false)
  })

  it('says the manifest is unreadable rather than passing a parser error through', () => {
    const databasePath = createEventStore('unreadable-manifest')
    const dumpDirectory = unitPath('unreadable-manifest-dump')
    const restoredPath = `${unitPath('unreadable-manifest-restored')}.db`

    appendEvents(databasePath, paddedEvents(0, 5))
    exportDatabase({ databasePath, dumpDirectory })
    writeFileSync(
      path.join(dumpDirectory, 'manifest.json'),
      'the counts are around here somewhere'
    )

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain('manifest.json')
    expect(failure).toContain('Export the store again')
    expect(failure).not.toContain('JSON')
    expect(existsSync(restoredPath)).toBe(false)
  })

  it('fails when the dump leaves a row pointing at a parent it does not carry', () => {
    const databasePath = createEventStore('orphaned')
    const dumpDirectory = unitPath('orphaned-dump')
    const restoredPath = `${unitPath('orphaned-restored')}.db`

    appendEvents(databasePath, [{ id: '000001', payload: 'parent' }])
    appendNotes(databasePath, [
      {
        id: '000001',
        eventId: '000001',
        note: 'child',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ])
    exportDatabase({ databasePath, dumpDirectory })
    rmSync(path.join(dumpDirectory, 'events'), { force: true, recursive: true })

    const failure = failureOf(() =>
      importDatabase({ databasePath: restoredPath, dumpDirectory })
    )

    expect(failure).toContain('event_notes')
    expect(failure).toContain('NOT trustworthy')
  })
})

describe('the db:export and db:import scripts', () => {
  it('exports a migrated store and restores it into a fresh one', () => {
    const databasePath = `${unitPath('cli')}.db`
    const dumpDirectory = unitPath('cli-dump')
    const restoredPath = `${unitPath('cli-restored')}.db`

    const migration = runScript(
      './app/db/scripts/migrate.ts',
      databasePath,
      dumpDirectory
    )

    expect(migration.status).toBe(0)
    expect(migration.stdout).toContain('was executed successfully')

    const exported = runScript(
      './app/db/scripts/export.ts',
      databasePath,
      dumpDirectory
    )

    expect(exported.status).toBe(0)
    expect(exported.stdout).toContain(dumpDirectory)
    expect(
      existsSync(path.join(dumpDirectory, 'kysely_migration', '000000.sql'))
    ).toBe(true)
    expect(manifestOf(dumpDirectory).rows.kysely_migration).toBeGreaterThan(0)

    const restored = runScript(
      './app/db/scripts/import.ts',
      restoredPath,
      dumpDirectory
    )

    expect(restored.status).toBe(0)
    expect(restored.stdout).toContain('pnpm run db:migrate')
    expect(tableRowCountsOf(restoredPath)).toEqual(
      tableRowCountsOf(databasePath)
    )

    const remigration = runScript(
      './app/db/scripts/migrate.ts',
      restoredPath,
      dumpDirectory
    )

    expect(remigration.status).toBe(0)
    expect(remigration.stdout).not.toContain('was executed successfully')

    const refusal = runScript(
      './app/db/scripts/import.ts',
      restoredPath,
      dumpDirectory
    )

    expect(refusal.status).toBe(1)
    expect(refusal.stderr).toContain('already a database file')
  }, 90000)
})
