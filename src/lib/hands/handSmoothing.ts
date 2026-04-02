import type { Handedness } from '../config/params'

export interface HandSample {
  handedness: Handedness
  x: number
  y: number
  confidence: number
}

export interface SmoothedHand {
  handedness: Handedness
  x: number
  y: number
  vx: number
  vy: number
  speed: number
  confidence: number
}

interface HandState {
  xFilter: LowPassFilter
  yFilter: LowPassFilter
  dxFilter: LowPassFilter
  dyFilter: LowPassFilter
  x: number
  y: number
  vx: number
  vy: number
  timestampMs: number
}

const MIN_CUTOFF = 1.35
const BETA = 0.075
const DERIVATIVE_CUTOFF = 1.8
const LOOKAHEAD_SECONDS = 0.012

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function smoothingAlpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

class LowPassFilter {
  private initialized = false

  private value = 0

  filter(nextValue: number, alpha: number) {
    if (!this.initialized) {
      this.initialized = true
      this.value = nextValue
      return nextValue
    }

    this.value = alpha * nextValue + (1 - alpha) * this.value
    return this.value
  }
}

export class HandMotionSmoother {
  private readonly states = new Map<Handedness, HandState>()

  update(samples: HandSample[], timestampMs: number): SmoothedHand[] {
    const smoothedHands: SmoothedHand[] = []
    const activeHands = new Set<Handedness>()

    for (const sample of samples) {
      activeHands.add(sample.handedness)
      const existing = this.states.get(sample.handedness)

      if (!existing) {
        const state: HandState = {
          xFilter: new LowPassFilter(),
          yFilter: new LowPassFilter(),
          dxFilter: new LowPassFilter(),
          dyFilter: new LowPassFilter(),
          x: sample.x,
          y: sample.y,
          vx: 0,
          vy: 0,
          timestampMs,
        }

        state.xFilter.filter(sample.x, 1)
        state.yFilter.filter(sample.y, 1)
        state.dxFilter.filter(0, 1)
        state.dyFilter.filter(0, 1)
        this.states.set(sample.handedness, state)
        smoothedHands.push({
          handedness: sample.handedness,
          x: sample.x,
          y: sample.y,
          vx: 0,
          vy: 0,
          speed: 0,
          confidence: sample.confidence,
        })
        continue
      }

      const dt = clamp((timestampMs - existing.timestampMs) / 1000, 1 / 240, 0.05)
      const rawDx = (sample.x - existing.x) / dt
      const rawDy = (sample.y - existing.y) / dt
      const filteredDx = existing.dxFilter.filter(
        rawDx,
        smoothingAlpha(DERIVATIVE_CUTOFF, dt),
      )
      const filteredDy = existing.dyFilter.filter(
        rawDy,
        smoothingAlpha(DERIVATIVE_CUTOFF, dt),
      )
      const xCutoff = MIN_CUTOFF + BETA * Math.abs(filteredDx)
      const yCutoff = MIN_CUTOFF + BETA * Math.abs(filteredDy)
      const nextX = existing.xFilter.filter(sample.x, smoothingAlpha(xCutoff, dt))
      const nextY = existing.yFilter.filter(sample.y, smoothingAlpha(yCutoff, dt))
      const vx = (nextX - existing.x) / dt
      const vy = (nextY - existing.y) / dt
      const predictedX = clamp(nextX + vx * LOOKAHEAD_SECONDS, 0, 1)
      const predictedY = clamp(nextY + vy * LOOKAHEAD_SECONDS, 0, 1)

      existing.x = nextX
      existing.y = nextY
      existing.vx = vx
      existing.vy = vy
      existing.timestampMs = timestampMs

      smoothedHands.push({
        handedness: sample.handedness,
        x: predictedX,
        y: predictedY,
        vx,
        vy,
        speed: Math.hypot(vx, vy),
        confidence: sample.confidence,
      })
    }

    for (const handedness of this.states.keys()) {
      if (!activeHands.has(handedness)) {
        this.states.delete(handedness)
      }
    }

    return smoothedHands
  }
}
