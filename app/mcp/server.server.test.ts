import { registeredTools } from '~/mcp/registry.server'
import { callTool, listTools } from '~/mcp/server.server'
import { ownerContext } from '~/test/fixtures'
import { describe, expect, it } from '~/test/prelude'

describe('listTools', () => {
  it('lists every registered tool, whatever the deployment may call', () => {
    expect(listTools().map(({ name }) => name)).toEqual(
      registeredTools.map(({ name }) => name)
    )
  })

  it('tells the caller what each tool gets them', () => {
    const undescribed = listTools()
      .filter(({ description }) => (description ?? '').trim().length === 0)
      .map(({ name }) => name)

    expect(undescribed).toEqual([])
  })

  it('projects every input schema as a JSON object', () => {
    const misprojected = listTools()
      .filter(({ inputSchema }) => inputSchema.type !== 'object')
      .map(({ name }) => name)

    expect(misprojected).toEqual([])
  })

  it('projects instants as date-time strings a JSON caller can send', () => {
    const catchUp = listTools().find(({ name }) => name === 'messages_catch_up')

    expect(catchUp?.inputSchema).toMatchObject({
      type: 'object',
      properties: { since: { type: 'string', format: 'date-time' } },
      required: ['since'],
    })
  })
})

describe('callTool', () => {
  it('refuses a tool name it does not register', async () => {
    await expect(
      callTool(
        { name: 'bookmarks_delete', arguments: {} },
        await ownerContext()
      )
    ).rejects.toThrow('No tool named "bookmarks_delete" is registered')
  })
})
