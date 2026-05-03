'use client'

/**
 * ParamForm -- dynamic parameter form driven by a param_schema array.
 *
 * Used by both Step 1 (chunker params) and Step 2 (retrieval + compression
 * params) so the rendering logic is not duplicated. Each parameter entry in
 * the schema describes one form field. The component renders:
 *   int / float  ->  a labelled range slider with a live value badge
 *   enum         ->  a dropdown select
 *
 * A question-mark tooltip next to each label surfaces the description from
 * the schema in plain English without cluttering the form with inline prose.
 */

import { useState } from 'react'
import type { ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function ParamTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors"
        style={{
          background: 'var(--color-border)',
          color: 'var(--color-text-secondary)',
        }}
        aria-label={`Parameter description: ${text}`}
      >
        ?
      </button>

      {visible && (
        <div
          className="absolute z-30 left-6 top-0 w-64 p-3 rounded-xl text-xs leading-relaxed shadow-xl"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-secondary)',
          }}
          role="tooltip"
        >
          {text}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Individual field renderers
// ---------------------------------------------------------------------------

function SliderField({
  entry,
  value,
  onChange,
}: {
  entry: ParamSchemaEntry
  value: number
  onChange: (v: number) => void
}) {
  const min  = entry.min  ?? 0
  const max  = entry.max  ?? 100
  const step = entry.type === 'float' ? 0.01 : 1

  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <label
            htmlFor={`param-${entry.name}`}
            className="text-xs font-medium"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {entry.name.replace(/_/g, ' ')}
          </label>
          <ParamTooltip text={entry.description} />
        </div>

        {/* Live value badge */}
        <span
          className="text-xs font-mono font-semibold px-2 py-0.5 rounded"
          style={{
            background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)',
            color: 'var(--color-accent)',
          }}
        >
          {entry.type === 'float' ? value.toFixed(2) : value}
        </span>
      </div>

      {/* Range slider with custom accent fill */}
      <div className="relative h-6 flex items-center">
        <div
          className="absolute h-1 rounded-full pointer-events-none"
          style={{
            left: 0,
            width: `${pct}%`,
            background: 'var(--color-accent)',
          }}
          aria-hidden="true"
        />
        <div
          className="absolute h-1 rounded-full pointer-events-none"
          style={{
            left: `${pct}%`,
            right: 0,
            background: 'var(--color-border)',
          }}
          aria-hidden="true"
        />
        <input
          id={`param-${entry.name}`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e =>
            onChange(entry.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value, 10))
          }
          className="w-full appearance-none bg-transparent cursor-pointer relative z-10"
          style={{ height: '24px' }}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
        />
      </div>

      <div
        className="flex justify-between text-[10px]"
        style={{ color: 'var(--color-text-secondary)' }}
        aria-hidden="true"
      >
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

function EnumField({
  entry,
  value,
  onChange,
}: {
  entry: ParamSchemaEntry
  value: string
  onChange: (v: string) => void
}) {
  const options = entry.options ?? []

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={`param-${entry.name}`}
          className="text-xs font-medium"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {entry.name.replace(/_/g, ' ')}
        </label>
        <ParamTooltip text={entry.description} />
      </div>

      <select
        id={`param-${entry.name}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg px-3 py-2 text-xs font-medium"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-primary)',
        }}
      >
        {options.map(opt => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ParamForm
// ---------------------------------------------------------------------------

export interface ParamFormProps {
  schema: ParamSchemaEntry[]
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
}

export default function ParamForm({ schema, values, onChange }: ParamFormProps) {
  if (schema.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        This strategy has no configurable parameters.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {schema.map(entry => {
        const raw = values[entry.name]
        const value = raw !== undefined ? raw : entry.default

        if (entry.type === 'enum') {
          return (
            <EnumField
              key={entry.name}
              entry={entry}
              value={String(value)}
              onChange={v => onChange(entry.name, v)}
            />
          )
        }

        return (
          <SliderField
            key={entry.name}
            entry={entry}
            value={Number(value)}
            onChange={v => onChange(entry.name, v)}
          />
        )
      })}
    </div>
  )
}
