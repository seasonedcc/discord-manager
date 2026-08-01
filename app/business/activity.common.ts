import { z } from 'zod'

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'
const waitSecondsMessage = 'Wait a whole number of seconds, from 1 to 55'

const activitySinceSchema = z.object({
  since: z.iso
    .datetime({ error: isoInstantMessage, offset: true })
    .describe(
      "Count only what the store recorded strictly after this instant — its own arrival clock, not Discord's message timestamps. Pass back the largest newest timestamp from your previous answer to poll for changes. An ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)."
    ),
  waitSeconds: z
    .int({ error: waitSecondsMessage })
    .min(1, waitSecondsMessage)
    .max(55, waitSecondsMessage)
    .optional()
    .describe(
      'Hold the answer open for up to this many seconds — a long poll. It comes back within about a second of the store recording anything after `since`, and otherwise at the deadline, with the zero counts an immediate call would have given. Use it to keep a standing watch: one waiting call per loop notices a new message within seconds, where repeated immediate calls cost a turn per interval. Omit it to answer at once. Whole seconds, 1 to 55.'
    ),
})

export { activitySinceSchema }
