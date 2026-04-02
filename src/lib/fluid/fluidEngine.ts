import { DEFAULT_FLUID_TUNING, ENGINE_PARAMS, HAND_COLORS, type FluidTuning, type Handedness } from '../config/params'
import type { TrackedHand } from '../hands/handTracker'
import { createBloomResources, disposeBloomResources, type BloomResources, BLOOM_BLUR_FRAGMENT, BLOOM_PREFILTER_FRAGMENT } from '../render/bloom'
import { createDoubleFBO, createFBO, disposeDoubleFBO, disposeFBO, type DoubleFBO, type SingleFBO, type TextureSpec } from './framebuffers'
import {
  ADDITIVE_FRAGMENT_SHADER,
  ADVECTION_FRAGMENT_SHADER,
  CLEAR_FRAGMENT_SHADER,
  CURL_FRAGMENT_SHADER,
  DISPLAY_FRAGMENT_SHADER,
  DIVERGENCE_FRAGMENT_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  GRADIENT_SUBTRACT_FRAGMENT_SHADER,
  PRESSURE_FRAGMENT_SHADER,
  SPLAT_FRAGMENT_SHADER,
  VISCOSITY_FRAGMENT_SHADER,
  VORTICITY_FRAGMENT_SHADER,
} from './shaders'

interface ProgramInfo {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

interface SimulationResources {
  velocity: DoubleFBO
  dye: DoubleFBO
  pressure: DoubleFBO
  divergence: SingleFBO
  curl: SingleFBO
  bloom: BloomResources
}

interface InjectionPoint extends TrackedHand {
  weight: number
}

interface PathState {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function assertResource<T>(resource: T | null, message: string): T {
  if (!resource) {
    throw new Error(message)
  }

  return resource
}

function getPulseColors(handedness: Handedness) {
  return handedness === 'Left'
    ? {
        core: [1.0, 0.8, 0.62] as const,
        ring: [0.96, 0.54, 0.38] as const,
      }
    : {
        core: [0.76, 1.0, 1.1] as const,
        ring: [0.42, 0.84, 1.04] as const,
      }
}

export class FluidEngine {
  private readonly canvas: HTMLCanvasElement

  private readonly gl: WebGL2RenderingContext

  private readonly quadVao: WebGLVertexArrayObject

  private readonly programs: Record<string, ProgramInfo>

  private resources: SimulationResources | null = null

  private tuning: FluidTuning = { ...DEFAULT_FLUID_TUNING }

  private readonly pathStates = new Map<Handedness, PathState>()

  private elapsedTime = 0

  private idleTime = 0

  private width = 0

  private height = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    })

    if (!gl) {
      throw new Error('WebGL2 is unavailable in this browser.')
    }

    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('Float render targets are unavailable. Please enable hardware acceleration.')
    }

    this.gl = gl
    this.quadVao = this.createFullscreenQuad()
    this.programs = {
      clear: this.createProgram(FULLSCREEN_VERTEX_SHADER, CLEAR_FRAGMENT_SHADER, ['uTexture', 'uValue']),
      splat: this.createProgram(FULLSCREEN_VERTEX_SHADER, SPLAT_FRAGMENT_SHADER, ['uTarget', 'uPoint', 'uColor', 'uRadius', 'uAspect']),
      advection: this.createProgram(FULLSCREEN_VERTEX_SHADER, ADVECTION_FRAGMENT_SHADER, ['uVelocity', 'uSource', 'uDt', 'uDissipation']),
      viscosity: this.createProgram(FULLSCREEN_VERTEX_SHADER, VISCOSITY_FRAGMENT_SHADER, ['uVelocity', 'uTexelSize', 'uStrength']),
      divergence: this.createProgram(FULLSCREEN_VERTEX_SHADER, DIVERGENCE_FRAGMENT_SHADER, ['uVelocity', 'uTexelSize']),
      curl: this.createProgram(FULLSCREEN_VERTEX_SHADER, CURL_FRAGMENT_SHADER, ['uVelocity', 'uTexelSize']),
      vorticity: this.createProgram(FULLSCREEN_VERTEX_SHADER, VORTICITY_FRAGMENT_SHADER, ['uVelocity', 'uCurl', 'uTexelSize', 'uCurlStrength', 'uDt']),
      pressure: this.createProgram(FULLSCREEN_VERTEX_SHADER, PRESSURE_FRAGMENT_SHADER, ['uPressure', 'uDivergence', 'uTexelSize']),
      gradientSubtract: this.createProgram(FULLSCREEN_VERTEX_SHADER, GRADIENT_SUBTRACT_FRAGMENT_SHADER, ['uVelocity', 'uPressure', 'uTexelSize']),
      display: this.createProgram(FULLSCREEN_VERTEX_SHADER, DISPLAY_FRAGMENT_SHADER, ['uTexture', 'uIntensity']),
      additive: this.createProgram(FULLSCREEN_VERTEX_SHADER, ADDITIVE_FRAGMENT_SHADER, ['uTexture', 'uStrength']),
      bloomPrefilter: this.createProgram(FULLSCREEN_VERTEX_SHADER, BLOOM_PREFILTER_FRAGMENT, ['uTexture', 'uThreshold']),
      bloomBlur: this.createProgram(FULLSCREEN_VERTEX_SHADER, BLOOM_BLUR_FRAGMENT, ['uTexture', 'uDirection']),
    }

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
  }

  resize(width: number, height: number, pixelRatio: number) {
    const nextWidth = Math.max(1, Math.round(width * pixelRatio))
    const nextHeight = Math.max(1, Math.round(height * pixelRatio))

    if (nextWidth === this.width && nextHeight === this.height) {
      return
    }

    this.width = nextWidth
    this.height = nextHeight
    this.canvas.width = nextWidth
    this.canvas.height = nextHeight
    this.disposeResources()
    this.resources = this.createResources(nextWidth, nextHeight)
  }

  step(dt: number, hands: TrackedHand[]) {
    if (!this.resources) {
      return
    }

    const deltaTime = clamp(dt, 1 / 240, 1 / 24)
    this.elapsedTime += deltaTime
    this.simulate(deltaTime, hands)
    this.render()
  }

  setTuning(nextTuning: FluidTuning) {
    this.tuning = { ...nextTuning }
  }

  destroy() {
    this.disposeResources()

    for (const program of Object.values(this.programs)) {
      this.gl.deleteProgram(program.program)
    }

    this.gl.deleteVertexArray(this.quadVao)
  }

  private createResources(width: number, height: number): SimulationResources {
    const gl = this.gl
    const simWidth = Math.max(64, Math.round(width * ENGINE_PARAMS.simulationResolutionScale))
    const simHeight = Math.max(64, Math.round(height * ENGINE_PARAMS.simulationResolutionScale))
    const dyeWidth = Math.max(128, Math.round(width * ENGINE_PARAMS.dyeResolutionScale))
    const dyeHeight = Math.max(128, Math.round(height * ENGINE_PARAMS.dyeResolutionScale))
    const bloomWidth = Math.max(64, Math.round(width * ENGINE_PARAMS.bloomResolutionScale))
    const bloomHeight = Math.max(64, Math.round(height * ENGINE_PARAMS.bloomResolutionScale))
    const halfFloat = gl.HALF_FLOAT

    const velocitySpec: TextureSpec = {
      internalFormat: gl.RG16F,
      format: gl.RG,
      type: halfFloat,
      filtering: gl.LINEAR,
    }

    const dyeSpec: TextureSpec = {
      internalFormat: gl.RGBA16F,
      format: gl.RGBA,
      type: halfFloat,
      filtering: gl.LINEAR,
    }

    const scalarSpec: TextureSpec = {
      internalFormat: gl.R16F,
      format: gl.RED,
      type: halfFloat,
      filtering: gl.NEAREST,
    }

    return {
      velocity: createDoubleFBO(gl, simWidth, simHeight, velocitySpec),
      dye: createDoubleFBO(gl, dyeWidth, dyeHeight, dyeSpec),
      pressure: createDoubleFBO(gl, simWidth, simHeight, scalarSpec),
      divergence: createFBO(gl, simWidth, simHeight, scalarSpec),
      curl: createFBO(gl, simWidth, simHeight, scalarSpec),
      bloom: createBloomResources(gl, bloomWidth, bloomHeight, dyeSpec),
    }
  }

  private disposeResources() {
    if (!this.resources) {
      return
    }

    disposeDoubleFBO(this.gl, this.resources.velocity)
    disposeDoubleFBO(this.gl, this.resources.dye)
    disposeDoubleFBO(this.gl, this.resources.pressure)
    disposeFBO(this.gl, this.resources.divergence)
    disposeFBO(this.gl, this.resources.curl)
    disposeBloomResources(this.gl, this.resources.bloom)
    this.resources = null
    this.pathStates.clear()
  }

  private simulate(dt: number, hands: TrackedHand[]) {
    const resources = this.resources

    if (!resources) {
      return
    }

    const gl = this.gl
    const tuning = this.tuning
    const injectionPoints = this.buildInjectionPoints(hands)
    const hasInput = injectionPoints.length > 0

    this.idleTime = hasInput ? 0 : Math.min(this.idleTime + dt, 12)

    gl.disable(gl.BLEND)

    this.runAdvection(resources.velocity, resources.velocity.read.texture, dt, tuning.velocityDissipation)

    for (let pass = 0; pass < ENGINE_PARAMS.viscosityPasses; pass += 1) {
      this.runViscosity(resources.velocity, tuning.viscosity)
    }

    this.runCurl(resources.velocity.read.texture, resources.curl)
    this.runVorticity(resources.velocity, resources.curl.texture, dt)
    this.injectHandPulses(hands)
    this.injectPoints(injectionPoints)

    if (!hasInput) {
      this.injectIdleFlow(false)
    }

    this.runDivergence(resources.velocity.read.texture, resources.divergence)
    this.runClear(resources.pressure, ENGINE_PARAMS.pressureDecay)

    for (let iteration = 0; iteration < ENGINE_PARAMS.pressureIterations; iteration += 1) {
      this.runPressure(resources.pressure, resources.divergence.texture)
    }

    this.runGradientSubtract(resources.velocity, resources.pressure.read.texture)
    this.runAdvection(resources.dye, resources.velocity.read.texture, dt, tuning.dyeDissipation)

    if (!hasInput) {
      this.injectIdleFlow(true)
    }

    this.injectPoints(injectionPoints, true)
  }

  private render() {
    const resources = this.resources

    if (!resources) {
      return
    }

    const gl = this.gl
    this.renderBloom(resources.dye.read.texture, resources.bloom)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.useProgram(this.programs.display)
    this.bindTexture(resources.dye.read.texture, 0)
    gl.uniform1i(this.programs.display.uniforms.uTexture, 0)
    gl.uniform1f(this.programs.display.uniforms.uIntensity, 1)
    this.draw()

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    this.useProgram(this.programs.additive)
    this.bindTexture(resources.bloom.blur.read.texture, 0)
    gl.uniform1i(this.programs.additive.uniforms.uTexture, 0)
    gl.uniform1f(this.programs.additive.uniforms.uStrength, this.tuning.bloomStrength)
    this.draw()
    gl.disable(gl.BLEND)
  }

  private renderBloom(sourceTexture: WebGLTexture, bloom: BloomResources) {
    const gl = this.gl
    this.useProgram(this.programs.bloomPrefilter)
    this.bindTexture(sourceTexture, 0)
    gl.uniform1i(this.programs.bloomPrefilter.uniforms.uTexture, 0)
    gl.uniform1f(this.programs.bloomPrefilter.uniforms.uThreshold, ENGINE_PARAMS.bloomThreshold)
    this.drawTo(bloom.prefilter)

    this.useProgram(this.programs.bloomBlur)
    this.bindTexture(bloom.prefilter.texture, 0)
    gl.uniform1i(this.programs.bloomBlur.uniforms.uTexture, 0)
    gl.uniform2f(this.programs.bloomBlur.uniforms.uDirection, 1 / bloom.prefilter.width, 0)
    this.drawTo(bloom.blur.write)
    bloom.blur.swap()

    for (let pass = 0; pass < ENGINE_PARAMS.bloomBlurPasses; pass += 1) {
      this.bindTexture(bloom.blur.read.texture, 0)
      gl.uniform1i(this.programs.bloomBlur.uniforms.uTexture, 0)
      gl.uniform2f(this.programs.bloomBlur.uniforms.uDirection, 0, 1 / bloom.prefilter.height)
      this.drawTo(bloom.blur.write)
      bloom.blur.swap()

      this.bindTexture(bloom.blur.read.texture, 0)
      gl.uniform1i(this.programs.bloomBlur.uniforms.uTexture, 0)
      gl.uniform2f(this.programs.bloomBlur.uniforms.uDirection, 1 / bloom.prefilter.width, 0)
      this.drawTo(bloom.blur.write)
      bloom.blur.swap()
    }
  }

  private buildInjectionPoints(hands: TrackedHand[]) {
    const points: InjectionPoint[] = []
    const activeHands = new Set<Handedness>()

    for (const hand of hands) {
      if (hand.confidence < 0.35) {
        this.pathStates.delete(hand.handedness)
        continue
      }

      activeHands.add(hand.handedness)
      const previous = this.pathStates.get(hand.handedness)

      if (!previous) {
        points.push({ ...hand, weight: 1 })
        this.pathStates.set(hand.handedness, { x: hand.x, y: hand.y })
        continue
      }

      const dx = hand.x - previous.x
      const dy = hand.y - previous.y
      const distance = Math.hypot(dx, dy)
      const spacing = Math.max(this.tuning.splatRadius * 1.8, 0.006)
      const steps = clamp(Math.ceil(distance / spacing), 1, 12)
      const weight = 1 / Math.sqrt(steps)

      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps
        points.push({
          ...hand,
          x: previous.x + dx * progress,
          y: previous.y + dy * progress,
          weight,
        })
      }

      this.pathStates.set(hand.handedness, { x: hand.x, y: hand.y })
    }

    for (const handedness of this.pathStates.keys()) {
      if (!activeHands.has(handedness)) {
        this.pathStates.delete(handedness)
      }
    }

    return points
  }

  private injectPoints(points: InjectionPoint[], dyeOnly = false) {
    const resources = this.resources

    if (!resources) {
      return
    }

    const tuning = this.tuning

    for (const hand of points) {
      const speedRatio = clamp(
        (hand.speed - ENGINE_PARAMS.speedThreshold) / ENGINE_PARAMS.maxSplatSpeed,
        0,
        1,
      )

      if (speedRatio <= 0 || hand.confidence < 0.35) {
        continue
      }

      const radius = tuning.splatRadius * (0.48 + speedRatio * 0.42)
      const forceScale = hand.weight

      if (!dyeOnly) {
        this.runSplat(resources.velocity, hand.x, hand.y, [
          hand.vx * tuning.splatVelocity * forceScale,
          hand.vy * tuning.splatVelocity * forceScale,
          0,
        ], radius)
      }

      const baseColor = HAND_COLORS[hand.handedness]
      const intensity = tuning.colorIntensity * (0.56 + speedRatio * 0.84) * forceScale
      this.runSplat(resources.dye, hand.x, hand.y, [
        baseColor[0] * intensity,
        baseColor[1] * intensity,
        baseColor[2] * intensity,
      ], radius * 0.76)
    }
  }

  private injectHandPulses(hands: TrackedHand[]) {
    const resources = this.resources

    if (!resources) {
      return
    }

    const aspect = this.width / this.height
    const time = this.elapsedTime

    for (const hand of hands) {
      if (!hand.pulse || hand.confidence < 0.35) {
        continue
      }

      const pulseStrength = 0.95 + hand.fistStrength * 0.62
      const baseRadius = Math.max(this.tuning.splatRadius * 3.1, 0.013)
      const innerRingDistance = baseRadius * 2.4
      const outerRingDistance = baseRadius * 4.2
      const baseColor = HAND_COLORS[hand.handedness]
      const pulseColors = getPulseColors(hand.handedness)
      const direction = hand.handedness === 'Left' ? -1 : 1
      const phase = time * 2.1 * direction

      this.runSplat(resources.velocity, hand.x, hand.y, [
        hand.vx * this.tuning.splatVelocity * 0.44 * pulseStrength,
        hand.vy * this.tuning.splatVelocity * 0.44 * pulseStrength,
        0,
      ], baseRadius * 1.18)

      this.runSplat(resources.dye, hand.x, hand.y, [
        pulseColors.core[0] * this.tuning.colorIntensity * 2.2 * pulseStrength,
        pulseColors.core[1] * this.tuning.colorIntensity * 2.2 * pulseStrength,
        pulseColors.core[2] * this.tuning.colorIntensity * 2.2 * pulseStrength,
      ], baseRadius * 1.26)

      this.runSplat(resources.dye, hand.x, hand.y, [
        baseColor[0] * this.tuning.colorIntensity * 1.08 * pulseStrength,
        baseColor[1] * this.tuning.colorIntensity * 1.08 * pulseStrength,
        baseColor[2] * this.tuning.colorIntensity * 1.08 * pulseStrength,
      ], baseRadius * 0.74)

      for (let index = 0; index < 8; index += 1) {
        const angle = phase + (Math.PI * 2 * index) / 8
        const offsetX = (Math.cos(angle) * innerRingDistance) / aspect
        const offsetY = Math.sin(angle) * innerRingDistance
        const px = clamp(hand.x + offsetX, 0, 1)
        const py = clamp(hand.y + offsetY, 0, 1)
        const tangentX = -Math.sin(angle) * this.tuning.splatVelocity * 0.34 * pulseStrength
        const tangentY = Math.cos(angle) * this.tuning.splatVelocity * 0.34 * pulseStrength

        this.runSplat(resources.velocity, px, py, [tangentX, tangentY, 0], baseRadius * 0.96)
        this.runSplat(resources.dye, px, py, [
          pulseColors.ring[0] * this.tuning.colorIntensity * 1.72 * pulseStrength,
          pulseColors.ring[1] * this.tuning.colorIntensity * 1.72 * pulseStrength,
          pulseColors.ring[2] * this.tuning.colorIntensity * 1.72 * pulseStrength,
        ], baseRadius * 0.88)
      }

      for (let index = 0; index < 10; index += 1) {
        const angle = -phase + (Math.PI * 2 * index) / 10
        const offsetX = (Math.cos(angle) * outerRingDistance) / aspect
        const offsetY = Math.sin(angle) * outerRingDistance
        const px = clamp(hand.x + offsetX, 0, 1)
        const py = clamp(hand.y + offsetY, 0, 1)
        const tangentX = -Math.sin(angle) * this.tuning.splatVelocity * 0.18 * pulseStrength
        const tangentY = Math.cos(angle) * this.tuning.splatVelocity * 0.18 * pulseStrength

        this.runSplat(resources.velocity, px, py, [tangentX, tangentY, 0], baseRadius * 0.7)
        this.runSplat(resources.dye, px, py, [
          pulseColors.core[0] * this.tuning.colorIntensity * 0.82 * pulseStrength,
          pulseColors.core[1] * this.tuning.colorIntensity * 0.82 * pulseStrength,
          pulseColors.core[2] * this.tuning.colorIntensity * 0.82 * pulseStrength,
        ], baseRadius * 0.56)
      }
    }
  }

  private injectIdleFlow(dyeOnly: boolean) {
    const resources = this.resources

    if (!resources || this.idleTime < 0.8) {
      return
    }

    const tuning = this.tuning
    const wake = clamp((this.idleTime - 0.8) / 2.4, 0, 1)
    const time = this.elapsedTime
    const radius = tuning.splatRadius * 0.72
    const leftX = 0.28 + Math.sin(time * 0.34) * 0.09
    const leftY = 0.56 + Math.cos(time * 0.27) * 0.14
    const rightX = 0.72 + Math.cos(time * 0.29) * 0.1
    const rightY = 0.44 + Math.sin(time * 0.31) * 0.13

    const emitters = [
      {
        handedness: 'Left' as Handedness,
        x: leftX,
        y: leftY,
        vx: Math.cos(time * 0.34) * 0.03,
        vy: -Math.sin(time * 0.27) * 0.038,
      },
      {
        handedness: 'Right' as Handedness,
        x: rightX,
        y: rightY,
        vx: -Math.sin(time * 0.29) * 0.032,
        vy: Math.cos(time * 0.31) * 0.036,
      },
    ]

    for (const emitter of emitters) {
      if (!dyeOnly) {
        this.runSplat(resources.velocity, emitter.x, emitter.y, [
          emitter.vx * tuning.splatVelocity * wake,
          emitter.vy * tuning.splatVelocity * wake,
          0,
        ], radius)
      }

      const color = HAND_COLORS[emitter.handedness]
      const intensity = tuning.colorIntensity * 0.1 * wake
      this.runSplat(resources.dye, emitter.x, emitter.y, [
        color[0] * intensity,
        color[1] * intensity,
        color[2] * intensity,
      ], radius * 0.72)
    }
  }

  private runSplat(target: DoubleFBO, x: number, y: number, color: [number, number, number], radius: number) {
    const gl = this.gl
    this.useProgram(this.programs.splat)
    this.bindTexture(target.read.texture, 0)
    gl.uniform1i(this.programs.splat.uniforms.uTarget, 0)
    gl.uniform2f(this.programs.splat.uniforms.uPoint, x, y)
    gl.uniform3f(this.programs.splat.uniforms.uColor, color[0], color[1], color[2])
    gl.uniform1f(this.programs.splat.uniforms.uRadius, radius)
    gl.uniform1f(this.programs.splat.uniforms.uAspect, this.width / this.height)
    this.drawTo(target.write)
    target.swap()
  }

  private runAdvection(target: DoubleFBO, velocityTexture: WebGLTexture, dt: number, dissipation: number) {
    const gl = this.gl
    this.useProgram(this.programs.advection)
    this.bindTexture(velocityTexture, 0)
    this.bindTexture(target.read.texture, 1)
    gl.uniform1i(this.programs.advection.uniforms.uVelocity, 0)
    gl.uniform1i(this.programs.advection.uniforms.uSource, 1)
    gl.uniform1f(this.programs.advection.uniforms.uDt, dt)
    gl.uniform1f(this.programs.advection.uniforms.uDissipation, dissipation)
    this.drawTo(target.write)
    target.swap()
  }

  private runViscosity(target: DoubleFBO, strength: number) {
    const gl = this.gl
    this.useProgram(this.programs.viscosity)
    this.bindTexture(target.read.texture, 0)
    gl.uniform1i(this.programs.viscosity.uniforms.uVelocity, 0)
    gl.uniform2f(this.programs.viscosity.uniforms.uTexelSize, 1 / target.read.width, 1 / target.read.height)
    gl.uniform1f(this.programs.viscosity.uniforms.uStrength, strength)
    this.drawTo(target.write)
    target.swap()
  }

  private runCurl(velocityTexture: WebGLTexture, output: SingleFBO) {
    const gl = this.gl
    this.useProgram(this.programs.curl)
    this.bindTexture(velocityTexture, 0)
    gl.uniform1i(this.programs.curl.uniforms.uVelocity, 0)
    gl.uniform2f(this.programs.curl.uniforms.uTexelSize, 1 / output.width, 1 / output.height)
    this.drawTo(output)
  }

  private runVorticity(target: DoubleFBO, curlTexture: WebGLTexture, dt: number) {
    const gl = this.gl
    this.useProgram(this.programs.vorticity)
    this.bindTexture(target.read.texture, 0)
    this.bindTexture(curlTexture, 1)
    gl.uniform1i(this.programs.vorticity.uniforms.uVelocity, 0)
    gl.uniform1i(this.programs.vorticity.uniforms.uCurl, 1)
    gl.uniform2f(this.programs.vorticity.uniforms.uTexelSize, 1 / target.read.width, 1 / target.read.height)
    gl.uniform1f(this.programs.vorticity.uniforms.uCurlStrength, this.tuning.vorticity)
    gl.uniform1f(this.programs.vorticity.uniforms.uDt, dt)
    this.drawTo(target.write)
    target.swap()
  }

  private runDivergence(velocityTexture: WebGLTexture, output: SingleFBO) {
    const gl = this.gl
    this.useProgram(this.programs.divergence)
    this.bindTexture(velocityTexture, 0)
    gl.uniform1i(this.programs.divergence.uniforms.uVelocity, 0)
    gl.uniform2f(this.programs.divergence.uniforms.uTexelSize, 1 / output.width, 1 / output.height)
    this.drawTo(output)
  }

  private runClear(target: DoubleFBO, value: number) {
    const gl = this.gl
    this.useProgram(this.programs.clear)
    this.bindTexture(target.read.texture, 0)
    gl.uniform1i(this.programs.clear.uniforms.uTexture, 0)
    gl.uniform1f(this.programs.clear.uniforms.uValue, value)
    this.drawTo(target.write)
    target.swap()
  }

  private runPressure(target: DoubleFBO, divergenceTexture: WebGLTexture) {
    const gl = this.gl
    this.useProgram(this.programs.pressure)
    this.bindTexture(target.read.texture, 0)
    this.bindTexture(divergenceTexture, 1)
    gl.uniform1i(this.programs.pressure.uniforms.uPressure, 0)
    gl.uniform1i(this.programs.pressure.uniforms.uDivergence, 1)
    gl.uniform2f(this.programs.pressure.uniforms.uTexelSize, 1 / target.read.width, 1 / target.read.height)
    this.drawTo(target.write)
    target.swap()
  }

  private runGradientSubtract(target: DoubleFBO, pressureTexture: WebGLTexture) {
    const gl = this.gl
    this.useProgram(this.programs.gradientSubtract)
    this.bindTexture(target.read.texture, 0)
    this.bindTexture(pressureTexture, 1)
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uVelocity, 0)
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uPressure, 1)
    gl.uniform2f(this.programs.gradientSubtract.uniforms.uTexelSize, 1 / target.read.width, 1 / target.read.height)
    this.drawTo(target.write)
    target.swap()
  }

  private createProgram(vertexSource: string, fragmentSource: string, uniforms: string[]): ProgramInfo {
    const gl = this.gl
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource)
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource)
    const program = assertResource(gl.createProgram(), 'Unable to create WebGL program')

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? 'Unknown program link error'
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      throw new Error(message)
    }

    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)

    return {
      program,
      uniforms: Object.fromEntries(uniforms.map((uniform) => [uniform, gl.getUniformLocation(program, uniform)])),
    }
  }

  private compileShader(type: number, source: string) {
    const gl = this.gl
    const shader = assertResource(gl.createShader(type), 'Unable to create shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error'
      gl.deleteShader(shader)
      throw new Error(message)
    }

    return shader
  }

  private createFullscreenQuad() {
    const gl = this.gl
    const vao = assertResource(gl.createVertexArray(), 'Unable to create vertex array')
    const buffer = assertResource(gl.createBuffer(), 'Unable to create vertex buffer')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    return vao
  }

  private useProgram(program: ProgramInfo) {
    this.gl.useProgram(program.program)
    this.gl.bindVertexArray(this.quadVao)
  }

  private bindTexture(texture: WebGLTexture, unit: number) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit)
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture)
  }

  private drawTo(target: SingleFBO) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer)
    this.gl.viewport(0, 0, target.width, target.height)
    this.draw()
  }

  private draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4)
  }
}
