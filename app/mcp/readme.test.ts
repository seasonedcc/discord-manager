import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registeredTools } from '~/mcp/registry.server'
import { describe, expect, it } from '~/test/prelude'

const repositoryRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
)

const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8')

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

const architectureDoc = readFileSync(
  path.join(repositoryRoot, 'docs', 'architecture.md'),
  'utf8'
)

const architectureToolList =
  architectureDoc
    .split(/^## MCP tools \(v1\)$/m)[1]
    ?.split(/\n\s*\n/)
    .find((paragraph) => paragraph.trim() !== '') ?? ''

const architectureToolNames = Array.from(
  architectureToolList.matchAll(/`([a-z][a-z0-9_]*)`/g),
  ([, name]) => name
)

describe("the architecture doc's tool list", () => {
  it('keeps its list where this guard reads it', () => {
    expect(
      architectureToolNames,
      'The first paragraph under "## MCP tools (v1)" in docs/architecture.md carries no backticked tool names, so this guard read an empty tool surface. Restore the list there — every tool name backticked, parameters in parentheses — or teach this test the shape that replaced it'
    ).not.toEqual([])
  })

  it('lists every tool the MCP server registers', () => {
    const unlisted = registeredToolNames.filter(
      (name) => !architectureToolNames.includes(name)
    )

    expect(
      unlisted,
      'The MCP server registers these tools and the architecture doc never lists them, so the design reference understates the shipped surface. Add each to the paragraph under "## MCP tools (v1)" in docs/architecture.md, backticked, with its notable parameters in parentheses'
    ).toEqual([])
  })

  it('lists no tool the MCP server has stopped registering', () => {
    const unregistered = architectureToolNames.filter(
      (name) => !registeredToolNames.includes(name)
    )

    expect(
      unregistered,
      'The architecture doc lists these tools, but the MCP server registers nothing by those names, so the design reference describes a surface that does not exist. Drop them from the paragraph under "## MCP tools (v1)" in docs/architecture.md — or correct the name there if a tool was renamed'
    ).toEqual([])
  })
})
