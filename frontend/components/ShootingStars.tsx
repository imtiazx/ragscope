'use client'

/**
 * ShootingStars -- full-viewport canvas background animation.
 *
 * Dots of varying sizes (1-3px) travel diagonally across the canvas, each
 * leaving a gradient trail that fades to transparent. The result reads like a
 * premium observatory or a Bloomberg terminal screensaver: precise, calm, and
 * alive.
 *
 * Color palette:
 *   Dark mode  -- bright white (#FFFFFF) and pale cyan (#B8F0FF) at low opacity
 *   Light mode -- slate blue (#4A6080) and medium blue (#6B8FBF) at low opacity
 *
 * The theme is detected by reading the data-theme attribute on <html> so the
 * canvas adapts without a component re-mount. Reading the attribute every frame
 * is cheap and keeps the animation in sync with rapid theme switches.
 *
 * CSS grid overlay:
 *   Applied via an absolutely-positioned div with a CSS background-image grid
 *   pattern. 3% opacity in light mode, 5% in dark mode. Handled in page.tsx
 *   rather than here so the grid participates in the normal CSS cascade.
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Star definition
// ---------------------------------------------------------------------------

interface Star {
  x: number        // current x position (pixels)
  y: number        // current y position (pixels)
  vx: number       // x velocity (pixels per frame)
  vy: number       // y velocity (pixels per frame)
  size: number     // dot radius (1 - 3px)
  opacity: number  // base opacity for this star
  trailLength: number  // how many pixels the gradient trail extends back
  // Color index: 0 = primary (white/slate), 1 = secondary (cyan/blue)
  colorIdx: 0 | 1
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STAR_COUNT      = 90
const MIN_SIZE        = 0.8
const MAX_SIZE        = 2.8
const MIN_SPEED       = 0.4   // pixels per frame
const MAX_SPEED       = 1.8
// All stars move in roughly the same diagonal direction (bottom-right) with
// slight variance so the field feels coherent rather than scattered.
const BASE_ANGLE_DEG  = 35    // degrees from horizontal
const ANGLE_VARIANCE  = 18    // +/- variance in degrees

// Dark mode colours (bright on dark)
const DARK_COLORS  = ['255,255,255', '184,240,255']  // white, pale cyan
// Light mode colours (dark on light)
const LIGHT_COLORS = ['74,96,128', '107,143,191']    // slate blue, medium blue

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function degToRad(d: number): number { return d * (Math.PI / 180) }

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return true
  return document.documentElement.getAttribute('data-theme') !== 'light'
}

function makeStar(w: number, h: number, offscreen = false): Star {
  const speed  = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)
  const angle  = degToRad(BASE_ANGLE_DEG + (Math.random() - 0.5) * 2 * ANGLE_VARIANCE)
  const size   = MIN_SIZE + Math.random() * (MAX_SIZE - MIN_SIZE)

  // When seeding initially, distribute across the entire canvas.
  // When respawning after going off-screen, start just off the top or left edge.
  let x: number, y: number
  if (offscreen) {
    if (Math.random() < 0.5) {
      x = Math.random() * w
      y = -size * 2
    } else {
      x = -size * 2
      y = Math.random() * h
    }
  } else {
    x = Math.random() * w
    y = Math.random() * h
  }

  return {
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    size,
    opacity: 0.35 + Math.random() * 0.5,
    trailLength: size * (18 + Math.random() * 30),
    colorIdx: Math.random() < 0.75 ? 0 : 1,
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

    const resize = () => {
      width  = window.innerWidth
      height = window.innerHeight
      canvas.width  = width
      canvas.height = height
    }
    resize()
    window.addEventListener('resize', resize, { passive: true })

    // Initialise stars spread across the canvas
    const stars: Star[] = Array.from({ length: STAR_COUNT }, () =>
      makeStar(width, height, false)
    )

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const dark   = isDarkMode()
      const colors = dark ? DARK_COLORS : LIGHT_COLORS

      for (const star of stars) {
        // Advance position
        star.x += star.vx
        star.y += star.vy

        // Respawn when fully off the bottom-right edges
        if (star.x > width + star.size * 2 || star.y > height + star.size * 2) {
          Object.assign(star, makeStar(width, height, true))
          continue
        }

        const rgb = colors[star.colorIdx]

        // --- Trail gradient (stretches back in the direction of travel)
        const trailX = star.x - (star.vx / Math.hypot(star.vx, star.vy)) * star.trailLength
        const trailY = star.y - (star.vy / Math.hypot(star.vx, star.vy)) * star.trailLength

        const grad = ctx.createLinearGradient(trailX, trailY, star.x, star.y)
        grad.addColorStop(0, `rgba(${rgb},0)`)
        grad.addColorStop(1, `rgba(${rgb},${(star.opacity * 0.55).toFixed(3)})`)

        ctx.beginPath()
        ctx.strokeStyle = grad
        // Trail width tapers: use lineWidth proportional to dot size
        ctx.lineWidth = star.size * 0.9
        ctx.lineCap   = 'round'
        ctx.moveTo(trailX, trailY)
        ctx.lineTo(star.x, star.y)
        ctx.stroke()

        // --- Dot (bright head of the star)
        ctx.beginPath()
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb},${star.opacity.toFixed(3)})`
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
