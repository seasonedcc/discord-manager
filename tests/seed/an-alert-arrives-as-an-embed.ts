import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function anAlertArrivesAsAnEmbed({
  channels,
  clock,
  members,
  owner,
}: {
  channels: Record<string, SeededChannel>
  clock: Clock
  members: Record<string, SeededMember>
  owner: SeededMember
}) {
  const engineering = requireSeeded(channels, 'engineering', 'channel')
  const uptime = requireSeeded(members, 'uptime', 'member')
  const raisedAt = clock.at(15)

  const message = await feed.postMessage({
    attachments: [
      {
        filename: 'checkout-errors.png',
        size: 20480,
        url: 'https://cdn.example.test/attachments/checkout-errors.png',
      },
    ],
    author: uptime,
    channel: engineering,
    content: '',
    discordCreatedAt: raisedAt,
    embeds: [
      {
        authorName: 'Uptime Watch',
        description: 'Checkout answered 502 five times in a row.',
        fields: [
          { name: 'Region', value: 'eu-west-1' },
          { name: 'Since', value: '4 minutes ago' },
        ],
        footerText: 'Acknowledge to stop the reminders',
        timestamp: raisedAt,
        title: 'Checkout is failing',
        url: 'https://status.example.test/incidents/412',
      },
    ],
    mentioning: [owner],
  })

  const text = [
    'Uptime Watch',
    'Checkout is failing (https://status.example.test/incidents/412)',
    'Checkout answered 502 five times in a row.',
    'Region: eu-west-1',
    'Since: 4 minutes ago',
    'Acknowledge to stop the reminders',
    raisedAt,
  ].join('\n')

  return { message, text }
}

export { anAlertArrivesAsAnEmbed }
