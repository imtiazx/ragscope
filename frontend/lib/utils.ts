/**
 * Pure utility helpers shared across the frontend.
 *
 * No React, no DOM access, no side effects: every function here is a pure
 * input-to-output transform so it can be unit-tested and called from any
 * context (server components, client components, recharts formatters).
 */

/**
 * Format a latency value (in milliseconds) for display.
 *
 * Two-branch format, no thousands separators (intentionally avoiding
 * toLocaleString and Intl.NumberFormat because the locale-formatted comma
 * looks like an error in compact metric UIs):
 *
 *   - Under 1000 ms: render as "NNN ms" with the millisecond value rounded
 *     to the nearest integer (e.g. 412 -> "412 ms").
 *   - 1000 ms or above: convert to seconds and render with exactly three
 *     decimal places (e.g. 1234 -> "1.234 s", 69100 -> "69.100 s").
 *
 * @param ms - latency in milliseconds. Non-finite values render as "--".
 * @returns formatted string suitable for inline display.
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '--'
  if (ms < 1000) {
    return `${Math.round(ms)} ms`
  }
  return `${(ms / 1000).toFixed(3)} s`
}
