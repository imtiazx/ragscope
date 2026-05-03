'use client'

/**
 * ParticleBackground -- canvas-based ambient animation for the hero section.
 *
 * Renders 70 small dots that drift slowly across the viewport. Nearby dots are
 * connected by faint lines, creating a network graph feel that suits a data
 * tooling product. Uses requestAnimationFrame for smooth 60fps animation
 * without blocking the main thread.
 *
 * No external animation library is used. The canvas is sized to match the
 * window and updated on resize. Cleanup runs on unmount via the useEffect
 * return function.
 */

import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  opacity: number
}

const PARTICLE_COUNT = 70
const MAX_CONNECT_DIST = 130
const SPEED = 0.25

export default function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let rafId = 0

    const particles: Particle[] = []

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width
      canvas.height = height
    }

    const seed = () => {
      particles.length = 0
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * SPEED,
          vy: (Math.random() - 0.5) * SPEED,
          r: Math.random() * 1.2 + 0.4,
          opacity: Math.random() * 0.3 + 0.1,
        })
      }
    }

    // Read the current theme accent RGB values from CSS custom properties.
    // getComputedStyle resolves CSS variables to their actual values so the
    // canvas (which cannot interpret CSS variables) gets real numbers.
    const getAccentRGB = () => {
      const style = getComputedStyle(document.documentElement)
      const r = style.getPropertyValue('--color-accent-r').trim() || '0'
      const g = style.getPropertyValue('--color-accent-g').trim() || '212'
      const b = style.getPropertyValue('--color-accent-b').trim() || '255'
      return { r, g, b }
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const { r, g, b } = getAccentRGB()

      // Draw connections first so they appear underneath dots
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < MAX_CONNECT_DIST) {
            // Line fades to zero at max distance
            const alpha = (1 - dist / MAX_CONNECT_DIST) * 0.07
            ctx.beginPath()
            ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
            ctx.lineWidth = 0.6
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.stroke()
          }
        }
      }

      // Draw and update each particle
      for (const p of particles) {
        ctx.beginPath()
        ctx.fillStyle = `rgba(${r},${g},${b},${p.opacity})`
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()

        p.x += p.vx
        p.y += p.vy

        // Bounce off viewport edges
        if (p.x < 0 || p.x > width) {
          p.vx *= -1
          p.x = Math.max(0, Math.min(width, p.x))
        }
        if (p.y < 0 || p.y > height) {
          p.vy *= -1
          p.y = Math.max(0, Math.min(height, p.y))
        }
      }

      rafId = requestAnimationFrame(draw)
    }

    resize()
    seed()
    draw()

    const handleResize = () => {
      resize()
      seed()
    }
    window.addEventListener('resize', handleResize, { passive: true })

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    />
  )
}
