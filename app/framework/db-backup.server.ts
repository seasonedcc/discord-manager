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

const appendStableChunkByteCap = 16 * 1024 * 1024
const schemaFileName = 'schema.sql'

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

function chunkFilesOf(dumpDirectory: string) {
  return readdirSync(dumpDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((table) =>
      readdirSync(path.join(dumpDirectory, table))
        .filter((file) => file.endsWith('.sql'))
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
      `${destination} holds something other than a dump — there is no ${schemaFileName} in it. An export replaces its whole destination, so point it at a new directory, an empty one, or a dump it may overwrite.`
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

      for (const values of statement.iterate()) {
        chunks.write(insertStatement(table, values))
        rows += 1
      }

      const written = chunks.finish()

      files += written.files
      largestChunkBytes = Math.max(largestChunkBytes, written.largestChunkBytes)
    }

    database.exec('COMMIT')
    mkdirSync(path.dirname(destination), { recursive: true })
    rmSync(destination, { force: true, recursive: true })
    renameSync(staging, destination)

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

  mkdirSync(path.dirname(storePath), { recursive: true })

  const database = new Database(storePath)

  try {
    database.pragma('foreign_keys = OFF')
    database.exec('BEGIN')
    database.exec(readFileSync(schemaFile, 'utf8'))

    for (const chunkFile of chunkFilesOf(source)) {
      try {
        database.exec(readFileSync(path.join(source, chunkFile), 'utf8'))
      } catch (error) {
        throw new Error(
          `${chunkFile} did not restore: ${error instanceof Error ? error.message : String(error)}. Nothing from the dump was kept, so the store at ${storePath} is NOT trustworthy — delete it, and restore again from a dump you trust.`
        )
      }
    }

    database.exec('COMMIT')

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

    return {
      databasePath: storePath,
      rows: tables.reduce((total, table) => total + table.rows, 0),
      tables,
    }
  } finally {
    database.close()
  }
}

export { appendStableChunkByteCap, exportDatabase, importDatabase }
