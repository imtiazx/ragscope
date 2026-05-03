'use client'

/**
 * AudioManager -- three-level global audio system for RAGScope.
 *
 * Levels:
 *   2  ambient music on  + click sounds on
 *   1  ambient music off + click sounds on   (default)
 *   0  everything off
 *
 * Level 1 is the default so first-time visitors hear subtle UI feedback but
 * are not ambushed by music. Cycling up to level 2 reveals the ambient layer.
 *
 * Click sounds are generated entirely via the Web Audio API oscillator --
 * no external audio file is needed. This is more reliable than a file-based
 * approach: there is no network request, no decode latency, and it works
 * offline regardless of CDN availability.
 *
 * Ambient music requires /public/ambient.mp3 to be present. If the file is
 * missing the Audio element fails silently -- all other audio still works.
 * To add music: place a royalty-free ambient piano MP3 at public/ambient.mp3.
 * Recommended source: https://pixabay.com/music/ (search "ambient piano").
 *
 * State persists in localStorage under key ragscope_audio_level.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioLevel = 0 | 1 | 2

interface AudioManagerContextValue {
  /** 0 = off, 1 = clicks only, 2 = clicks + music */
  audioLevel: AudioLevel
  /** Cycle 2 -> 1 -> 0 -> 2 */
  cycleAudio: () => void
  /** Play a programmatic click tick if level >= 1 */
  playClick: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY   = 'ragscope_audio_level'
const DEFAULT_LEVEL: AudioLevel = 1
// Next.js serves everything in /public at the root path.
// The file lives at frontend/public/audio/quietphase-ambient-zen-489706.mp3
// and is accessed as a static asset at this URL.
const AMBIENT_SRC   = '/audio/quietphase-ambient-zen-489706.mp3'
// 0.35 -- present and atmospheric without competing with the interface.
const AMBIENT_VOL   = 0.35

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AudioManagerContext = createContext<AudioManagerContextValue>({
  audioLevel: DEFAULT_LEVEL,
  cycleAudio: () => {},
  playClick:  () => {},
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AudioManagerProvider({ children }: { children: ReactNode }) {
  const [audioLevel, setAudioLevel] = useState<AudioLevel>(DEFAULT_LEVEL)

  // Refs give callbacks synchronous access to the latest level without
  // stale closures -- essential for the global click listener.
  const levelRef       = useRef<AudioLevel>(DEFAULT_LEVEL)
  const ambientRef     = useRef<HTMLAudioElement | null>(null)
  const webAudioCtxRef = useRef<AudioContext | null>(null)

  // Keep ref in sync
  useEffect(() => { levelRef.current = audioLevel }, [audioLevel])

  // ---- One-time initialisation on mount
  useEffect(() => {
    // Hydrate from localStorage
    const raw = localStorage.getItem(STORAGE_KEY)
    const stored = raw !== null ? (parseInt(raw, 10) as AudioLevel) : DEFAULT_LEVEL
    const initial = [0, 1, 2].includes(stored) ? stored : DEFAULT_LEVEL
    setAudioLevel(initial)
    levelRef.current = initial

    // Set up ambient audio element. Failing to load the file is non-fatal.
    const audio = new Audio(AMBIENT_SRC)
    audio.loop    = true
    audio.volume  = AMBIENT_VOL
    audio.preload = 'auto'
    ambientRef.current = audio

    if (initial === 2) {
      audio.play().catch(() => {}) // browser autoplay policy may block silently
    }

    // Global click listener -- fires click tick for all interactive elements
    const handleClick = (e: MouseEvent) => {
      if (levelRef.current < 1) return
      const target = e.target as Element
      if (target.closest(
        'button, a, input, select, textarea, [role="button"], [role="option"]'
      )) {
        playTickSound()
      }
    }
    document.addEventListener('click', handleClick)

    return () => {
      audio.pause()
      audio.src = ''
      document.removeEventListener('click', handleClick)
      webAudioCtxRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Web Audio helpers

  function getWebAudioCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!webAudioCtxRef.current) {
      try {
        webAudioCtxRef.current = new (
          window.AudioContext ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).webkitAudioContext
        )()
      } catch { return null }
    }
    if (webAudioCtxRef.current.state === 'suspended') {
      webAudioCtxRef.current.resume().catch(() => {})
    }
    return webAudioCtxRef.current
  }

  /**
   * Synthesise a 50ms sine-wave tick entirely in the browser.
   * No file required -- the waveform is generated by an OscillatorNode
   * connected through a GainNode that ramps to silence in 45ms.
   */
  function playTickSound() {
    const ctx = getWebAudioCtx()
    if (!ctx) return
    try {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type          = 'sine'
      osc.frequency.value = 1200
      const t = ctx.currentTime
      gain.gain.setValueAtTime(0.07, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045)
      osc.start(t)
      osc.stop(t + 0.05)
    } catch { /* silently ignore */ }
  }

  // ---- Exposed callbacks

  const playClick = useCallback(() => {
    if (levelRef.current < 1) return
    playTickSound()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Cycle: 2 -> 1 -> 0 -> 2
   * Adjusts ambient playback immediately and persists to localStorage.
   */
  const cycleAudio = useCallback(() => {
    setAudioLevel(prev => {
      const next: AudioLevel = prev === 2 ? 1 : prev === 1 ? 0 : 2
      levelRef.current = next
      localStorage.setItem(STORAGE_KEY, String(next))

      const ambient = ambientRef.current
      if (ambient) {
        if (next === 2) {
          ambient.play().catch(() => {})
        } else {
          ambient.pause()
        }
      }
      return next
    })
  }, [])

  return (
    <AudioManagerContext.Provider value={{ audioLevel, cycleAudio, playClick }}>
      {children}
    </AudioManagerContext.Provider>
  )
}

export function useAudio() {
  return useContext(AudioManagerContext)
}
