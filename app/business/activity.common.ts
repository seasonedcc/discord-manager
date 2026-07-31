import { z } from 'zod'

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const activitySinceSchema = z.object({
  since: z.iso
    .datetime({ error: isoInstantMessage, offset: true })
    .describe(
      "Count only what the store recorded strictly after this instant — its own arrival clock, not Discord's message timestamps. Pass back the largest newest timestamp from your previous answer to poll for changes. An ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)."
    ),
})

export { activitySinceSchema }
