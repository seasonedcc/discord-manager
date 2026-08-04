import { z } from 'zod'

const memberQueryMessage =
  'Search for part of a name, such as maya or Fischer, or leave it out for everyone'

const listMembersSchema = z.object({
  query: z
    .string({ error: memberQueryMessage })
    .min(1, memberQueryMessage)
    .optional()
    .describe(
      'Bring back only the people whose current username or display name contains this text. Case is ignored, on accented letters as much as plain ones, and the text can sit anywhere in the name — `fisch` finds Maya Fischer, `DÊVID` finds Dêvid. Left out, everyone comes back.'
    ),
})

export { listMembersSchema }
