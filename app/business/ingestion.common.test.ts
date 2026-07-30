import { describe, expect, it } from '~/test/prelude'
import {
  deriveGatewayActivity,
  gatewaySilenceThresholdMinutes,
} from './ingestion.common'

const observedAt = '2026-07-30T12:00:00.000Z'

function minutesBefore(minutes: number) {
  return new Date(Date.parse(observedAt) - minutes * 60_000).toISOString()
}

describe('deriveGatewayActivity', () => {
  it('reads as never until the bot has connected once', () => {
    expect(
      deriveGatewayActivity({
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        observedAt,
      })
    ).toBe('never')
  })

  it('reads as receiving while the newest event is a connection', () => {
    expect(
      deriveGatewayActivity({
        lastConnectedAt: minutesBefore(1),
        lastDisconnectedAt: minutesBefore(90),
        observedAt,
      })
    ).toBe('receiving')
  })

  it('reads as receiving while a fresh disconnection can still heal itself', () => {
    expect(
      deriveGatewayActivity({
        lastConnectedAt: minutesBefore(90),
        lastDisconnectedAt: minutesBefore(gatewaySilenceThresholdMinutes - 1),
        observedAt,
      })
    ).toBe('receiving')
  })

  it('reads as quiet once a disconnection outlasts the silence threshold', () => {
    expect(
      deriveGatewayActivity({
        lastConnectedAt: minutesBefore(90),
        lastDisconnectedAt: minutesBefore(gatewaySilenceThresholdMinutes + 1),
        observedAt,
      })
    ).toBe('quiet')
  })
})
