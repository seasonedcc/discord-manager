import { describe, expect, it } from '~/test/prelude'
import type {
  MessageFetchFailureKind,
  MessageFetchSkipReason,
} from './messages.common'
import {
  messageFetchFailureCopy,
  messageFetchGuidance,
  messageFetchRetrievalCopy,
  messageFetchSkipCopy,
  renderEmbed,
} from './messages.common'

const everyFailureKind = [
  'gone',
  'rejected',
  'unreachable',
] satisfies MessageFetchFailureKind[]

const everySkipReason = ['message_deleted'] satisfies MessageFetchSkipReason[]

describe('renderEmbed', () => {
  it('reads the embed in the order Discord shows it', () => {
    expect(
      renderEmbed({
        authorName: 'Uptime watch',
        description: 'The checkout endpoint answered 502 four times in a row.',
        fields: [
          { name: 'Region', value: 'eu-west-1' },
          { name: 'Since', value: '3 minutes ago' },
        ],
        footerText: 'Muted until acknowledged',
        imageUrl: 'https://status.example.test/graphs/checkout.png',
        thumbnailUrl: 'https://status.example.test/icons/checkout.png',
        timestamp: '2026-07-30T09:15:00.000Z',
        title: 'Checkout is down',
        url: 'https://status.example.test/incidents/77',
      })
    ).toBe(
      [
        'Uptime watch',
        'Checkout is down (https://status.example.test/incidents/77)',
        'The checkout endpoint answered 502 four times in a row.',
        'Region: eu-west-1',
        'Since: 3 minutes ago',
        'https://status.example.test/graphs/checkout.png',
        'https://status.example.test/icons/checkout.png',
        'Muted until acknowledged',
        '2026-07-30T09:15:00.000Z',
      ].join('\n')
    )
  })

  it('leaves out the parts the embed does not carry', () => {
    expect(
      renderEmbed({
        description: 'A pull request is waiting for review.',
        title: 'Ready for review',
      })
    ).toBe('Ready for review\nA pull request is waiting for review.')
  })

  it('keeps a title without a link as plain text', () => {
    expect(renderEmbed({ title: 'Nightly build passed' })).toBe(
      'Nightly build passed'
    )
  })

  it('keeps the link of a preview that never got a title', () => {
    expect(
      renderEmbed({
        description: 'The handbook everyone keeps asking for.',
        url: 'https://handbook.example.test/onboarding',
      })
    ).toBe(
      'https://handbook.example.test/onboarding\nThe handbook everyone keeps asking for.'
    )
  })

  it('reads an embed carrying nothing renderable as empty text', () => {
    expect(renderEmbed({ description: '   ', fields: [] })).toBe('')
  })
})

describe('messageFetchGuidance', () => {
  it('speaks for every outcome a fetch can reach', () => {
    expect([...everyFailureKind].sort()).toEqual(
      Object.keys(messageFetchFailureCopy).sort()
    )
    expect([...everySkipReason].sort()).toEqual(
      Object.keys(messageFetchSkipCopy).sort()
    )
  })

  it('gives each outcome its own summary and a next action to take', () => {
    const guidance = [
      messageFetchGuidance({ status: 'retrieved' }),
      ...everyFailureKind.map((kind) =>
        messageFetchGuidance({ kind, status: 'failed' })
      ),
      ...everySkipReason.map((reason) =>
        messageFetchGuidance({ reason, status: 'skipped' })
      ),
    ]

    expect(guidance[0]).toEqual(messageFetchRetrievalCopy)
    expect(guidance).toContainEqual(messageFetchFailureCopy.gone)
    expect(guidance).toContainEqual(messageFetchSkipCopy.message_deleted)
    expect(
      guidance.filter(
        ({ nextAction, summary }) => summary.trim() && nextAction.trim()
      )
    ).toHaveLength(guidance.length)
    expect(new Set(guidance.map(({ summary }) => summary)).size).toBe(
      guidance.length
    )
  })
})
