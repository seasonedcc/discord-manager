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
  it('reads as never until the bot has shown any sign of life', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: null,
        lastDisconnectedAt: null,
        observedAt,
      })
    ).toBe('never')
  })

  it('reads as receiving while the bot was alive moments ago', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: minutesBefore(1),
        lastDisconnectedAt: minutesBefore(90),
        observedAt,
      })
    ).toBe('receiving')
  })

  it('reads as quiet once the newest sign of life outlasts the silence threshold', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: minutesBefore(gatewaySilenceThresholdMinutes + 1),
        lastDisconnectedAt: null,
        observedAt,
      })
    ).toBe('quiet')
  })

  it('reads as receiving while a fresh disconnection can still heal itself', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: minutesBefore(gatewaySilenceThresholdMinutes - 2),
        lastDisconnectedAt: minutesBefore(gatewaySilenceThresholdMinutes - 1),
        observedAt,
      })
    ).toBe('receiving')
  })

  it('reads as quiet once a disconnection outlasts the silence threshold', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: minutesBefore(90),
        lastDisconnectedAt: minutesBefore(gatewaySilenceThresholdMinutes + 1),
        observedAt,
      })
    ).toBe('quiet')
  })

  it('reads a heartbeat that landed after a disconnection as receiving', () => {
    expect(
      deriveGatewayActivity({
        lastAliveAt: minutesBefore(1),
        lastDisconnectedAt: minutesBefore(2),
        observedAt,
      })
    ).toBe('receiving')
  })
})
