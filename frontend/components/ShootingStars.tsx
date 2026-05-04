'use client'

/**
 * SnowflakeBackground -- full-viewport canvas particle animation.
 *
 * Particles drift slowly downward with a gentle sine-wave horizontal
 * oscillation. They do not streak or shoot in any direction. When a
 * particle exits the bottom of the screen it wraps back to the top.
 *
 * Color: teal (#14b8a6) at varying opacity to create depth. The effect
 * is intentionally subtle so it does not compete with page content.
 *
 * Exported as ShootingStars so no import changes are needed in page.tsx.
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Particle definition
// ---------------------------------------------------------------------------

interface Particle {
  x: number       // current x position (pixels)
  y: number       // current y position (pixels)
  vy: number      // downward drift speed (pixels per frame)
  size: number    // radius (pixels)
  opacity: number // base opacity (0 to 1)
  phase: number   // sine-wave phase offset (radians)
  freq: number    // sine-wave oscillation frequency
  amp: number     // horizontal drift amplitude (pixels)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 80
const MIN_SIZE       = 1.0
const MAX_SIZE       = 2.5
const MIN_SPEED      = 0.2   // pixels per frame downward
const MAX_SPEED      = 0.7
const MIN_OPACITY    = 0.15
const MAX_OPACITY    = 0.55
const TEAL_RGB       = '20,184,166'   // #14b8a6

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

function makeParticle(w: number, h: number, offscreen = false): Particle {
  return {
    x:       Math.random() * w,
    y:       offscreen ? -randBetween(0, h) : Math.random() * h,
    vy:      randBetween(MIN_SPEED, MAX_SPEED),
    size:    randBetween(MIN_SIZE, MAX_SIZE),
    opacity: randBetween(MIN_OPACITY, MAX_OPACITY),
    phase:   Math.random() * Math.PI * 2,
    freq:    randBetween(0.004, 0.012),
    amp:     randBetween(12, 35),
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ShootingStars() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rawCtx = canvas.getContext('2d')
    if (!rawCtx) return
    const ctx: CanvasRenderingContext2D = rawCtx

    let width = 0
    let height = 0
    let rafId = 0
    let frame = 0

    const resize = () => {
      width  = window.innerWidth
      height = window.innerHeight
      canvas.width  = width
      canvas.height = height
    }
    resize()
    window.addEventListener('resize', resize, { passive: true })

    const particles: Particle[] = Array.from(
      { length: PARTICLE_COUNT },
      () => makeParticle(width, height, false)
    )

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      frame++

      for (const p of particles) {
        // Drift downward
        p.y += p.vy
        // Gentle horizontal sine-wave oscillation
        const dx = Math.sin(frame * p.freq + p.phase) * p.amp

        // Wrap to top when particle exits the bottom
        if (p.y > height + p.size) {
          Object.assign(p, makeParticle(width, height, true))
          continue
        }

        ctx.beginPath()
        ctx.arc(p.x + dx, p.y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${TEAL_RGB},${p.opacity.toFixed(3)})`
        ctx.fill()
      }

      rafId = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  )
}
