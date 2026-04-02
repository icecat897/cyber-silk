import type { Handedness } from '../config/params'
import type { TrackedHand } from './handTracker'

interface MouseHandState {
  x: number
  y: number
  vx: number
  vy: number
  timestampMs: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export class MouseHandSimulator {
  private readonly states = new Map<Handedness, MouseHandState>()

  syncFromPointer(event: PointerEvent, bounds: DOMRect) {
    const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
    const y = clamp(1 - (event.clientY - bounds.top) / bounds.height, 0, 1)
    const timestampMs = performance.now()

    this.syncHand('Left', Boolean(event.buttons & 1), x, y, timestampMs)
    this.syncHand('Right', Boolean(event.buttons & 2), x, y, timestampMs)
  }

  releaseAll() {
    this.states.clear()
  }

  getHands(timestampMs: number): TrackedHand[] {
    const hands: TrackedHand[] = []

    for (const [handedness, state] of this.states.entries()) {
      const stale = timestampMs - state.timestampMs > 90
      const vx = stale ? 0 : state.vx
      const vy = stale ? 0 : state.vy

      hands.push({
        handedness,
        x: state.x,
        y: state.y,
        vx,
        vy,
        speed: stale ? 0 : Math.hypot(vx, vy),
        confidence: 1,
        fistStrength: 0,
        pulse: false,
        snap: false,
      })
    }

    return hands
  }

  private syncHand(
    handedness: Handedness,
    pressed: boolean,
    x: number,
    y: number,
    timestampMs: number,
  ) {
    if (!pressed) {
      this.states.delete(handedness)
      return
    }

    const previous = this.states.get(handedness)

    if (!previous) {
      this.states.set(handedness, {
        x,
        y,
        vx: 0,
        vy: 0,
        timestampMs,
      })
      return
    }

    const dt = clamp((timestampMs - previous.timestampMs) / 1000, 1 / 240, 0.08)
    const vx = (x - previous.x) / dt
    const vy = (y - previous.y) / dt

    this.states.set(handedness, {
      x,
      y,
      vx,
      vy,
      timestampMs,
    })
  }
}
