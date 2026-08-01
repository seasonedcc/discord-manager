import { z } from 'zod'
import { registeredTools } from '~/mcp/registry.server'
import { describe, expect, it } from '~/test/prelude'

// A message declared on the schema outranks one handed to the parse call, so a
// field answering with this sentinel is a field carrying no message of its own.
const zodsOwnWording = 'zod would answer this one'

const wrongValues = [
  null,
  '',
  '   ',
  'not a timestamp',
  -1,
  0,
  1.5,
  1_000_000_000,
  true,
  [],
  {},
]

function fieldsSpeakingZod() {
  const speakingZod: string[] = []

  for (const { inputSchema, name } of registeredTools) {
    if (!(inputSchema instanceof z.ZodObject)) continue

    for (const [field, fieldSchema] of Object.entries(inputSchema.shape)) {
      const answered = wrongValues.flatMap((wrong) => {
        const parsed = z.safeParse(fieldSchema, wrong, {
          error: () => zodsOwnWording,
        })

        return parsed.success
          ? []
          : parsed.error.issues.map(({ message }) => message)
      })

      if (answered.includes(zodsOwnWording))
        speakingZod.push(`${name}.${field}`)
    }
  }

  return speakingZod
}

describe('the input fields registered tools expose', () => {
  it('reaches the fields it judges', () => {
    const fields = registeredTools.flatMap(({ inputSchema, name }) =>
      inputSchema instanceof z.ZodObject
        ? Object.keys(inputSchema.shape).map((field) => `${name}.${field}`)
        : []
    )

    expect(
      fields,
      'This guard read an empty field surface, so it would pass however the schemas were written. Registered tools take their input schemas from app/business/*.common.ts — teach this test the shape that replaced z.object()'
    ).toContain('messages_send.content')
  })

  it("answers a wrong value in the owner's words, never Zod's", () => {
    expect(
      fieldsSpeakingZod(),
      "These tool fields answer a wrong value with Zod's own wording, which names the type system's disappointment instead of the caller's next keystroke. Give each one a message in the owner's language that names the fix — on the type itself and on every check it carries, as app/business/activity.common.ts does"
    ).toEqual([])
  })
})
