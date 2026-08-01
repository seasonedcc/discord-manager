import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registeredTools } from '~/mcp/registry.server'
import { describe, expect, it } from '~/test/prelude'

const readme = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'README.md'
  ),
  'utf8'
)

const documentedToolNames = readme
  .split('\n')
  .flatMap((line) => line.match(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/)?.[1] ?? [])

const registeredToolNames = registeredTools.map(({ name }) => name)

describe('the README tool table', () => {
  it('keeps its rows where this guard reads them', () => {
    expect(
      documentedToolNames,
      'No row in README.md carries a backticked tool name in its first column, so this guard read an empty tool surface. Restore the table under "## The tools" — | `tool_name` | what the owner gets | — or teach this test the shape that replaced it'
    ).not.toEqual([])
  })

  it('documents every tool the MCP server registers', () => {
    const undocumented = registeredToolNames.filter(
      (name) => !documentedToolNames.includes(name)
    )

    expect(
      undocumented,
      'The MCP server registers these tools and the README never mentions them, so a self-hosting owner has no way to learn they exist. Add a row for each to the table under "## The tools": the name backticked in the first column, what the owner gets from it in the second'
    ).toEqual([])
  })

  it('promises no tool the MCP server has stopped registering', () => {
    const unregistered = documentedToolNames.filter(
      (name) => !registeredToolNames.includes(name)
    )

    expect(
      unregistered,
      'The README tool table promises these tools, but the MCP server registers nothing by those names, so an owner asking for them gets an error. Drop their rows from the table under "## The tools" — or correct the name there if a tool was renamed'
    ).toEqual([])
  })
})
