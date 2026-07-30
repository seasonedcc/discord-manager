import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parityExemptions } from '~/mcp/parity-exemptions'
import { registeredTools } from '~/mcp/registry.server'
import { describe, expect, it } from '~/test/prelude'

const businessFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'business'
)

function isOwnerFacingSurface(value: unknown) {
  if (typeof value === 'function') return true

  return (
    typeof value === 'object' &&
    value !== null &&
    'jobName' in value &&
    typeof (value as { run?: unknown }).run === 'function'
  )
}

async function readBusinessSurface() {
  const files = readdirSync(businessFolder)
    .filter((file) => file.endsWith('.server.ts'))
    .sort()
  const surface: string[] = []

  for (const file of files) {
    const module: Record<string, unknown> = await import(
      pathToFileURL(path.join(businessFolder, file)).href
    )

    for (const [exportName, value] of Object.entries(module)) {
      if (!isOwnerFacingSurface(value)) continue

      surface.push(`${file.replace('.server.ts', '')}.${exportName}`)
    }
  }

  return surface.sort()
}

const businessSurface = await readBusinessSurface()
const exempted = parityExemptions.map(({ functionName }) => functionName)
const wrapped = registeredTools.flatMap(({ wraps }) => wraps)

describe('the MCP tool surface', () => {
  it('wraps or exempts every function the business layer exports', () => {
    const unaccounted = businessSurface.filter(
      (name) => !wrapped.includes(name) && !exempted.includes(name)
    )

    expect(unaccounted).toEqual([])
  })

  it('never wraps a function it also exempts', () => {
    const both = businessSurface.filter(
      (name) => wrapped.includes(name) && exempted.includes(name)
    )

    expect(both).toEqual([])
  })

  it('wraps only functions the business layer still exports', () => {
    const dangling = wrapped.filter((name) => !businessSurface.includes(name))

    expect(dangling).toEqual([])
  })

  it('exempts only functions the business layer still exports', () => {
    const stale = exempted.filter((name) => !businessSurface.includes(name))

    expect(stale).toEqual([])
  })

  it('says why each exemption is not an owner capability', () => {
    const unexplained = parityExemptions
      .filter(({ reason }) => reason.trim().length === 0)
      .map(({ functionName }) => functionName)

    expect(unexplained).toEqual([])
  })

  it('registers each tool name once', () => {
    const names = registeredTools.map(({ name }) => name)

    expect(names).toEqual([...new Set(names)])
  })

  it('gives every registered tool a business function to wrap', () => {
    const wrappingNothing = registeredTools
      .filter(({ wraps }) => wraps.length === 0)
      .map(({ name }) => name)

    expect(wrappingNothing).toEqual([])
  })
})
