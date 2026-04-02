import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  CAMERA_CONSTRAINTS,
  DEFAULT_FLUID_TUNING,
  ENGINE_PARAMS,
  FLUID_TUNING_PRESETS,
  type FluidTuning,
} from '../lib/config/params'
import { FluidEngine } from '../lib/fluid/fluidEngine'
import {
  HandTracker,
  type TrackedHand,
  type TrackingMode,
} from '../lib/hands/handTracker'
import { MouseHandSimulator } from '../lib/hands/mouseSimulator'

type Language = 'zh' | 'en'
type StageMessageKey = 'preparing' | 'booting' | 'camera' | 'model' | 'ready' | 'error'
type PresetKey = keyof typeof FLUID_TUNING_PRESETS
type ActivePreset = PresetKey | 'Custom'

interface StageState {
  mode: 'loading' | 'ready' | 'error'
  key: StageMessageKey
  errorMessage?: string
}

interface ParameterHelpCopy {
  summary: string
  effect: string
}

interface LanguageCopy {
  brand: string
  status: Record<StageMessageKey, string>
  statusPrefix: string
  buttons: {
    help: string
    tuning: string
    mouse: string
    close: string
    reset: string
  }
  language: {
    zh: string
    en: string
  }
  tracking: {
    precision: string
    stable: string
  }
  tuning: {
    kicker: string
    title: string
    note: string
    controls: Record<keyof FluidTuning, string>
    presets: Record<PresetKey | 'Custom', string>
  }
  help: {
    kicker: string
    title: string
    sections: {
      quickStart: string
      colorLogic: string
      parameters: string
      tips: string
    }
    quickStart: string[]
    colorLogic: string[]
    parameters: Record<keyof FluidTuning, ParameterHelpCopy>
    tips: string[]
    footer: string
  }
}

const PRESET_KEYS = Object.keys(FLUID_TUNING_PRESETS) as PresetKey[]

const CONTROL_CONFIGS: Array<{
  key: keyof FluidTuning
  min: number
  max: number
  step: number
}> = [
  { key: 'viscosity', min: 0.02, max: 0.45, step: 0.01 },
  { key: 'dyeDissipation', min: 0.985, max: 0.999, step: 0.001 },
  { key: 'velocityDissipation', min: 0.975, max: 0.997, step: 0.001 },
  { key: 'splatRadius', min: 0.004, max: 0.026, step: 0.001 },
  { key: 'splatVelocity', min: 0.1, max: 0.5, step: 0.01 },
  { key: 'bloomStrength', min: 0.6, max: 1.8, step: 0.01 },
  { key: 'colorIntensity', min: 0.6, max: 1.8, step: 0.01 },
  { key: 'vorticity', min: 4, max: 28, step: 1 },
]

const PARAMETER_ORDER: Array<keyof FluidTuning> = CONTROL_CONFIGS.map((item) => item.key)

const COPY: Record<Language, LanguageCopy> = {
  zh: {
    brand: 'The Silk Weaver',
    status: {
      preparing: '正在准备流体舞台',
      booting: '正在启动 WebGL 丝绸场',
      camera: '正在请求镜像前置摄像头',
      model: '正在加载手部追踪模型',
      ready: '挥动双手食指开始编织流场',
      error: '启动失败',
    },
    statusPrefix: '错误：',
    buttons: {
      help: '怎么玩',
      tuning: '调参数',
      mouse: '鼠标模拟',
      close: '关闭',
      reset: '重置为丝绸默认',
    },
    language: {
      zh: '中文',
      en: 'EN',
    },
    tracking: {
      precision: '指尖',
      stable: '掌心/拳头',
    },
    tuning: {
      kicker: '实时调参',
      title: 'Silk 响应面板',
      note: '左手蓝 / 右手紫',
      controls: {
        viscosity: '粘度',
        dyeDissipation: '颜色拖尾',
        velocityDissipation: '流动保留',
        splatRadius: '丝带宽度',
        splatVelocity: '手势力度',
        colorIntensity: '颜色能量',
        bloomStrength: '辉光强度',
        vorticity: '卷曲程度',
      },
      presets: {
        Silk: '丝绸',
        Ribbon: '缎带',
        Pulse: '脉冲',
        Custom: '自定义',
      },
    },
    help: {
      kicker: '极简导览',
      title: 'The Silk Weaver 怎么玩',
      sections: {
        quickStart: '开始方式',
        colorLogic: '颜色逻辑',
        parameters: '参数说明',
        tips: '快速调参建议',
      },
      quickStart: [
        '允许摄像头权限，站在镜头前像照镜子一样操作。',
        '输入模式可切换为指尖精细模式，或更稳定的掌心/拳头模式。',
        '抬起双手并在空中移动，系统会把你当前模式对应的位置和速度注入流体。',
        '打开鼠标模拟后，按住左键代表左手，按住右键代表右手。',
        '快挥会产生更强、更宽的丝带；慢挥会产生更柔和的线条。',
      ],
      colorLogic: [
        '左手持续注入霓虹蓝，右手持续注入极光紫。',
        '双手交汇时颜色会在流场中自然混合，而不是硬切。',
      ],
      parameters: {
        viscosity: {
          summary: '控制流体有多像布料和丝绸。',
          effect: '越高越柔顺、越拉丝；越低越像烟或能量流。',
        },
        dyeDissipation: {
          summary: '控制颜色在画面里停留多久。',
          effect: '越高拖尾越长；越低画面清得更快。',
        },
        velocityDissipation: {
          summary: '控制动作能量在流场里保留多久。',
          effect: '越高惯性越强；越低流动停得更快。',
        },
        splatRadius: {
          summary: '控制每次手势注入的范围。',
          effect: '越高丝带越厚；越低丝线越细。',
        },
        splatVelocity: {
          summary: '控制手指速度转成流体推动力的强度。',
          effect: '越高反应越猛；越低更安静。',
        },
        colorIntensity: {
          summary: '控制每次注入的颜色密度。',
          effect: '越高颜色越亮越饱和；越低更空灵。',
        },
        bloomStrength: {
          summary: '控制发光和辉光叠加强度。',
          effect: '越高越有自发光感；太高会偏白。',
        },
        vorticity: {
          summary: '控制丝带内部的卷曲和涡旋细节。',
          effect: '越高越翻卷；越低越平滑。',
        },
      },
      tips: [
        '想更像丝绸：提高粘度和颜色拖尾，稍微降低手势力度。',
        '想更像霓虹能量：提高卷曲、辉光和手势力度。',
        '想让画面更干净：降低丝带宽度、颜色拖尾和辉光。',
      ],
      footer: '快捷键：按 H 打开玩法说明，按 T 打开调参面板，按 M 切换鼠标模拟，按 Esc 关闭当前面板。',
    },
  },
  en: {
    brand: 'The Silk Weaver',
    status: {
      preparing: 'Preparing fluid stage',
      booting: 'Booting WebGL silk field',
      camera: 'Requesting mirrored front camera',
      model: 'Loading hand landmark model',
      ready: 'Move both index fingers to weave the field',
      error: 'Startup failed',
    },
    statusPrefix: 'Error:',
    buttons: {
      help: 'How to play',
      tuning: 'Tune silk',
      mouse: 'Mouse sim',
      close: 'Close',
      reset: 'Reset to Silk',
    },
    language: {
      zh: '中文',
      en: 'EN',
    },
    tracking: {
      precision: 'Precision',
      stable: 'Stable',
    },
    tuning: {
      kicker: 'Live tuning',
      title: 'Silk response',
      note: 'Left blue / Right violet',
      controls: {
        viscosity: 'Viscosity',
        dyeDissipation: 'Dye trail',
        velocityDissipation: 'Flow hold',
        splatRadius: 'Ribbon width',
        splatVelocity: 'Gesture force',
        colorIntensity: 'Color charge',
        bloomStrength: 'Glow',
        vorticity: 'Swirl',
      },
      presets: {
        Silk: 'Silk',
        Ribbon: 'Ribbon',
        Pulse: 'Pulse',
        Custom: 'Custom',
      },
    },
    help: {
      kicker: 'Exhibit guide',
      title: 'How to play The Silk Weaver',
      sections: {
        quickStart: 'Quick start',
        colorLogic: 'Color logic',
        parameters: 'Parameter guide',
        tips: 'Quick tuning ideas',
      },
      quickStart: [
        'Allow camera access and face the preview like a mirror.',
        'Switch between fingertip precision mode and a more stable palm/fist mode.',
        'Move both hands through the air and the active mode will inject its tracked position and velocity into the field.',
        'With mouse simulation enabled, hold the left button for the left hand and the right button for the right hand.',
        'Fast gestures create stronger, wider ribbons; slower gestures produce softer silk lines.',
      ],
      colorLogic: [
        'The left hand injects neon blue and the right hand injects aurora violet.',
        'When both hands cross, the colors blend naturally inside the fluid instead of switching hard.',
      ],
      parameters: {
        viscosity: {
          summary: 'Controls how cloth-like and smooth the fluid feels.',
          effect: 'Higher values feel softer and more ribbon-like; lower values feel smokier or more electric.',
        },
        dyeDissipation: {
          summary: 'Controls how long color remains visible.',
          effect: 'Higher values keep trails longer; lower values clear the frame faster.',
        },
        velocityDissipation: {
          summary: 'Controls how long motion energy stays in the field.',
          effect: 'Higher values preserve inertia; lower values let the flow settle sooner.',
        },
        splatRadius: {
          summary: 'Controls the size of each fingertip injection.',
          effect: 'Higher values create thicker bands; lower values create finer filaments.',
        },
        splatVelocity: {
          summary: 'Controls how strongly hand speed drives the fluid.',
          effect: 'Higher values feel punchier; lower values feel calmer.',
        },
        colorIntensity: {
          summary: 'Controls how much color each gesture injects.',
          effect: 'Higher values make the silk brighter and denser; lower values feel more delicate.',
        },
        bloomStrength: {
          summary: 'Controls the amount of glow layered on top of the silk.',
          effect: 'Higher values feel more self-lit; too much can wash toward white.',
        },
        vorticity: {
          summary: 'Controls local curl and vortex detail.',
          effect: 'Higher values add more twisting eddies; lower values stay smoother and calmer.',
        },
      },
      tips: [
        'For softer silk: raise Viscosity and Dye trail, then lower Gesture force slightly.',
        'For neon energy: raise Swirl, Glow, and Gesture force.',
        'For cleaner composition: reduce Ribbon width, Dye trail, and Glow a little.',
      ],
      footer: 'Hotkeys: press H for help, T for tuning, M for mouse simulation, and Esc to close the current panel.',
    },
  },
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown startup error'
}

function formatTuningValue(key: keyof FluidTuning, value: number) {
  return key === 'vorticity' ? value.toFixed(0) : value.toFixed(3)
}

export function SilkWeaverStage() {
  const stageRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const engineRef = useRef<FluidEngine | null>(null)
  const mouseSimulatorRef = useRef(new MouseHandSimulator())
  const mouseModeRef = useRef(false)
  const trackingModeRef = useRef<TrackingMode>('stable')
  const tuningRef = useRef<FluidTuning>({ ...DEFAULT_FLUID_TUNING })
  const [language, setLanguage] = useState<Language>('zh')
  const [stageState, setStageState] = useState<StageState>({
    mode: 'loading',
    key: 'preparing',
  })
  const [helpOpen, setHelpOpen] = useState(false)
  const [tuningOpen, setTuningOpen] = useState(false)
  const [mouseMode, setMouseMode] = useState(false)
  const [trackingMode, setTrackingMode] = useState<TrackingMode>('stable')
  const [activePreset, setActivePreset] = useState<ActivePreset>('Silk')
  const [tuning, setTuning] = useState<FluidTuning>({ ...DEFAULT_FLUID_TUNING })

  const copy = COPY[language]

  const stageMessage = useMemo(() => {
    if (stageState.mode === 'error' && stageState.errorMessage) {
      return `${copy.statusPrefix} ${stageState.errorMessage}`
    }

    return copy.status[stageState.key]
  }, [copy, stageState])

  useEffect(() => {
    tuningRef.current = tuning
    engineRef.current?.setTuning(tuning)
  }, [tuning])

  useEffect(() => {
    if (!mouseMode) {
      mouseSimulatorRef.current.releaseAll()
    }

    mouseModeRef.current = mouseMode
  }, [mouseMode])

  useEffect(() => {
    trackingModeRef.current = trackingMode
  }, [trackingMode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHelpOpen(false)
        setTuningOpen(false)
      }

      if (event.key.toLowerCase() === 'h') {
        setTuningOpen(false)
        setHelpOpen((open) => !open)
      }

      if (event.key.toLowerCase() === 't') {
        setHelpOpen(false)
        setTuningOpen((open) => !open)
      }

      if (event.key.toLowerCase() === 'm') {
        setMouseMode((enabled) => !enabled)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const openHelp = () => {
    setTuningOpen(false)
    setHelpOpen(true)
  }

  const openTuning = () => {
    setHelpOpen(false)
    setTuningOpen(true)
  }

  const updateTuning = (key: keyof FluidTuning, value: number) => {
    setActivePreset('Custom')
    setTuning((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const applyPreset = (presetName: PresetKey) => {
    const preset = FLUID_TUNING_PRESETS[presetName]
    setActivePreset(presetName)
    setTuning({ ...preset })
  }

  const resetTuning = () => {
    setActivePreset('Silk')
    setTuning({ ...DEFAULT_FLUID_TUNING })
  }

  const syncMouseHands = (event: ReactPointerEvent<HTMLElement>) => {
    if (!mouseMode || !stageRef.current) {
      return
    }

    if (
      event.target instanceof HTMLElement &&
      event.target.closest(
        '.silk-weaver__chrome, .silk-weaver__overlay-backdrop, .silk-weaver__preview',
      )
    ) {
      return
    }

    mouseSimulatorRef.current.syncFromPointer(
      event.nativeEvent,
      stageRef.current.getBoundingClientRect(),
    )
  }

  const releaseMouseHands = () => {
    mouseSimulatorRef.current.releaseAll()
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current

    if (!canvas || !video) {
      return
    }

    let disposed = false
    let animationFrame = 0
    let mediaStream: MediaStream | null = null
    let handTracker: HandTracker | null = null
    let fluidEngine: FluidEngine | null = null
    let lastFrameTime = performance.now()
    let lastDetectionTime = 0
    let trackedHands: TrackedHand[] = []
    let videoFrameCallbackId: number | null = null
    let usesVideoFrameCallback = false

    const resize = () => {
      if (!fluidEngine) {
        return
      }

      fluidEngine.resize(
        window.innerWidth,
        window.innerHeight,
        Math.min(window.devicePixelRatio || 1, ENGINE_PARAMS.maxPixelRatio),
      )
    }

    const animate = (time: number) => {
      if (disposed) {
        return
      }

      const dt = (time - lastFrameTime) / 1000
      lastFrameTime = time

      if (
        !usesVideoFrameCallback &&
        handTracker &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        time - lastDetectionTime >= 1000 / ENGINE_PARAMS.detectionFps
      ) {
        trackedHands = handTracker.detect(video, time, trackingModeRef.current)
        lastDetectionTime = time
      }

      const simulatedHands = mouseModeRef.current
        ? mouseSimulatorRef.current.getHands(time)
        : []
      fluidEngine?.step(dt, [...trackedHands, ...simulatedHands])
      animationFrame = window.requestAnimationFrame(animate)
    }

    const scheduleVideoTracking = () => {
      if (!handTracker || disposed || typeof video.requestVideoFrameCallback !== 'function') {
        usesVideoFrameCallback = false
        return
      }

      usesVideoFrameCallback = true
      const tracker = handTracker

      const detectOnVideoFrame = (now: number) => {
        if (disposed) {
          return
        }

        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          trackedHands = tracker.detect(video, now, trackingModeRef.current)
        }

        videoFrameCallbackId = video.requestVideoFrameCallback(detectOnVideoFrame)
      }

      videoFrameCallbackId = video.requestVideoFrameCallback(detectOnVideoFrame)
    }

    const start = async () => {
      try {
        setStageState({ mode: 'loading', key: 'booting' })
        fluidEngine = new FluidEngine(canvas)
        fluidEngine.setTuning(tuningRef.current)
        engineRef.current = fluidEngine
        resize()

        try {
          setStageState({ mode: 'loading', key: 'camera' })
          mediaStream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)

          if (disposed) {
            return
          }

          video.srcObject = mediaStream
          await video.play()

          setStageState({ mode: 'loading', key: 'model' })
          handTracker = new HandTracker()
          await handTracker.init()

          if (disposed) {
            return
          }

          scheduleVideoTracking()
          setStageState({ mode: 'ready', key: 'ready' })
        } catch (error) {
          setStageState({
            mode: 'error',
            key: 'error',
            errorMessage: formatError(error),
          })
        }

        resize()
        lastFrameTime = performance.now()
        animationFrame = window.requestAnimationFrame(animate)
        window.addEventListener('resize', resize)
      } catch (error) {
        setStageState({ mode: 'error', key: 'error', errorMessage: formatError(error) })
      }
    }

    void start()

    return () => {
      disposed = true
      window.cancelAnimationFrame(animationFrame)
      if (
        videoFrameCallbackId !== null &&
        typeof video.cancelVideoFrameCallback === 'function'
      ) {
        video.cancelVideoFrameCallback(videoFrameCallbackId)
      }
      window.removeEventListener('resize', resize)
      handTracker?.destroy()
      fluidEngine?.destroy()
      engineRef.current = null

      for (const track of mediaStream?.getTracks() ?? []) {
        track.stop()
      }
    }
  }, [])

  return (
    <main
      ref={stageRef}
      className="silk-weaver"
      onPointerDown={syncMouseHands}
      onPointerMove={syncMouseHands}
      onPointerUp={syncMouseHands}
      onPointerCancel={releaseMouseHands}
      onPointerLeave={releaseMouseHands}
      onContextMenu={mouseMode ? (event) => event.preventDefault() : undefined}
    >
      <canvas ref={canvasRef} className="silk-weaver__canvas" aria-hidden="true" />

      <div className="silk-weaver__intro" aria-hidden="true">
        <span className="silk-weaver__intro-text">by week</span>
      </div>

      <video
        ref={videoRef}
        className="silk-weaver__preview"
        muted
        playsInline
        autoPlay
      />

      <section className="silk-weaver__chrome" aria-live="polite">
        <div className="silk-weaver__brand">
          <p className="silk-weaver__eyebrow">{copy.brand}</p>
          <p className={`silk-weaver__status silk-weaver__status--${stageState.mode}`}>
            {stageMessage}
          </p>
        </div>

        <div className="silk-weaver__action-row">
          <div className="silk-weaver__language-switch" role="group" aria-label="Language">
            <button
              type="button"
              className={`silk-weaver__language-button ${language === 'zh' ? 'is-active' : ''}`}
              onClick={() => setLanguage('zh')}
            >
              {copy.language.zh}
            </button>
            <button
              type="button"
              className={`silk-weaver__language-button ${language === 'en' ? 'is-active' : ''}`}
              onClick={() => setLanguage('en')}
            >
              {copy.language.en}
            </button>
          </div>

          <div className="silk-weaver__mode-switch" role="group" aria-label="Tracking mode">
            <button
              type="button"
              className={`silk-weaver__mode-button ${trackingMode === 'precision' ? 'is-active' : ''}`}
              onClick={() => setTrackingMode('precision')}
            >
              {copy.tracking.precision}
            </button>
            <button
              type="button"
              className={`silk-weaver__mode-button ${trackingMode === 'stable' ? 'is-active' : ''}`}
              onClick={() => setTrackingMode('stable')}
            >
              {copy.tracking.stable}
            </button>
          </div>

          <button type="button" className="silk-weaver__action" onClick={openHelp}>
            {copy.buttons.help}
          </button>

          <button
            type="button"
            className={`silk-weaver__action ${mouseMode ? 'is-active' : ''}`}
            onClick={() => setMouseMode((enabled) => !enabled)}
          >
            {copy.buttons.mouse}
          </button>

          <button type="button" className="silk-weaver__action" onClick={openTuning}>
            {copy.buttons.tuning}
          </button>
        </div>
      </section>

      <p className="silk-weaver__credit">created by week&amp;AI</p>

      {helpOpen ? (
        <div className="silk-weaver__overlay-backdrop" onClick={() => setHelpOpen(false)}>
          <section
            className="silk-weaver__sheet silk-weaver__sheet--help"
            role="dialog"
            aria-modal="true"
            aria-labelledby="silk-weaver-help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="silk-weaver__sheet-head">
              <div>
                <p className="silk-weaver__sheet-kicker">{copy.help.kicker}</p>
                <h2 id="silk-weaver-help-title">{copy.help.title}</h2>
              </div>
              <button type="button" className="silk-weaver__sheet-close" onClick={() => setHelpOpen(false)}>
                {copy.buttons.close}
              </button>
            </div>

            <section className="silk-weaver__help-section">
              <h3>{copy.help.sections.quickStart}</h3>
              <div className="silk-weaver__micro-list">
                {copy.help.quickStart.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </section>

            <section className="silk-weaver__help-section">
              <h3>{copy.help.sections.colorLogic}</h3>
              <div className="silk-weaver__micro-list">
                {copy.help.colorLogic.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </section>

            <section className="silk-weaver__help-section">
              <h3>{copy.help.sections.parameters}</h3>
              <div className="silk-weaver__parameter-list">
                {PARAMETER_ORDER.map((key) => (
                  <article key={key} className="silk-weaver__parameter-card">
                    <h4>{copy.tuning.controls[key]}</h4>
                    <p>{copy.help.parameters[key].summary}</p>
                    <p>{copy.help.parameters[key].effect}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="silk-weaver__help-section">
              <h3>{copy.help.sections.tips}</h3>
              <div className="silk-weaver__micro-list">
                {copy.help.tips.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </section>

            <p className="silk-weaver__help-footer">{copy.help.footer}</p>
          </section>
        </div>
      ) : null}

      {tuningOpen ? (
        <div className="silk-weaver__overlay-backdrop" onClick={() => setTuningOpen(false)}>
          <section
            className="silk-weaver__sheet silk-weaver__sheet--tuning"
            role="dialog"
            aria-modal="true"
            aria-labelledby="silk-weaver-tuning-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="silk-weaver__sheet-head">
              <div>
                <p className="silk-weaver__sheet-kicker">{copy.tuning.kicker}</p>
                <h2 id="silk-weaver-tuning-title">{copy.tuning.title}</h2>
              </div>
              <button type="button" className="silk-weaver__sheet-close" onClick={() => setTuningOpen(false)}>
                {copy.buttons.close}
              </button>
            </div>

            <div className="silk-weaver__sheet-toolbar">
              <span className="silk-weaver__sheet-note">{copy.tuning.note}</span>
              <button type="button" className="silk-weaver__ghost-button" onClick={resetTuning}>
                {copy.buttons.reset}
              </button>
            </div>

            <div className="silk-weaver__preset-row">
              {PRESET_KEYS.map((presetName) => (
                <button
                  key={presetName}
                  type="button"
                  className={`silk-weaver__preset ${activePreset === presetName ? 'is-active' : ''}`}
                  onClick={() => applyPreset(presetName)}
                >
                  {copy.tuning.presets[presetName]}
                </button>
              ))}

              {activePreset === 'Custom' ? (
                <span className="silk-weaver__preset silk-weaver__preset--static">
                  {copy.tuning.presets.Custom}
                </span>
              ) : null}
            </div>

            <div className="silk-weaver__controls">
              {CONTROL_CONFIGS.map((control) => (
                <label key={control.key} className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.tuning.controls[control.key]}</span>
                    <strong>{formatTuningValue(control.key, tuning[control.key])}</strong>
                  </span>
                  <input
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={tuning[control.key]}
                    onChange={(event) => updateTuning(control.key, Number(event.currentTarget.value))}
                  />
                </label>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
