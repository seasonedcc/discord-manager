import { registeredTools } from '~/mcp/registry.server'
import { excludedTools } from './exclusions'
import { pendingTools } from './pending'

const pendingRegistry = 'tests/coverage/pending.ts'
const exclusionRegistry = 'tests/coverage/exclusions.ts'

const callsPerTool = new Map<string, number>()

function recordToolCall(name: string) {
  callsPerTool.set(name, (callsPerTool.get(name) ?? 0) + 1)
}

function coverageProblems() {
  const registeredNames = registeredTools.map(({ name }) => name)
  const pendingNames = pendingTools.map(({ name }) => name)
  const excludedNames = excludedTools.map(({ name }) => name)
  const problems: string[] = []

  for (const name of registeredNames) {
    if (callsPerTool.has(name)) continue
    if (pendingNames.includes(name) || excludedNames.includes(name)) continue

    problems.push(
      `${name} is registered but no spec ever called it. Write a spec that reaches it, or park it in ${pendingRegistry} with a reason.`
    )
  }

  for (const { name } of pendingTools) {
    if (!registeredNames.includes(name)) {
      problems.push(
        `${name} is parked in ${pendingRegistry} but no tool by that name is registered. Drop the entry.`
      )
    }

    if (callsPerTool.has(name)) {
      problems.push(
        `${name} is parked in ${pendingRegistry} but the suite reached it. Remove the entry — pending only ever shrinks.`
      )
    }
  }

  for (const { name } of excludedTools) {
    if (!registeredNames.includes(name)) {
      problems.push(
        `${name} is excluded in ${exclusionRegistry} but no tool by that name is registered. Drop the entry.`
      )
    }

    if (pendingNames.includes(name)) {
      problems.push(
        `${name} is listed in both ${pendingRegistry} and ${exclusionRegistry}. It belongs in exactly one.`
      )
    }
  }

  return problems
}

function reportToolCoverage({ enforcing }: { enforcing: boolean }) {
  const problems = coverageProblems()
  const reached = registeredTools.filter(({ name }) => callsPerTool.has(name))

  console.log('\nTool coverage')

  for (const { name } of registeredTools) {
    const calls = callsPerTool.get(name)

    console.log(
      calls
        ? `  reached  ${name} (${calls} ${calls === 1 ? 'call' : 'calls'})`
        : `  MISSING  ${name}`
    )
  }

  console.log(
    `${reached.length} of ${registeredTools.length} registered tools reached by real traffic.`
  )

  if (pendingTools.length > 0) {
    console.log(`Pending in ${pendingRegistry}: ${pendingTools.length}`)
  }

  if (excludedTools.length > 0) {
    console.log(`Excluded in ${exclusionRegistry}: ${excludedTools.length}`)
  }

  for (const problem of problems) console.log(`  ${problem}`)

  if (problems.length === 0) return 0

  if (!enforcing) {
    console.log(
      'Reporting only: a filtered run cannot know what the whole suite would have reached.'
    )

    return 0
  }

  return problems.length
}

export { recordToolCall, reportToolCoverage }
