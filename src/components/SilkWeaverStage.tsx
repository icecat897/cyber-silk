import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
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

interface ScreenPulse {
  id: number
  x: number
  y: number
  primary: string
  secondary: string
}

interface HeartBurst {
  id: number
  x: number
  y: number
  color: string
  size: number
}

interface GestureEffects {
  fistPulse: boolean
  snapHeart: boolean
}

type SnapAudioState = 'idle' | 'requesting' | 'ready' | 'denied' | 'error'

interface AudioMonitor {
  level: number
  average: number
  attack: number
  transient: boolean
  contextState: string
}

interface AudioThresholds {
  level: number
  average: number
  attack: number
  cooldownMs: number
}

interface AudioTrackInfo {
  label: string
  muted: boolean
  enabled: boolean
  readyState: string
}

interface AudioInputOption {
  deviceId: string
  label: string
}

type StartupIssueKind =
  | 'webgl'
  | 'float'
  | 'cameraDenied'
  | 'cameraMissing'
  | 'cameraBusy'
  | 'model'
  | 'generic'

interface StartupErrorCopy {
  title: string
  detailLabel: string
  tips: Record<StartupIssueKind, string[]>
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
  effects: {
    title: string
    fistPulse: string
    snapHeart: string
    micStatus: Record<SnapAudioState, string>
    meterLabel: string
    transientReady: string
    transientIdle: string
    contextLabel: string
    trackLabel: string
    deviceLabel: string
    devicePlaceholder: string
    refreshDevices: string
    thresholdTitle: string
    thresholdLabels: {
      level: string
      average: string
      attack: string
      cooldownMs: string
    }
    heartSize: string
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
  startupError: StartupErrorCopy
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

const DEFAULT_AUDIO_THRESHOLDS: AudioThresholds = {
  level: 0.5,
  average: 0.6,
  attack: 0.05,
  cooldownMs: 260,
}

const DEFAULT_HEART_BURST_SIZE = 5.6

const COPY: Record<Language, LanguageCopy> = {
  zh: {
    brand: 'The Silk Weaver',
    status: {
      preparing: '正在准备流体舞台',
      booting: '正在启动 WebGL 丝绸场',
      camera: '正在请求镜像前置摄像头',
      model: '正在加载手部追踪模型',
      ready: '挥动双手开始编织流场',
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
    effects: {
      title: '动作特效',
      fistPulse: '握拳丝结',
      snapHeart: '响指爱心',
      micStatus: {
        idle: '开启响指爱心后会请求麦克风，只根据响指瞬态声音触发爱心。',
        requesting: '正在请求麦克风权限...',
        ready: '麦克风已连接。检测到清脆响指声时，会在当前掌心附近出现爱心。',
        denied: '麦克风未授权，响指爱心目前不会触发。',
        error: '麦克风初始化失败，响指爱心目前不可用。',
      },
      meterLabel: '响指音频输入',
      transientReady: '已捕捉到爆裂瞬态',
      transientIdle: '等待爆裂瞬态',
      contextLabel: '音频上下文',
      trackLabel: '输入轨道',
      deviceLabel: '麦克风设备',
      devicePlaceholder: '使用浏览器默认输入',
      refreshDevices: '刷新设备',
      thresholdTitle: '响指阈值',
      thresholdLabels: {
        level: '爆裂强度',
        average: '环境噪声上限',
        attack: '瞬态攻击',
        cooldownMs: '触发冷却',
      },
      heartSize: '爱心大小',
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
        '可在调参面板中单独开启握拳丝结或响指爱心。',
        '在掌心/拳头模式下，张开的手迅速握拳会触发一次高亮变色丝结，并带出一瞬屏幕扫光。',
        '开启响指爱心后，只要检测到清脆的响指爆裂声，就会在当前最稳定的掌心附近放出一个爱心。',
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
    startupError: {
      title: '当前设备没有成功启动 Silk 舞台',
      detailLabel: '技术信息',
      tips: {
        webgl: [
          '当前浏览器不支持 WebGL2，建议改用最新版 Chrome 或 Edge。',
          '如果你是在微信内置浏览器、远程桌面或虚拟机里打开，换到本机浏览器再试。',
        ],
        float: [
          '浏览器很可能关闭了硬件加速，请在设置里开启“使用硬件加速”后重启浏览器。',
          '如果还是不行，通常是显卡驱动过旧，或当前设备不支持这个 WebGL 浮点渲染能力。',
        ],
        cameraDenied: [
          '页面需要摄像头权限来追踪手势，请在地址栏里允许摄像头访问后刷新页面。',
          '如果暂时不方便开摄像头，也可以先打开“鼠标模拟”体验交互。',
        ],
        cameraMissing: [
          '浏览器没有找到可用摄像头，请确认电脑接了摄像头，或者系统里没有禁用它。',
          '外接摄像头时，重新插拔后刷新页面通常更稳。',
        ],
        cameraBusy: [
          '摄像头可能正被别的软件占用，比如会议软件、录像软件或另一个浏览器标签页。',
          '关闭占用摄像头的软件后刷新页面，再重新授权。',
        ],
        model: [
          '手势模型资源没有正常加载，可能是网络拦截、缓存异常或部署资源缺失。',
          '请先强制刷新页面；如果问题仍在，换个网络或稍后再试。',
        ],
        generic: [
          '请先刷新页面重试一次。',
          '如果还是只有 UI 没有流动背景，优先检查浏览器是否开启了硬件加速，并改用最新版 Chrome 或 Edge。',
        ],
      },
    },
  },
  en: {
    brand: 'The Silk Weaver',
    status: {
      preparing: 'Preparing fluid stage',
      booting: 'Booting WebGL silk field',
      camera: 'Requesting mirrored front camera',
      model: 'Loading hand landmark model',
      ready: 'Move both hands to weave the field',
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
    effects: {
      title: 'Gesture FX',
      fistPulse: 'Fist knot',
      snapHeart: 'Snap heart',
      micStatus: {
        idle: 'Enabling snap heart will request microphone access and trigger hearts from the snap transient alone.',
        requesting: 'Requesting microphone access...',
        ready: 'Microphone connected. A clean snap transient will spawn a heart near the currently tracked palm.',
        denied: 'Microphone access denied. Snap heart is currently disabled.',
        error: 'Microphone setup failed. Snap heart is currently unavailable.',
      },
      meterLabel: 'Snap audio input',
      transientReady: 'Transient captured',
      transientIdle: 'Waiting for transient',
      contextLabel: 'Audio context',
      trackLabel: 'Input track',
      deviceLabel: 'Microphone device',
      devicePlaceholder: 'Use browser default input',
      refreshDevices: 'Refresh devices',
      thresholdTitle: 'Snap thresholds',
      thresholdLabels: {
        level: 'Burst level',
        average: 'Noise ceiling',
        attack: 'Transient attack',
        cooldownMs: 'Cooldown',
      },
      heartSize: 'Heart size',
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
        'Use the tuning panel to enable the fist knot and snap heart effects independently.',
        'In palm/fist mode, snapping an open hand into a fist triggers a bright color-shift silk knot with a brief screen flare.',
        'With snap heart enabled, a clear snap transient alone is enough to release a heart near the currently tracked palm.',
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
    startupError: {
      title: 'This device did not start the Silk stage correctly',
      detailLabel: 'Technical detail',
      tips: {
        webgl: [
          'This browser does not support WebGL2. Try the latest Chrome or Edge.',
          'If you opened this inside an embedded browser, remote desktop session, or virtual machine, switch to a local desktop browser.',
        ],
        float: [
          'Hardware acceleration is likely disabled. Turn it on in browser settings and restart the browser.',
          'If the problem remains, the device or graphics driver may not support the required floating-point WebGL rendering path.',
        ],
        cameraDenied: [
          'Camera permission is required for hand tracking. Allow camera access in the address bar and reload the page.',
          'If camera access is not available right now, you can still try the experience with Mouse sim.',
        ],
        cameraMissing: [
          'No usable camera was found. Make sure the computer has a camera connected and enabled at the system level.',
          'If you use an external camera, reconnect it and reload the page.',
        ],
        cameraBusy: [
          'The camera is probably in use by another app such as a meeting tool, recorder, or another browser tab.',
          'Close the other app, then reload and grant permission again.',
        ],
        model: [
          'The hand-tracking model did not load correctly. This can be caused by missing deployment assets, cache problems, or network blocking.',
          'Try a hard refresh first. If it still fails, switch networks or try again later.',
        ],
        generic: [
          'Reload the page and try again once.',
          'If the UI appears but the background stays completely still, first check hardware acceleration and try the latest Chrome or Edge.',
        ],
      },
    },
  },
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown startup error'
}

function detectStartupIssue(errorMessage?: string): StartupIssueKind {
  const message = errorMessage?.toLowerCase() ?? ''

  if (message.includes('webgl2 is unavailable')) {
    return 'webgl'
  }

  if (
    message.includes('float render targets are unavailable') ||
    message.includes('hardware acceleration') ||
    message.includes('framebuffer is incomplete')
  ) {
    return 'float'
  }

  if (message.includes('notallowederror') || message.includes('permission denied')) {
    return 'cameraDenied'
  }

  if (
    message.includes('notfounderror') ||
    message.includes('requested device not found') ||
    message.includes('overconstrainederror')
  ) {
    return 'cameraMissing'
  }

  if (
    message.includes('notreadableerror') ||
    message.includes('trackstarterror') ||
    message.includes('could not start video source') ||
    message.includes('device in use')
  ) {
    return 'cameraBusy'
  }

  if (
    message.includes('mediapipe') ||
    message.includes('hand landmark') ||
    message.includes('wasm') ||
    message.includes('fetch')
  ) {
    return 'model'
  }

  return 'generic'
}

function formatTuningValue(key: keyof FluidTuning, value: number) {
  return key === 'vorticity' ? value.toFixed(0) : value.toFixed(3)
}

function isPreferredAudioInput(label: string) {
  return !/virtual|虚拟|stereo mix|mix/i.test(label)
}

function getScreenPulseColors(handedness: TrackedHand['handedness']) {
  return handedness === 'Left'
    ? {
        primary: 'rgba(255, 196, 142, 0.34)',
        secondary: 'rgba(255, 128, 168, 0.16)',
      }
    : {
        primary: 'rgba(142, 236, 255, 0.32)',
        secondary: 'rgba(116, 184, 255, 0.17)',
      }
}

function getHeartBurstColor(handedness: TrackedHand['handedness']) {
  return handedness === 'Left' ? 'rgba(255, 170, 210, 0.95)' : 'rgba(255, 128, 190, 0.95)'
}

export function SilkWeaverStage() {
  const stageRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const engineRef = useRef<FluidEngine | null>(null)
  const mouseSimulatorRef = useRef(new MouseHandSimulator())
  const mouseModeRef = useRef(false)
  const trackingModeRef = useRef<TrackingMode>('stable')
  const gestureEffectsRef = useRef<GestureEffects>({
    fistPulse: false,
    snapHeart: true,
  })
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioGainRef = useRef<GainNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioThresholdsRef = useRef<AudioThresholds>({ ...DEFAULT_AUDIO_THRESHOLDS })
  const lastAudioPeakRef = useRef(0)
  const lastAudioTransientMsRef = useRef(0)
  const trackedHandsForAudioRef = useRef<TrackedHand[]>([])
  const tuningRef = useRef<FluidTuning>({ ...DEFAULT_FLUID_TUNING })
  const screenPulseIdRef = useRef(0)
  const heartBurstIdRef = useRef(0)
  const screenPulseTimeoutsRef = useRef<number[]>([])
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
  const [gestureEffects, setGestureEffects] = useState<GestureEffects>({
    fistPulse: false,
    snapHeart: true,
  })
  const [audioThresholds, setAudioThresholds] = useState<AudioThresholds>({
    ...DEFAULT_AUDIO_THRESHOLDS,
  })
  const [snapAudioState, setSnapAudioState] = useState<SnapAudioState>('idle')
  const [audioInputs, setAudioInputs] = useState<AudioInputOption[]>([])
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('')
  const selectedAudioInputIdRef = useRef('')
  const heartBurstSizeRef = useRef(DEFAULT_HEART_BURST_SIZE)
  const [audioMonitor, setAudioMonitor] = useState<AudioMonitor>({
    level: 0,
    average: 0,
    attack: 0,
    transient: false,
    contextState: 'idle',
  })
  const [audioTrackInfo, setAudioTrackInfo] = useState<AudioTrackInfo>({
    label: '-',
    muted: false,
    enabled: false,
    readyState: 'idle',
  })
  const [heartBurstSize, setHeartBurstSize] = useState(DEFAULT_HEART_BURST_SIZE)
  const [screenPulses, setScreenPulses] = useState<ScreenPulse[]>([])
  const [heartBursts, setHeartBursts] = useState<HeartBurst[]>([])

  const copy = COPY[language]

  const stageMessage = useMemo(() => {
    if (stageState.mode === 'error' && stageState.errorMessage) {
      return `${copy.statusPrefix} ${stageState.errorMessage}`
    }

    return copy.status[stageState.key]
  }, [copy, stageState])

  const startupIssue = useMemo(
    () => detectStartupIssue(stageState.errorMessage),
    [stageState.errorMessage],
  )

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
    gestureEffectsRef.current = gestureEffects
  }, [gestureEffects])

  useEffect(() => {
    audioThresholdsRef.current = audioThresholds
  }, [audioThresholds])

  useEffect(() => {
    selectedAudioInputIdRef.current = selectedAudioInputId
  }, [selectedAudioInputId])

  useEffect(() => {
    heartBurstSizeRef.current = heartBurstSize
  }, [heartBurstSize])

  const emitHeartBurst = useCallback((hand: TrackedHand) => {
    const id = heartBurstIdRef.current
    heartBurstIdRef.current += 1

    setHeartBursts((current) => [
      ...current.slice(-5),
      {
        id,
        x: hand.x,
        y: hand.y,
        color: getHeartBurstColor(hand.handedness),
        size: heartBurstSizeRef.current,
      },
    ])

    const timeout = window.setTimeout(() => {
      setHeartBursts((current) => current.filter((heart) => heart.id !== id))
      screenPulseTimeoutsRef.current = screenPulseTimeoutsRef.current.filter(
        (activeTimeout) => activeTimeout !== timeout,
      )
    }, 900)

    screenPulseTimeoutsRef.current.push(timeout)
  }, [])

  const updateAudioThreshold = (key: keyof AudioThresholds, value: number) => {
    setAudioThresholds((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const refreshAudioInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return ''
    }

    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || '(unlabeled input)',
      }))

    const currentDeviceId = selectedAudioInputIdRef.current
    const nextDeviceId =
      currentDeviceId && inputs.some((input) => input.deviceId === currentDeviceId)
        ? currentDeviceId
        : (inputs.find((input) => isPreferredAudioInput(input.label))?.deviceId ??
          inputs[0]?.deviceId ??
          '')

    setAudioInputs(inputs)
    selectedAudioInputIdRef.current = nextDeviceId
    setSelectedAudioInputId(nextDeviceId)
    return nextDeviceId
  }, [])

  const teardownAudio = useCallback((resetState: boolean) => {
    for (const track of audioStreamRef.current?.getTracks() ?? []) {
      track.stop()
    }

    audioGainRef.current = null
    audioProcessorRef.current = null
    audioStreamRef.current = null
    lastAudioPeakRef.current = 0
    lastAudioTransientMsRef.current = 0
    setAudioMonitor({
      level: 0,
      average: 0,
      attack: 0,
      transient: false,
      contextState: resetState ? 'idle' : audioContextRef.current?.state ?? 'idle',
    })
    setAudioTrackInfo({
      label: '-',
      muted: false,
      enabled: false,
      readyState: resetState ? 'idle' : 'ended',
    })

    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    if (resetState) {
      setSnapAudioState('idle')
    }
  }, [])

  const startSnapAudio = useCallback(async (deviceId = selectedAudioInputIdRef.current) => {
    if (audioProcessorRef.current !== null || snapAudioState === 'requesting') {
      return
    }

    try {
      setSnapAudioState('requesting')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      })

      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const gain = context.createGain()
      const processor = context.createScriptProcessor(2048, 1, 1)
      gain.gain.value = 0
      source.connect(processor)
      processor.connect(gain)
      gain.connect(context.destination)
      await context.resume()

      audioContextRef.current = context
      audioGainRef.current = gain
      audioProcessorRef.current = processor
      audioStreamRef.current = stream
      const primaryTrack = stream.getAudioTracks()[0]
      setSnapAudioState(context.state === 'running' ? 'ready' : 'error')
      await refreshAudioInputs()
      setAudioTrackInfo({
        label: primaryTrack?.label || '(unnamed input)',
        muted: primaryTrack?.muted ?? false,
        enabled: primaryTrack?.enabled ?? false,
        readyState: primaryTrack?.readyState ?? 'unknown',
      })

      processor.onaudioprocess = (event) => {
        const activeContext = audioContextRef.current

        if (!activeContext) {
          return
        }

        const channel = event.inputBuffer.getChannelData(0)
        let peak = 0
        let energy = 0

        for (let index = 0; index < channel.length; index += 1) {
          const sample = channel[index]
          const magnitude = Math.abs(sample)
          energy += sample * sample
          peak = Math.max(peak, magnitude)
        }

        const rms = Math.sqrt(energy / channel.length)
        const scaledLevel = Math.min(1, peak * 16 + rms * 24)
        const scaledAverage = Math.min(1, rms * 18)
        const attack = scaledLevel - lastAudioPeakRef.current
        const now = performance.now()
        const thresholds = audioThresholdsRef.current
        const transientDetected =
          scaledLevel > thresholds.level &&
          scaledAverage < thresholds.average &&
          attack > thresholds.attack &&
          now - lastAudioTransientMsRef.current > thresholds.cooldownMs

        setAudioMonitor({
          level: scaledLevel,
          average: scaledAverage,
          attack,
          transient: transientDetected,
          contextState: activeContext.state,
        })
        setAudioTrackInfo({
          label: primaryTrack?.label || '(unnamed input)',
          muted: primaryTrack?.muted ?? false,
          enabled: primaryTrack?.enabled ?? false,
          readyState: primaryTrack?.readyState ?? 'unknown',
        })

        if (transientDetected) {
          lastAudioTransientMsRef.current = now

          const bestHand = trackedHandsForAudioRef.current
            .filter((hand) => hand.confidence >= 0.35)
            .sort((left, right) => right.confidence - left.confidence)[0]

          if (bestHand) {
            emitHeartBurst(bestHand)
          }
        }

        lastAudioPeakRef.current = scaledLevel * 0.42 + lastAudioPeakRef.current * 0.58
      }
    } catch (error) {
      setSnapAudioState(
        error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'error',
      )
      teardownAudio(false)
    }
  }, [emitHeartBurst, refreshAudioInputs, snapAudioState, teardownAudio])

  useEffect(() => {
    if (gestureEffects.snapHeart && snapAudioState === 'idle') {
      const timeout = window.setTimeout(() => {
        void (async () => {
          const deviceId = await refreshAudioInputs()
          await startSnapAudio(deviceId)
        })()
      }, 0)

      return () => {
        window.clearTimeout(timeout)
      }
    }
  }, [gestureEffects.snapHeart, refreshAudioInputs, snapAudioState, startSnapAudio])

  useEffect(() => {
    return () => {
      for (const timeout of screenPulseTimeoutsRef.current) {
        window.clearTimeout(timeout)
      }

      for (const track of audioStreamRef.current?.getTracks() ?? []) {
        track.stop()
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

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
    void refreshAudioInputs()
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
    setHeartBurstSize(DEFAULT_HEART_BURST_SIZE)
  }

  const emitScreenPulse = (hand: TrackedHand) => {
    const colors = getScreenPulseColors(hand.handedness)
    const id = screenPulseIdRef.current
    screenPulseIdRef.current += 1

    setScreenPulses((current) => [
      ...current.slice(-2),
      {
        id,
        x: hand.x,
        y: hand.y,
        primary: colors.primary,
        secondary: colors.secondary,
      },
    ])

    const timeout = window.setTimeout(() => {
      setScreenPulses((current) => current.filter((pulse) => pulse.id !== id))
      screenPulseTimeoutsRef.current = screenPulseTimeoutsRef.current.filter(
        (activeTimeout) => activeTimeout !== timeout,
      )
    }, 380)

    screenPulseTimeoutsRef.current.push(timeout)
  }

  const toggleGestureEffect = (key: keyof GestureEffects) => {
    if (key === 'snapHeart') {
      if (gestureEffects.snapHeart) {
        teardownAudio(true)
        setGestureEffects((current) => ({
          ...current,
          snapHeart: false,
        }))
        return
      }

      setGestureEffects((current) => ({
        ...current,
        snapHeart: true,
      }))
      return
    }

    setGestureEffects((current) => ({
      ...current,
      [key]: !current[key],
    }))
  }

  const handleAudioInputChange = (deviceId: string) => {
    setSelectedAudioInputId(deviceId)

    if (gestureEffects.snapHeart) {
      teardownAudio(false)
      void startSnapAudio(deviceId)
    }
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

      const processedTrackedHands = trackedHands.map((hand) => ({
        ...hand,
        pulse: gestureEffectsRef.current.fistPulse ? hand.pulse : false,
        snap: false,
      }))

      trackedHandsForAudioRef.current = processedTrackedHands

      for (const hand of processedTrackedHands) {
        if (hand.pulse) {
          emitScreenPulse(hand)
        }
      }

      fluidEngine?.step(dt, [...processedTrackedHands, ...simulatedHands])

      trackedHands = trackedHands.map((hand) =>
        hand.pulse ? { ...hand, pulse: false } : hand,
      )

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

      <div className="silk-weaver__screen-pulses" aria-hidden="true">
        {screenPulses.map((pulse) => (
          <div
            key={pulse.id}
            className="silk-weaver__screen-pulse"
            style={{
              '--pulse-x': `${(pulse.x * 100).toFixed(2)}%`,
              '--pulse-y': `${((1 - pulse.y) * 100).toFixed(2)}%`,
              '--pulse-primary': pulse.primary,
              '--pulse-secondary': pulse.secondary,
            } as CSSProperties}
          />
        ))}

        {heartBursts.map((heart) => (
          <div
            key={heart.id}
            className="silk-weaver__heart-burst"
            style={{
              '--heart-x': `${(heart.x * 100).toFixed(2)}%`,
              '--heart-y': `${((1 - heart.y) * 100).toFixed(2)}%`,
              '--heart-color': heart.color,
              '--heart-size': `${heart.size.toFixed(1)}rem`,
            } as CSSProperties}
          >
            ♥
          </div>
        ))}
      </div>

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

      {stageState.mode === 'error' ? (
        <section className="silk-weaver__error-panel" role="alert" aria-live="assertive">
          <p className="silk-weaver__error-title">{copy.startupError.title}</p>
          <p className="silk-weaver__error-detail-label">{copy.startupError.detailLabel}</p>
          <p className="silk-weaver__error-detail">{stageState.errorMessage ?? copy.status.error}</p>
          <div className="silk-weaver__error-tips">
            {copy.startupError.tips[startupIssue].map((tip) => (
              <p key={tip}>{tip}</p>
            ))}
          </div>
        </section>
      ) : null}

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

            <div className="silk-weaver__effect-panel">
              <p className="silk-weaver__effect-title">{copy.effects.title}</p>
              <div className="silk-weaver__preset-row">
                <button
                  type="button"
                  className={`silk-weaver__preset ${gestureEffects.fistPulse ? 'is-active' : ''}`}
                  onClick={() => toggleGestureEffect('fistPulse')}
                >
                  {copy.effects.fistPulse}
                </button>
                <button
                  type="button"
                  className={`silk-weaver__preset ${gestureEffects.snapHeart ? 'is-active' : ''}`}
                  onClick={() => toggleGestureEffect('snapHeart')}
                >
                  {copy.effects.snapHeart}
                </button>
              </div>
              <p className="silk-weaver__effect-note">{copy.effects.micStatus[snapAudioState]}</p>

              <div className="silk-weaver__audio-device-row">
                <label className="silk-weaver__audio-device-label">
                  <span>{copy.effects.deviceLabel}</span>
                  <select
                    className="silk-weaver__audio-select"
                    value={selectedAudioInputId}
                    onChange={(event) => handleAudioInputChange(event.currentTarget.value)}
                  >
                    <option value="">{copy.effects.devicePlaceholder}</option>
                    {audioInputs.map((input) => (
                      <option key={input.deviceId} value={input.deviceId}>
                        {input.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="silk-weaver__ghost-button"
                  onClick={() => void refreshAudioInputs()}
                >
                  {copy.effects.refreshDevices}
                </button>
              </div>

              <div className="silk-weaver__audio-meter">
                <div className="silk-weaver__audio-meter-row">
                  <span>{copy.effects.meterLabel}</span>
                  <strong>{Math.round(audioMonitor.level * 100)}%</strong>
                </div>

                <div className="silk-weaver__audio-track" aria-hidden="true">
                  <div
                    className={`silk-weaver__audio-fill ${audioMonitor.transient ? 'is-hot' : ''}`}
                    style={{ width: `${Math.min(audioMonitor.level * 100, 100)}%` }}
                  />
                  <div
                    className="silk-weaver__audio-threshold"
                    style={{ left: `${Math.min(audioThresholds.level * 100, 100)}%` }}
                  />
                </div>

                <div className="silk-weaver__audio-meta">
                  <span>{audioMonitor.transient ? copy.effects.transientReady : copy.effects.transientIdle}</span>
                  <span>{`ctx ${audioMonitor.contextState} / atk ${audioMonitor.attack.toFixed(3)} / avg ${audioMonitor.average.toFixed(3)}`}</span>
                </div>

                <div className="silk-weaver__audio-meta">
                  <span>{copy.effects.trackLabel}</span>
                  <span>{`${audioTrackInfo.label} / muted ${String(audioTrackInfo.muted)} / enabled ${String(audioTrackInfo.enabled)} / ${audioTrackInfo.readyState}`}</span>
                </div>
              </div>

              <div className="silk-weaver__threshold-panel">
                <p className="silk-weaver__effect-title">{copy.effects.thresholdTitle}</p>

                <label className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.effects.heartSize}</span>
                    <strong>{heartBurstSize.toFixed(1)}rem</strong>
                  </span>
                  <input
                    type="range"
                    min="2.4"
                    max="6"
                    step="0.1"
                    value={heartBurstSize}
                    onChange={(event) => setHeartBurstSize(Number(event.currentTarget.value))}
                  />
                </label>

                <label className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.effects.thresholdLabels.level}</span>
                    <strong>{audioThresholds.level.toFixed(2)}</strong>
                  </span>
                  <input
                    type="range"
                    min="0.04"
                    max="0.7"
                    step="0.01"
                    value={audioThresholds.level}
                    onChange={(event) => updateAudioThreshold('level', Number(event.currentTarget.value))}
                  />
                </label>

                <label className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.effects.thresholdLabels.average}</span>
                    <strong>{audioThresholds.average.toFixed(2)}</strong>
                  </span>
                  <input
                    type="range"
                    min="0.08"
                    max="1"
                    step="0.01"
                    value={audioThresholds.average}
                    onChange={(event) => updateAudioThreshold('average', Number(event.currentTarget.value))}
                  />
                </label>

                <label className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.effects.thresholdLabels.attack}</span>
                    <strong>{audioThresholds.attack.toFixed(2)}</strong>
                  </span>
                  <input
                    type="range"
                    min="0.01"
                    max="0.3"
                    step="0.005"
                    value={audioThresholds.attack}
                    onChange={(event) => updateAudioThreshold('attack', Number(event.currentTarget.value))}
                  />
                </label>

                <label className="silk-weaver__control">
                  <span className="silk-weaver__control-row">
                    <span>{copy.effects.thresholdLabels.cooldownMs}</span>
                    <strong>{`${Math.round(audioThresholds.cooldownMs)}ms`}</strong>
                  </span>
                  <input
                    type="range"
                    min="60"
                    max="600"
                    step="10"
                    value={audioThresholds.cooldownMs}
                    onChange={(event) => updateAudioThreshold('cooldownMs', Number(event.currentTarget.value))}
                  />
                </label>
              </div>
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
