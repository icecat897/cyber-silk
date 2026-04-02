import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { Handedness } from '../config/params'
import { HandMotionSmoother, type HandSample, type SmoothedHand } from './handSmoothing'

const WRIST = 0
const INDEX_FINGER_MCP = 5
const INDEX_FINGER_TIP = 8
const MIDDLE_FINGER_MCP = 9
const MIDDLE_FINGER_TIP = 12
const RING_FINGER_MCP = 13
const RING_FINGER_TIP = 16
const PINKY_MCP = 17
const PINKY_TIP = 20
const WASM_BASE_PATH = '/mediapipe'
const MODEL_ASSET_PATH = '/models/hand_landmarker.task'

interface LandmarkPoint {
  x: number
  y: number
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

function distance(a: LandmarkPoint, b: LandmarkPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function averagePoints(points: LandmarkPoint[]) {
  const total = points.reduce(
    (accumulator, point) => {
      accumulator.x += point.x
      accumulator.y += point.y
      return accumulator
    },
    { x: 0, y: 0 },
  )

  return {
    x: total.x / points.length,
    y: total.y / points.length,
  }
}

function getPalmCenter(landmarks: LandmarkPoint[]) {
  return averagePoints([
    landmarks[WRIST],
    landmarks[INDEX_FINGER_MCP],
    landmarks[MIDDLE_FINGER_MCP],
    landmarks[RING_FINGER_MCP],
    landmarks[PINKY_MCP],
  ])
}

function getFistStrength(landmarks: LandmarkPoint[]) {
  const palmCenter = getPalmCenter(landmarks)
  const palmScale = Math.max(
    (distance(landmarks[INDEX_FINGER_MCP], landmarks[PINKY_MCP]) +
      distance(landmarks[WRIST], landmarks[MIDDLE_FINGER_MCP])) *
      0.5,
    0.0001,
  )

  const averageTipDistance =
    (distance(landmarks[INDEX_FINGER_TIP], palmCenter) +
      distance(landmarks[MIDDLE_FINGER_TIP], palmCenter) +
      distance(landmarks[RING_FINGER_TIP], palmCenter) +
      distance(landmarks[PINKY_TIP], palmCenter)) /
    4

  return clamp(1 - (averageTipDistance / palmScale - 0.65) / 1.15)
}

export type TrackedHand = SmoothedHand
export type TrackingMode = 'precision' | 'stable'

interface FistGestureState {
  closed: boolean
  filteredStrength: number
  cooldownUntilMs: number
  lastTimestampMs: number
}

const FIST_CLOSE_THRESHOLD = 0.72
const FIST_OPEN_THRESHOLD = 0.44
const FIST_FILTER_RESPONSE = 12
const FIST_PULSE_COOLDOWN_MS = 260
export class HandTracker {
  private landmarker: HandLandmarker | null = null

  private readonly precisionSmoother = new HandMotionSmoother()

  private readonly stableSmoother = new HandMotionSmoother()

  private readonly fistStates = new Map<Handedness, FistGestureState>()

  async init() {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE_PATH)

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_ASSET_PATH,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.46,
        minHandPresenceConfidence: 0.36,
        minTrackingConfidence: 0.4,
      })
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_ASSET_PATH,
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.46,
        minHandPresenceConfidence: 0.36,
        minTrackingConfidence: 0.4,
      })
    }
  }

  detect(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): TrackedHand[] {
    if (!this.landmarker) {
      return []
    }

    const result = this.landmarker.detectForVideo(video, timestampMs)
    const samples: HandSample[] = []
    const activeHands = new Set<Handedness>()

    result.landmarks.forEach((landmarks, index) => {
      const handedness = result.handednesses[index]?.[0]
      const label = handedness?.categoryName

      if (label !== 'Left' && label !== 'Right') {
        return
      }

      activeHands.add(label)
      const fistStrength = getFistStrength(landmarks)
      const { filteredStrength, pulse } = this.updateFistGestureState(
        label,
        fistStrength,
        timestampMs,
      )
      const point =
        mode === 'stable' ? getPalmCenter(landmarks) : landmarks[INDEX_FINGER_TIP]

      if (!point) {
        return
      }

      samples.push({
        handedness: label as Handedness,
        x: clamp(1 - point.x),
        y: clamp(1 - point.y),
        confidence:
          (handedness?.score ?? 0) * (mode === 'stable' ? 0.82 + fistStrength * 0.18 : 1),
        fistStrength: mode === 'stable' ? filteredStrength : 0,
        pulse: mode === 'stable' ? pulse : false,
        snap: false,
      })
    })

    for (const handedness of this.fistStates.keys()) {
      if (!activeHands.has(handedness)) {
        this.fistStates.delete(handedness)
      }
    }

    return (mode === 'stable' ? this.stableSmoother : this.precisionSmoother).update(
      samples,
      timestampMs,
    )
  }

  private updateFistGestureState(
    handedness: Handedness,
    nextStrength: number,
    timestampMs: number,
  ) {
    const existing = this.fistStates.get(handedness)

    if (!existing) {
      const initialState: FistGestureState = {
        closed: false,
        filteredStrength: nextStrength,
        cooldownUntilMs: 0,
        lastTimestampMs: timestampMs,
      }
      this.fistStates.set(handedness, initialState)
      return { filteredStrength: nextStrength, pulse: false }
    }

    const dt = Math.min(Math.max((timestampMs - existing.lastTimestampMs) / 1000, 1 / 240), 0.08)
    const alpha = 1 - Math.exp(-FIST_FILTER_RESPONSE * dt)
    existing.filteredStrength += (nextStrength - existing.filteredStrength) * alpha
    existing.lastTimestampMs = timestampMs

    let pulse = false

    if (!existing.closed && existing.filteredStrength >= FIST_CLOSE_THRESHOLD) {
      if (timestampMs >= existing.cooldownUntilMs) {
        pulse = true
        existing.cooldownUntilMs = timestampMs + FIST_PULSE_COOLDOWN_MS
      }
      existing.closed = true
    } else if (existing.closed && existing.filteredStrength <= FIST_OPEN_THRESHOLD) {
      existing.closed = false
    }

    return {
      filteredStrength: existing.filteredStrength,
      pulse,
    }
  }

  destroy() {
    this.landmarker?.close()
    this.landmarker = null
    this.fistStates.clear()
  }
}
