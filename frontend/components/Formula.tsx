'use client'

/**
 * Formula -- renders a LaTeX math expression using KaTeX.
 *
 * Accepts a LaTeX string and renders it as display-mode math (block) or
 * inline math. Uses KaTeX's renderToString for synchronous SSR-safe
 * rendering and injects the result via dangerouslySetInnerHTML.
 *
 * The KaTeX CSS is imported globally in globals.css.
 */

import katex from 'katex'

interface FormulaProps {
  /** LaTeX math expression (without surrounding $ or \[ delimiters). */
  latex: string
  /** When true, renders in display mode (centred block). Default false (inline). */
  block?: boolean
  className?: string
}

export default function Formula({ latex, block = false, className }: FormulaProps) {
  const html = katex.renderToString(latex, {
    displayMode: block,
    throwOnError: false,
    output: 'html',
  })

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      aria-label={latex}
    />
  )
}
