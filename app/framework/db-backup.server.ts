import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'

const appendStableChunkByteCap = 16 * 1024 * 1024
const schemaFileName = 'schema.sql'
const manifestFileName = 'manifest.json'
const chunkFileNamePattern = /^\d{6,}\.sql$/

const manifestSchema = z.object({
  rows: z.record(z.string(), z.number().int().nonnegative()),
})

type ExportOptions = {
  databasePath: string
  dumpDirectory: string
  chunkByteCap?: number
}

type ImportOptions = {
  databasePath: string
  dumpDirectory: string
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

function textLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function realLiteral(value: number) {
  if (Number.isNaN(value)) return 'NULL'
  if (value === Number.POSITIVE_INFINITY) return '9e999'
  if (value === Number.NEGATIVE_INFINITY) return '-9e999'

  const shortest = String(value)

  return /[.e]/.test(shortest) ? shortest : `${shortest}.0`
}

function sqlLiteral(value: unknown) {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return textLiteral(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return realLiteral(value)
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`

  throw new Error(`A ${typeof value} value has no SQLite literal form.`)
}

function insertStatement(table: string, values: unknown[]) {
  return `INSERT INTO ${table} VALUES(${values.map(sqlLiteral).join(',')});\n`
}

function chunkFileName(index: number) {
  return `${String(index).padStart(6, '0')}.sql`
}

function openTableChunks(directory: string, byteCap: number) {
  let descriptor: number | null = null
  let chunkIndex = 0
  let chunkBytes = 0
  let files = 0
  let largestChunkBytes = 0

  function closeChunk() {
    if (descriptor === null) return

    closeSync(descriptor)
    descriptor = null
    largestChunkBytes = Math.max(largestChunkBytes, chunkBytes)
    chunkBytes = 0
    chunkIndex += 1
  }

  function write(line: string) {
    if (descriptor === null) {
      mkdirSync(directory, { recursive: true })
      descriptor = openSync(
        path.join(directory, chunkFileName(chunkIndex)),
        'w'
      )
      files += 1
    }

    writeSync(descriptor, line)
    chunkBytes += Buffer.byteLength(line)

    if (chunkBytes >= byteCap) closeChunk()
  }

  function finish() {
    closeChunk()

    return { files, largestChunkBytes }
  }

  return { finish, write }
}

function tableNamesOf(database: Database.Database) {
  return database
    .prepare<[], { name: string }>(
      `select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`
    )
    .all()
    .map((table) => table.name)
}

function schemaOf(database: Database.Database) {
  return database
    .prepare<[], { sql: string }>(
      `select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 else 1 end, name`
    )
    .all()
    .map((statement) => `${statement.sql};\n`)
    .join('')
}

function primaryKeyOrderOf(database: Database.Database, table: string) {
  const columns = database.pragma(`table_info(${quoteIdentifier(table)})`) as {
    name: string
    pk: number
  }[]
  const keyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((first, second) => first.pk - second.pk)

  if (keyColumns.length === 0) return 'rowid'

  return keyColumns.map((column) => quoteIdentifier(column.name)).join(', ')
}

function rowCountsOf(database: Database.Database) {
  return tableNamesOf(database).map((name) => ({
    name,
    rows: database
      .prepare<[], { rows: number }>(
        `select count(*) as rows from ${quoteIdentifier(name)}`
      )
      .all()[0].rows,
  }))
}

function chunkFilesOf(dumpDirectory: string, tables: string[]) {
  return tables
    .filter((table) => existsSync(path.join(dumpDirectory, table)))
    .sort()
    .flatMap((table) =>
      readdirSync(path.join(dumpDirectory, table))
        .filter((file) => chunkFileNamePattern.test(file))
        .sort()
        .map((file) => path.join(table, file))
    )
}

function holdsSomethingOtherThanADump(destination: string) {
  if (!existsSync(destination)) return false
  if (!statSync(destination).isDirectory()) return true
  if (existsSync(path.join(destination, schemaFileName))) return false

  return readdirSync(destination).length > 0
}

function isChunkDirectory(directory: string) {
  const entries = readdirSync(directory, { withFileTypes: true })

  return (
    entries.length > 0 &&
    entries.every(
      (entry) => entry.isFile() && chunkFileNamePattern.test(entry.name)
    )
  )
}

function ownedChunkDirectoriesOf(destination: string) {
  return readdirSync(destination, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        isChunkDirectory(path.join(destination, entry.name))
    )
    .map((entry) => entry.name)
}

function swapDumpIn(staging: string, destination: string) {
  mkdirSync(destination, { recursive: true })

  const owned = new Set(ownedChunkDirectoriesOf(destination))
  const arriving = readdirSync(staging).filter(
    (entry) => entry !== schemaFileName && entry !== manifestFileName
  )

  for (const table of arriving) {
    if (existsSync(path.join(destination, table)) && !owned.has(table)) {
      throw new Error(
        `${path.join(destination, table)} is not a chunk directory this export wrote, and the dump has a ${table} table to put there. Move it aside — or point the export at another directory — and run it again.`
      )
    }
  }

  rmSync(path.join(destination, schemaFileName), { force: true })
  rmSync(path.join(destination, manifestFileName), { force: true })

  for (const table of owned) {
    rmSync(path.join(destination, table), { force: true, recursive: true })
  }

  for (const table of arriving) {
    renameSync(path.join(staging, table), path.join(destination, table))
  }

  renameSync(
    path.join(staging, manifestFileName),
    path.join(destination, manifestFileName)
  )
  renameSync(
    path.join(staging, schemaFileName),
    path.join(destination, schemaFileName)
  )
  rmSync(staging, { force: true, recursive: true })
}

function manifestFor(rowsByTable: Record<string, number>) {
  const rows = Object.fromEntries(
    Object.keys(rowsByTable)
      .sort()
      .map((table) => [table, rowsByTable[table]])
  )

  return `${JSON.stringify({ rows }, null, 2)}\n`
}

function readParsedJson(text: string) {
  try {
    const parsed: unknown = JSON.parse(text)

    return parsed
  } catch {
    return undefined
  }
}

function manifestRowsOf(source: string) {
  const manifestFile = path.join(source, manifestFileName)

  if (!existsSync(manifestFile)) {
    throw new Error(
      `The dump at ${source} carries no ${manifestFileName}, so nothing says how many rows it should restore. Export the store again to write a dump this can verify.`
    )
  }

  const manifest = manifestSchema.safeParse(
    readParsedJson(readFileSync(manifestFile, 'utf8'))
  )

  if (!manifest.success) {
    throw new Error(
      `The ${manifestFileName} in ${source} is not a row count per table, so it cannot say what a restore should hold. Export the store again to write a dump this can verify.`
    )
  }

  return new Map(Object.entries(manifest.data.rows))
}

function firstCountDivergence(
  expected: Map<string, number>,
  restored: { name: string; rows: number }[]
) {
  const restoredRows = new Map(
    restored.map((table) => [table.name, table.rows])
  )
  const tables = [
    ...new Set([...expected.keys(), ...restoredRows.keys()]),
  ].sort()

  for (const table of tables) {
    const shouldCarry = expected.get(table)
    const carries = restoredRows.get(table)

    if (shouldCarry === undefined) {
      return `${table} carries ${carries} rows the dump does not account for`
    }

    if (carries === undefined) {
      return `${table} should carry ${shouldCarry} rows and is not in the restored store at all`
    }

    if (shouldCarry !== carries) {
      return `${table} should carry ${shouldCarry} rows and carries ${carries}`
    }
  }

  return undefined
}

function nothingRestored(artifact: string, error: unknown, storePath: string) {
  return new Error(
    `${artifact} did not restore: ${error instanceof Error ? error.message : String(error)}. Nothing was restored and no file was left at ${storePath}, so fix the dump and run this again.`
  )
}

function removeStoreFiles(storePath: string) {
  rmSync(storePath, { force: true })
  rmSync(`${storePath}-wal`, { force: true })
  rmSync(`${storePath}-shm`, { force: true })
}

function exportDatabase({
  databasePath,
  dumpDirectory,
  chunkByteCap = appendStableChunkByteCap,
}: ExportOptions) {
  const storePath = path.resolve(databasePath)

  if (!existsSync(storePath)) {
    throw new Error(
      `There is no database file at ${storePath}. Point DATABASE_PATH at the store you want to export.`
    )
  }

  const destination = path.resolve(dumpDirectory)

  if (holdsSomethingOtherThanADump(destination)) {
    throw new Error(
      `${destination} holds something other than a dump — there is no ${schemaFileName} in it. An export only ever replaces the artifacts it wrote, and it recognises none of its own here, so point it at a new directory, an empty one, or a dump it may overwrite.`
    )
  }

  const staging = `${destination}.partial-${randomUUID()}`
  const database = new Database(storePath, {
    fileMustExist: true,
    readonly: true,
  })

  try {
    database.exec('BEGIN')
    mkdirSync(staging, { recursive: true })
    writeFileSync(path.join(staging, schemaFileName), schemaOf(database))

    const tables = tableNamesOf(database)
    const rowsByTable: Record<string, number> = {}
    let rows = 0
    let files = 0
    let largestChunkBytes = 0

    for (const table of tables) {
      const chunks = openTableChunks(path.join(staging, table), chunkByteCap)
      const statement = database
        .prepare<[], unknown[]>(
          `select * from ${quoteIdentifier(table)} order by ${primaryKeyOrderOf(database, table)}`
        )
        .raw(true)
        .safeIntegers(true)
      let tableRows = 0

      for (const values of statement.iterate()) {
        chunks.write(insertStatement(table, values))
        tableRows += 1
      }

      const written = chunks.finish()

      rowsByTable[table] = tableRows
      rows += tableRows
      files += written.files
      largestChunkBytes = Math.max(largestChunkBytes, written.largestChunkBytes)
    }

    writeFileSync(
      path.join(staging, manifestFileName),
      manifestFor(rowsByTable)
    )
    database.exec('COMMIT')
    swapDumpIn(staging, destination)

    return {
      dumpDirectory: destination,
      files,
      largestChunkBytes,
      rows,
      tables: tables.length,
    }
  } catch (error) {
    rmSync(staging, { force: true, recursive: true })
    throw error
  } finally {
    database.close()
  }
}

function importDatabase({ databasePath, dumpDirectory }: ImportOptions) {
  const storePath = path.resolve(databasePath)
  const source = path.resolve(dumpDirectory)
  const schemaFile = path.join(source, schemaFileName)

  if (existsSync(storePath)) {
    throw new Error(
      `There is already a database file at ${storePath}. A restore only ever writes a fresh file, so move that one aside — or point DATABASE_PATH elsewhere — and run this again.`
    )
  }

  if (!existsSync(schemaFile)) {
    throw new Error(
      `There is no dump to restore at ${source}: it carries no ${schemaFileName}. Pass the dump directory as the first argument.`
    )
  }

  const manifestRows = manifestRowsOf(source)

  mkdirSync(path.dirname(storePath), { recursive: true })

  const database = new Database(storePath)
  let committed = false

  try {
    database.pragma('foreign_keys = OFF')
    database.exec('BEGIN')

    try {
      database.exec(readFileSync(schemaFile, 'utf8'))
    } catch (error) {
      throw nothingRestored(schemaFileName, error, storePath)
    }

    for (const chunkFile of chunkFilesOf(source, [...manifestRows.keys()])) {
      try {
        database.exec(readFileSync(path.join(source, chunkFile), 'utf8'))
      } catch (error) {
        throw nothingRestored(chunkFile, error, storePath)
      }
    }

    database.exec('COMMIT')
    committed = true

    const integrityFailures = (
      database.pragma('integrity_check') as { integrity_check: string }[]
    ).filter((row) => row.integrity_check !== 'ok')

    if (integrityFailures.length > 0) {
      throw new Error(
        `The restored store at ${storePath} failed SQLite's integrity check: ${integrityFailures.map((row) => row.integrity_check).join('; ')}. It is NOT trustworthy — delete it, and restore again from a dump you trust.`
      )
    }

    const orphans = database.pragma('foreign_key_check') as {
      table: string
      parent: string
    }[]

    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} restored rows point at parents the dump does not carry — the first is in ${orphans[0].table}, pointing at ${orphans[0].parent}. The store at ${storePath} is NOT trustworthy — delete it, and restore again from a complete dump.`
      )
    }

    const tables = rowCountsOf(database)
    const divergence = firstCountDivergence(manifestRows, tables)

    if (divergence) {
      throw new Error(
        `The restore does not match what ${manifestFileName} says the dump holds: ${divergence}. The store at ${storePath} is NOT trustworthy — delete it, and restore again from a complete dump.`
      )
    }

    return {
      databasePath: storePath,
      rows: tables.reduce((total, table) => total + table.rows, 0),
      tables,
    }
  } catch (error) {
    if (!committed) {
      database.close()
      removeStoreFiles(storePath)
    }

    throw error
  } finally {
    database.close()
  }
}

export { appendStableChunkByteCap, exportDatabase, importDatabase }
