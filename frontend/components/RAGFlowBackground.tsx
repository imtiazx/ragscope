'use client'

/**
 * RAGFlowBackground -- animated RAG pipeline visualization for the hero.
 *
 * Draws a continuous canvas animation showing the full RAG pipeline from left
 * to right: document icons feed into chunks, chunks transform into embedding
 * dots, some dots get highlighted during retrieval, highlighted dots converge
 * into an answer on the right. The animation loops seamlessly.
 *
 * All elements are low-opacity so text above remains fully readable.
 * Colors are read from CSS custom properties so the animation adapts to the
 * active theme (light vs dark) without a component re-mount.
 *
 * Pipeline stages rendered (x positions approximate):
 *   0-14%    Documents  -- 3 stacked file icons with text lines
 *   14-38%   Chunks     -- small rectangles fragmenting from documents
 *   38-58%   Embeddings -- scattered dots representing dense vectors
 *   58-78%   Retrieval  -- highlighted matches with glow
 *   78-100%  Answer     -- converging dots forming a glowing block
 */

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FlowParticle {
  id: number
  /** 0-1: position along the pipeline (x axis). */
  progress: number
  /** Pixels per second along x axis. */
  speed: number
  /** Vertical lane index (0-3). Each lane has a unique y position. */
  lane: number
  /** Whether this particle will be highlighted in the retrieval phase. */
  highlighted: boolean
  /** Mild y oscillation offset (radians). */
  phase: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARTICLE_COUNT  = 20
const LANES           = 4
const BASE_SPEED_PX   = 42  // pixels per second
const OSCILLATION_AMP = 5   // px up/down wobble per particle

// Normalised x boundaries for each stage
const STAGE = {
  docEnd:    0.14,
  chunkEnd:  0.38,
  embedEnd:  0.58,
  retrieveEnd: 0.78,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLaneY(lane: number, height: number): number {
  // Distribute lanes across the vertical middle band (25%-75%)
  return height * (0.28 + (lane / (LANES - 1)) * 0.44)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RAGFlowBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctxRaw = canvas.getContext('2d')
    if (!ctxRaw) return
    // Shadow as a non-null type so TypeScript is happy throughout the closure
    const ctx: CanvasRenderingContext2D = ctxRaw

    let width = 0
    let height = 0
    let rafId = 0
    let lastTime = 0

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width
      canvas.height = height
    }
    resize()
    window.addEventListener('resize', resize, { passive: true })

    // Stagger particles so the pipeline always looks active on first render
    const particles: FlowParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      progress: i / PARTICLE_COUNT,
      speed: BASE_SPEED_PX * (0.85 + Math.random() * 0.3),
      lane: i % LANES,
      highlighted: i % 5 === 0, // 20% get retrieved
      phase: Math.random() * Math.PI * 2,
    }))

    // Read accent RGB from CSS variables so we honour the active theme
    const getAccent = (): { r: string; g: string; b: string } => {
      const s = getComputedStyle(document.documentElement)
      return {
        r: s.getPropertyValue('--color-accent-r').trim() || '0',
        g: s.getPropertyValue('--color-accent-g').trim() || '212',
        b: s.getPropertyValue('--color-accent-b').trim() || '255',
      }
    }

    // Draw one of the 3 stacked document icons on the left
    function drawDocIcon(
      x: number, y: number, w: number, h: number, alpha: number,
      acc: { r: string; g: string; b: string }
    ) {
      if (!ctx) return
      const { r, g, b } = acc
      ctx.save()
      ctx.globalAlpha = alpha
      // Card body
      ctx.strokeStyle = `rgba(${r},${g},${b},0.6)`
      ctx.lineWidth = 0.8
      ctx.strokeRect(x, y, w, h)
      // Folded corner
      ctx.beginPath()
      ctx.moveTo(x + w - 6, y)
      ctx.lineTo(x + w, y + 6)
      ctx.stroke()
      // Text lines inside
      for (let li = 0; li < 3; li++) {
        const ly = y + 9 + li * 5
        ctx.strokeStyle = `rgba(${r},${g},${b},0.3)`
        ctx.beginPath()
        ctx.moveTo(x + 4, ly)
        ctx.lineTo(x + w - (li === 2 ? 8 : 4), ly)
        ctx.stroke()
      }
      ctx.restore()
    }

    function drawFrame(now: number) {
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0
      lastTime = now

      ctx.clearRect(0, 0, width, height)
      const acc = getAccent()
      const { r, g, b } = acc
      const t = now / 1000

      // ---- Stage label positions (bottom of the canvas, very subtle)
      const labelY = height * 0.82
      const LABELS = [
        { label: 'Ingest',    cx: width * 0.07  },
        { label: 'Chunk',     cx: width * 0.26  },
        { label: 'Embed',     cx: width * 0.48  },
        { label: 'Retrieve',  cx: width * 0.68  },
        { label: 'Answer',    cx: width * 0.89  },
      ]
      ctx.save()
      ctx.font = `500 10px var(--font-inter, system-ui)`
      ctx.textAlign = 'center'
      ctx.fillStyle = `rgba(${r},${g},${b},0.18)`
      ctx.letterSpacing = '0.08em'
      LABELS.forEach(({ label, cx }) => ctx.fillText(label.toUpperCase(), cx, labelY))
      ctx.restore()

      // ---- Vertical divider lines between stages
      const dividers = [STAGE.docEnd, STAGE.chunkEnd, STAGE.embedEnd, STAGE.retrieveEnd]
      dividers.forEach(xn => {
        const dx = xn * width
        ctx.save()
        ctx.globalAlpha = 0.06
        ctx.strokeStyle = `rgba(${r},${g},${b},1)`
        ctx.lineWidth = 0.5
        ctx.setLineDash([3, 6])
        ctx.beginPath()
        ctx.moveTo(dx, height * 0.15)
        ctx.lineTo(dx, height * 0.78)
        ctx.stroke()
        ctx.restore()
      })

      // ---- Document icons (left side, 3 stacked)
      const docX = width * 0.04
      const docW = Math.min(32, width * 0.05)
      const docH = docW * 1.25
      const docPulse = 0.12 + Math.sin(t * 1.6) * 0.03
      for (let d = 0; d < 3; d++) {
        drawDocIcon(
          docX + d * 4,
          height * 0.35 + d * (docH * 0.6),
          docW, docH,
          docPulse - d * 0.02,
          acc
        )
      }

      // ---- Answer block (right side, appears when highlighted particles arrive)
      const answerAlpha = 0.10 + Math.sin(t * 1.2) * 0.04
      const ansX = width * 0.85
      const ansW = Math.min(40, width * 0.06)
      const ansH = ansW * 0.7
      const ansY = height * 0.5 - ansH / 2
      ctx.save()
      ctx.strokeStyle = `rgba(${r},${g},${b},${answerAlpha + 0.08})`
      ctx.lineWidth = 1
      ctx.strokeRect(ansX, ansY, ansW, ansH)
      // Soft glow around answer
      const ansGlow = ctx.createRadialGradient(
        ansX + ansW / 2, ansY + ansH / 2, 0,
        ansX + ansW / 2, ansY + ansH / 2, ansW
      )
      ansGlow.addColorStop(0, `rgba(${r},${g},${b},${answerAlpha * 0.6})`)
      ansGlow.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = ansGlow
      ctx.fillRect(ansX - ansW / 2, ansY - ansH / 2, ansW * 2, ansH * 2)
      // Text lines in answer block
      ctx.strokeStyle = `rgba(${r},${g},${b},0.2)`
      ctx.lineWidth = 0.7
      for (let li = 0; li < 2; li++) {
        const ly = ansY + 8 + li * 7
        ctx.beginPath()
        ctx.moveTo(ansX + 4, ly)
        ctx.lineTo(ansX + ansW - 4, ly)
        ctx.stroke()
      }
      ctx.restore()

      // ---- Flow particles
      particles.forEach(p => {
        // Advance progress
        p.progress += (p.speed * dt) / width
        if (p.progress > 1) p.progress = 0

        const px = p.progress * width
        const laneY = makeLaneY(p.lane, height)
        const oscillation = Math.sin(t * 1.8 + p.phase) * OSCILLATION_AMP
        const py = laneY + oscillation

        const prog = p.progress

        // Fade in near documents, fade out entering answer (for non-highlighted)
        const fadeIn  = Math.min(prog / 0.05, 1)
        const fadeOut = p.highlighted ? 1 : (prog > 0.82 ? 1 - (prog - 0.82) / 0.15 : 1)
        const baseAlpha = fadeIn * fadeOut

        if (prog < STAGE.docEnd) {
          // Leaving document -- small dot emanating
          ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * 0.25})`
          ctx.beginPath()
          ctx.arc(px, py, 1.5, 0, Math.PI * 2)
          ctx.fill()

        } else if (prog < STAGE.chunkEnd) {
          // Chunk phase -- rounded rectangle
          const t2 = (prog - STAGE.docEnd) / (STAGE.chunkEnd - STAGE.docEnd)
          const cw = lerp(10, 6, t2)
          const ch = lerp(5, 3, t2)
          ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * 0.22})`
          ctx.beginPath()
          ctx.roundRect(px - cw / 2, py - ch / 2, cw, ch, 1)
          ctx.fill()

        } else if (prog < STAGE.embedEnd) {
          // Embedding dot -- wanders slightly around lane
          const scatter = Math.sin(p.id * 2.7 + t * 0.4) * 18
          ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * 0.28})`
          ctx.beginPath()
          ctx.arc(px, py + scatter, 1.8, 0, Math.PI * 2)
          ctx.fill()

        } else if (prog < STAGE.retrieveEnd) {
          // Retrieval phase
          if (p.highlighted) {
            // Glow ring around highlighted particle
            const glow = ctx.createRadialGradient(px, py, 0, px, py, 10)
            glow.addColorStop(0, `rgba(${r},${g},${b},0.30)`)
            glow.addColorStop(1, `rgba(${r},${g},${b},0)`)
            ctx.fillStyle = glow
            ctx.beginPath()
            ctx.arc(px, py, 10, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = `rgba(${r},${g},${b},0.55)`
            ctx.beginPath()
            ctx.arc(px, py, 2.5, 0, Math.PI * 2)
            ctx.fill()
          } else {
            ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * 0.12})`
            ctx.beginPath()
            ctx.arc(px, py, 1.5, 0, Math.PI * 2)
            ctx.fill()
          }

        } else {
          // Answer phase -- highlighted particles drift toward answer box
          if (p.highlighted) {
            const t3 = (prog - STAGE.retrieveEnd) / (1 - STAGE.retrieveEnd)
            const targetY = height * 0.5
            const apy = lerp(py, targetY, t3 * 0.6)
            ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * 0.5})`
            ctx.beginPath()
            ctx.arc(px, apy, 2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      })

      rafId = requestAnimationFrame(drawFrame)
    }

    rafId = requestAnimationFrame(drawFrame)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
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
