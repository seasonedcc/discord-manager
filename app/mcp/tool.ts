import type { Result } from 'composable-functions'
import type { z } from 'zod'

type McpTool = {
  name: string
  description: string
  inputSchema: z.ZodType
  wraps: string[]
  execute: (input: unknown, context: unknown) => Promise<Result<unknown>>
}

export type { McpTool }
