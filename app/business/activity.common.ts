import { z } from 'zod'

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const activitySinceSchema = z.object({
  since: z.iso
    .datetime({ error: isoInstantMessage, offset: true })
    .describe(
      'Count only what happened strictly after this instant — the cutoff is exclusive. Pass back the newest timestamp you were last given and the answer stays at zero until something genuinely new arrives. An ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed).'
    ),
})

export { activitySinceSchema }
