export type Handedness = 'Left' | 'Right'

export type Vec3 = [number, number, number]

export interface FluidTuning {
  velocityDissipation: number
  dyeDissipation: number
  vorticity: number
  viscosity: number
  splatRadius: number
  splatVelocity: number
  colorIntensity: number
  bloomStrength: number
}

export const HAND_COLORS: Record<Handedness, Vec3> = {
  Left: [0.08, 0.65, 1.0],
  Right: [0.76, 0.3, 1.0],
}

export const ENGINE_PARAMS = {
  simulationResolutionScale: 0.58,
  dyeResolutionScale: 0.82,
  bloomResolutionScale: 0.5,
  maxPixelRatio: 1.75,
  pressureIterations: 18,
  pressureDecay: 0.94,
  viscosityPasses: 2,
  bloomThreshold: 0.42,
  bloomBlurPasses: 6,
  detectionFps: 60,
  speedThreshold: 0.03,
  maxSplatSpeed: 2.4,
} as const

export const DEFAULT_FLUID_TUNING: FluidTuning = {
  velocityDissipation: 0.991,
  dyeDissipation: 0.994,
  vorticity: 16,
  viscosity: 0.15,
  splatRadius: 0.006,
  splatVelocity: 0.44,
  colorIntensity: 0.78,
  bloomStrength: 0.72,
}

export const FLUID_TUNING_PRESETS: Record<string, FluidTuning> = {
  Silk: { ...DEFAULT_FLUID_TUNING },
  Ribbon: {
    velocityDissipation: 0.993,
    dyeDissipation: 0.998,
    vorticity: 12,
    viscosity: 0.28,
    splatRadius: 0.009,
    splatVelocity: 0.17,
    colorIntensity: 0.9,
    bloomStrength: 1.12,
  },
  Pulse: {
    velocityDissipation: 0.988,
    dyeDissipation: 0.995,
    vorticity: 20,
    viscosity: 0.12,
    splatRadius: 0.005,
    splatVelocity: 0.24,
    colorIntensity: 0.96,
    bloomStrength: 1.18,
  },
}

export const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60, max: 60 },
  },
} as const satisfies MediaStreamConstraints
