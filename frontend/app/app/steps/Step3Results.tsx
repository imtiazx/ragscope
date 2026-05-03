'use client'

/**
 * Step 3 -- Live results poller and benchmark comparison dashboard.
 *
 * When the step mounts, it starts polling GET /results/{runId} every 2 seconds.
 * While polling, animated status copy explains what is happening at each stage.
 * When the run completes, the result is added to runHistory in AppContext and
 * four visualizations render simultaneously:
 *
 *   1. Radar chart -- three metric axes, one polygon per completed run
 *   2. Latency bar chart -- sorted fastest to slowest
 *   3. Comparison table -- sortable, color-coded best/worst per column
 *   4. Animated score cards -- count-up animation for the selected run
 *
 * All completed runs accumulate in localStorage so the chart history grows
 * across multiple runs in the same session.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  LineChart,
  Line,
} from 'recharts'
import { Trophy, ArrowLeft, RotateCcw, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { useAppContext, type RunResult } from '@/context/AppContext'
import { getRunStatus } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000

const POLL_STAGES = [
  { after: 0,     label: 'Retrieving chunks from your corpus...' },
  { after: 4000,  label: 'Generating an answer from retrieved context...' },
  { after: 9000,  label: 'Evaluating faithfulness with GPT-4o-mini...' },
  { after: 16000, label: 'Computing context utilization and answer relevancy...' },
  { after: 22000, label: 'Finalising and storing results...' },
]

const RUN_COLORS = ['#00D4FF', '#FF6B9D', '#FFB347', '#7CFF67', '#C67EFF', '#FF8C42']

type MetricKey = 'faithfulness' | 'contextUtilization' | 'answerRelevancy'
type SortKey = MetricKey | 'latencyMs'

const METRIC_LABELS: Record<MetricKey, string> = {
  faithfulness:        'Faithfulness',
  contextUtilization:  'Context Utilization',
  answerRelevancy:     'Answer Relevancy',
}

const METRIC_TOOLTIPS: Record<MetricKey, string> = {
  faithfulness:
    'Measures whether every claim in the generated answer is supported by the retrieved chunks. A score of 1.0 means no hallucination.',
  contextUtilization:
    'Measures how much of the retrieved context the model actually used when generating the answer. Low scores mean the model ignored the retrieved material.',
  answerRelevancy:
    'Measures whether the answer directly addresses the question asked. A tangential or off-topic answer scores low even if it is factually correct.',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latencyLabel(ms: number): string {
  if (ms < 3000)  return 'Fast'
  if (ms < 9000)  return 'Moderate'
  return 'Slow'
}

function metricInterpretation(key: MetricKey, score: number): string {
  const interpretations: Record<MetricKey, [string, string, string]> = {
    faithfulness: [
      'The answer stays closely grounded in your documents.',
      'The answer has some grounding but may contain unsupported claims.',
      'The answer departs significantly from the retrieved context.',
    ],
    contextUtilization: [
      'The model made strong use of the retrieved context in its answer.',
      'The model used some of the retrieved context but not all of it.',
      'The model largely ignored the retrieved context when answering.',
    ],
    answerRelevancy: [
      'The answer directly addresses the question asked.',
      'The answer is partially on-topic.',
      'The answer does not closely address the question.',
    ],
  }
  const [good, mid, bad] = interpretations[key]
  if (score >= 0.75) return good
  if (score >= 0.45) return mid
  return bad
}

function weightedAverage(r: RunResult): number {
  const vals = [r.faithfulness, r.contextUtilization, r.answerRelevancy].filter(
    (v): v is number => v !== null
  )
  if (vals.length === 0) return 0
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

function strategyLabel(name: string): string {
  const map: Record<string, string> = {
    naive:      'Naive RAG',
    hyde:       'HyDE',
    multiquery: 'Multi-Query',
    hybrid:     'Hybrid',
  }
  return map[name] ?? name
}

// ---------------------------------------------------------------------------
// Custom hooks
// ---------------------------------------------------------------------------

function useCountUp(target: number, duration = 1200, delay = 0) {
  const [value, setValue] = useState(0)

  useEffect(() => {
    setValue(0)
    const timeout = setTimeout(() => {
      let startTime: number | null = null
      const tick = (time: number) => {
        if (!startTime) startTime = time
        const progress = Math.min((time - startTime) / duration, 1)
        const eased = 1 - Math.pow(1 - progress, 3) // cubic ease-out
        setValue(target * eased)
        if (progress < 1) requestAnimationFrame(tick)
        else setValue(target)
      }
      requestAnimationFrame(tick)
    }, delay)
    return () => clearTimeout(timeout)
  }, [target, duration, delay])

  return value
}

// ---------------------------------------------------------------------------
// Tooltip wrapper (reused by metric labels in table headers)
// ---------------------------------------------------------------------------

function InfoTooltip({ children, text }: { children: ReactNode; text: string }) {
  const [vis, setVis] = useState(false)
  return (
    <span
      className="relative inline-flex items-center gap-1 cursor-default"
      onMouseEnter={() => setVis(true)}
      onMouseLeave={() => setVis(false)}
      onFocus={() => setVis(true)}
      onBlur={() => setVis(false)}
      tabIndex={0}
      aria-describedby={vis ? 'metric-tip' : undefined}
    >
      {children}
      {vis && (
        <span
          id="metric-tip"
          role="tooltip"
          className="absolute z-30 top-full left-1/2 -translate-x-1/2 mt-2 w-60 p-3 rounded-xl text-xs leading-relaxed shadow-xl"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Polling progress
// ---------------------------------------------------------------------------

function PollingProgress({ startedAt }: { startedAt: number }) {
  const [stageIdx, setStageIdx] = useState(0)

  useEffect(() => {
    const timers = POLL_STAGES.slice(1).map((stage, i) =>
      setTimeout(() => setStageIdx(i + 1), stage.after)
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      {/* Pulsing ring */}
      <div
        className="w-14 h-14 rounded-full border-2 animate-spin"
        style={{ borderColor: `rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15) rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15) rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15) var(--color-accent)` }}
        aria-hidden="true"
      />

      <div className="text-center max-w-xs">
        <p
          className="text-sm font-medium transition-all duration-500"
          style={{ color: 'var(--color-text-primary)' }}
          aria-live="polite"
          key={stageIdx}
        >
          {POLL_STAGES[stageIdx].label}
        </p>
        <p className="text-xs mt-2" style={{ color: 'var(--color-text-secondary)' }}>
          Elapsed: {Math.round((Date.now() - startedAt) / 1000)}s
        </p>
      </div>

      {/* Stage dots */}
      <div className="flex gap-2" aria-hidden="true">
        {POLL_STAGES.map((_, i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full transition-colors"
            style={{ background: i <= stageIdx ? 'var(--color-accent)' : 'var(--color-border)' }}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Winner badge
// ---------------------------------------------------------------------------

function WinnerBadge({ runs }: { runs: RunResult[] }) {
  const completed = runs.filter(r => r.status === 'completed')
  if (completed.length === 0) return null

  const winner = completed.reduce((best, r) =>
    weightedAverage(r) > weightedAverage(best) ? r : best
  , completed[0])

  const score = weightedAverage(winner)
  const name  = strategyLabel(winner.retrievalStrategy)

  // Explain why it won
  const fa = winner.faithfulness    ?? 0
  const cp = winner.contextUtilization ?? 0
  const ar = winner.answerRelevancy  ?? 0
  const bestMetric = fa >= cp && fa >= ar ? 'faithfulness' : cp >= ar ? 'context utilization' : 'answer relevancy'
  const explanation = `Highest weighted average. Led on ${bestMetric}.`

  return (
    <div
      className="flex items-center gap-4 px-5 py-4 rounded-xl animate-glow-pulse"
      style={{
        background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)',
        border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.25)',
      }}
      role="status"
      aria-label={`Winner: ${name}`}
    >
      <Trophy size={22} style={{ color: 'var(--color-accent)', flexShrink: 0 }} aria-hidden="true" />
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold" style={{ color: 'var(--color-accent)' }}>
            {name}
          </span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-text-secondary)' }}>
            avg {(score * 100).toFixed(1)}%
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
          {explanation}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Radar chart
// ---------------------------------------------------------------------------

const RADAR_METRICS = [
  { key: 'faithfulness',     label: 'Faithfulness'      },
  { key: 'contextUtilization', label: 'Context Utilization' },
  { key: 'answerRelevancy',  label: 'Answer Relevancy'  },
]

function MetricRadar({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunResult[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const completed = runs.filter(r => r.status === 'completed')
  if (completed.length === 0) return null

  const data = RADAR_METRICS.map(({ key, label }) => {
    const row: Record<string, number | string> = { metric: label }
    completed.forEach(r => {
      row[r.runId] = (r[key as MetricKey] ?? 0) as number
    })
    return row
  })

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
        Strategy comparison
      </h3>
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="var(--color-border)" />
          <PolarAngleAxis
            dataKey="metric"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
          />
          {completed.map((r, i) => (
            <Radar
              key={r.runId}
              name={strategyLabel(r.retrievalStrategy)}
              dataKey={r.runId}
              stroke={RUN_COLORS[i % RUN_COLORS.length]}
              fill={RUN_COLORS[i % RUN_COLORS.length]}
              fillOpacity={r.runId === selectedId ? 0.25 : 0.08}
              strokeWidth={r.runId === selectedId ? 2 : 1}
              strokeOpacity={r.runId === selectedId ? 1 : 0.6}
              onClick={() => onSelect(r.runId)}
              style={{ cursor: 'pointer' }}
            />
          ))}
          <RechartsTooltip
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              fontSize: '11px',
              color: 'var(--color-text-primary)',
            }}
            formatter={(value: number, name: string) => [
              (value * 100).toFixed(1) + '%',
              name,
            ]}
          />
        </RadarChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2">
        {completed.map((r, i) => (
          <button
            key={r.runId}
            type="button"
            onClick={() => onSelect(r.runId)}
            className="flex items-center gap-1.5 text-xs transition-opacity"
            style={{ opacity: selectedId === r.runId || !selectedId ? 1 : 0.45 }}
            aria-label={`Select ${strategyLabel(r.retrievalStrategy)} run`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: RUN_COLORS[i % RUN_COLORS.length] }}
              aria-hidden="true"
            />
            <span style={{ color: 'var(--color-text-primary)' }}>
              {strategyLabel(r.retrievalStrategy)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Latency bar chart
// ---------------------------------------------------------------------------

function LatencyBars({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunResult[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const completed = runs
    .filter(r => r.status === 'completed' && r.latencyMs !== null)
    .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))

  if (completed.length === 0) return null

  const data = completed.map(r => ({
    id: r.runId,
    name: strategyLabel(r.retrievalStrategy),
    latency: Math.round(r.latencyMs ?? 0),
  }))

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
        Retrieval latency
      </h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barCategoryGap="35%">
          <XAxis
            dataKey="name"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => `${(v / 1000).toFixed(1)}s`}
          />
          <RechartsTooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              fontSize: '11px',
              color: 'var(--color-text-primary)',
            }}
            formatter={(value: number, _: string, props: { payload?: { id: string } }) => [
              `${value.toLocaleString()} ms, ${latencyLabel(value)}`,
              props.payload?.id ? strategyLabel(completed.find(r => r.runId === props.payload?.id)?.retrievalStrategy ?? '') : '',
            ]}
          />
          <Bar dataKey="latency" radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={d.id}
                fill={selectedId === d.id || !selectedId ? RUN_COLORS[i % RUN_COLORS.length] : 'var(--color-border)'}
                onClick={() => onSelect(d.id)}
                style={{ cursor: 'pointer' }}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

function ComparisonTable({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunResult[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('faithfulness')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const completed = runs.filter(r => r.status === 'completed')
  if (completed.length === 0) return null

  const best: Record<string, number> = {
    faithfulness:        Math.max(...completed.map(r => r.faithfulness       ?? -Infinity)),
    contextUtilization:  Math.max(...completed.map(r => r.contextUtilization ?? -Infinity)),
    answerRelevancy:     Math.max(...completed.map(r => r.answerRelevancy    ?? -Infinity)),
    latencyMs:        Math.min(...completed.map(r => r.latencyMs        ?? Infinity)), // best = fastest
  }
  const worst: Record<string, number> = {
    faithfulness:        Math.min(...completed.map(r => r.faithfulness       ?? Infinity)),
    contextUtilization:  Math.min(...completed.map(r => r.contextUtilization ?? Infinity)),
    answerRelevancy:     Math.min(...completed.map(r => r.answerRelevancy    ?? Infinity)),
    latencyMs:        Math.max(...completed.map(r => r.latencyMs        ?? -Infinity)),
  }

  const sorted = [...completed].sort((a, b) => {
    const va = a[sortKey as keyof RunResult] as number ?? 0
    const vb = b[sortKey as keyof RunResult] as number ?? 0
    // For latency: lower is better, so flip the comparison for 'desc'
    const flip = sortKey === 'latencyMs' ? -1 : 1
    return sortDir === 'desc' ? flip * (vb - va) : flip * (va - vb)
  })

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (k !== sortKey) return <ChevronDown size={11} style={{ opacity: 0.3 }} aria-hidden="true" />
    return sortDir === 'desc'
      ? <ChevronDown size={11} style={{ color: 'var(--color-accent)' }} aria-hidden="true" />
      : <ChevronUp   size={11} style={{ color: 'var(--color-accent)' }} aria-hidden="true" />
  }

  function cellColor(key: string, value: number | null): string {
    if (value === null) return 'var(--color-text-secondary)'
    if (value === best[key])  return '#4ADE80' // green for best
    if (value === worst[key] && completed.length > 1) return 'rgba(255,107,107,0.75)' // red for worst
    return 'var(--color-text-primary)'
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
        Full comparison
      </h3>
      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--color-border)' }}>
        <table className="w-full text-xs" role="grid" aria-label="Benchmark comparison table">
          <thead>
            <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
              <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
                Strategy
              </th>
              {(['faithfulness', 'contextUtilization', 'answerRelevancy'] as MetricKey[]).map(k => (
                <th key={k} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => handleSort(k)}
                    className="flex items-center gap-1 font-semibold mx-auto"
                    style={{ color: sortKey === k ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
                    aria-label={`Sort by ${METRIC_LABELS[k]}`}
                  >
                    <InfoTooltip text={METRIC_TOOLTIPS[k]}>
                      <span className="underline decoration-dotted">{METRIC_LABELS[k]}</span>
                    </InfoTooltip>
                    <SortIcon k={k} />
                  </button>
                </th>
              ))}
              <th className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => handleSort('latencyMs')}
                  className="flex items-center gap-1 font-semibold mx-auto"
                  style={{ color: sortKey === 'latencyMs' ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
                  aria-label="Sort by latency"
                >
                  Latency <SortIcon k="latencyMs" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr
                key={r.runId}
                onClick={() => onSelect(r.runId)}
                className="transition-colors cursor-pointer"
                style={{
                  background: selectedId === r.runId ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.04)' : 'transparent',
                  borderBottom: '1px solid var(--color-border)',
                }}
                aria-selected={selectedId === r.runId}
                role="row"
              >
                <td className="px-4 py-3 font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  {strategyLabel(r.retrievalStrategy)}
                </td>
                {(['faithfulness', 'contextUtilization', 'answerRelevancy'] as MetricKey[]).map(k => (
                  <td key={k} className="px-4 py-3 text-center font-mono font-semibold"
                    style={{ color: cellColor(k, r[k]) }}>
                    {r[k] !== null ? (r[k]! * 100).toFixed(1) + '%' : '--'}
                  </td>
                ))}
                <td className="px-4 py-3 text-center font-mono" style={{ color: cellColor('latencyMs', r.latencyMs) }}>
                  {r.latencyMs !== null ? `${Math.round(r.latencyMs).toLocaleString()} ms` : '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Score card (single metric, count-up animation)
// ---------------------------------------------------------------------------

function ScoreCard({
  label,
  value,
  metricKey,
  sparkValues,
  delay,
}: {
  label: string
  value: number | null
  metricKey: MetricKey | 'latencyMs'
  sparkValues: number[]
  delay: number
}) {
  const displayValue = value ?? 0
  const isLatency = metricKey === 'latencyMs'
  const animated = useCountUp(displayValue, 1200, delay)

  const interpretation =
    !isLatency && value !== null
      ? metricInterpretation(metricKey as MetricKey, value)
      : isLatency && value !== null
      ? `${latencyLabel(value)} retrieval`
      : ''

  const formatted = isLatency
    ? `${Math.round(animated).toLocaleString()} ms`
    : `${(animated * 100).toFixed(1)}%`

  return (
    <div
      className="card flex flex-col gap-3"
      style={{ minHeight: '160px' }}
    >
      <p className="metric-label">{label}</p>

      <p
        className="text-3xl font-black font-mono leading-none"
        style={{ color: value === null ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}
        aria-label={`${label}: ${formatted}`}
      >
        {value !== null ? formatted : '--'}
      </p>

      {interpretation && (
        <p className="text-xs leading-snug flex-1" style={{ color: 'var(--color-text-secondary)' }}>
          {interpretation}
        </p>
      )}

      {/* Sparkline -- shown when there are 2+ values for this metric */}
      {sparkValues.length >= 2 && (
        <div className="h-8 mt-auto" aria-hidden="true">
          <ResponsiveContainer width="100%" height={32}>
            <LineChart data={sparkValues.map((v, i) => ({ i, v }))}>
              <Line
                type="monotone"
                dataKey="v"
                dot={false}
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                strokeOpacity={0.6}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function ScoreCards({ run, allRuns }: { run: RunResult; allRuns: RunResult[] }) {
  const forStrategy = allRuns.filter(
    r => r.retrievalStrategy === run.retrievalStrategy && r.status === 'completed'
  )

  const sparkFor = (key: MetricKey | 'latencyMs') =>
    forStrategy.map(r => (r[key as keyof RunResult] as number | null) ?? 0).reverse()

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 xl:gap-6">
      <ScoreCard label="Faithfulness"      value={run.faithfulness}     metricKey="faithfulness"     sparkValues={sparkFor('faithfulness')}     delay={0}   />
      <ScoreCard label="Context Utilization" value={run.contextUtilization} metricKey="contextUtilization" sparkValues={sparkFor('contextUtilization')} delay={80}  />
      <ScoreCard label="Answer Relevancy"  value={run.answerRelevancy}  metricKey="answerRelevancy"  sparkValues={sparkFor('answerRelevancy')}  delay={160} />
      <ScoreCard label="Latency"           value={run.latencyMs}        metricKey="latencyMs"        sparkValues={sparkFor('latencyMs')}        delay={240} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Step 3 component
// ---------------------------------------------------------------------------

export default function Step3Results() {
  const { state, dispatch, addRunResult, clearHistory, setStep } = useAppContext()

  const runId   = state.runId
  const history = state.runHistory

  const [polling, setPolling]       = useState(!history.find(r => r.runId === runId))
  const [pollError, setPollError]   = useState<string | null>(null)
  const [startedAt]                 = useState(Date.now)
  const [selectedId, setSelectedId] = useState<string | null>(runId)

  // Prevent adding the same run twice across re-renders
  const addedRef = useRef(new Set<string>())

  // Restore a previously seen run_id on mount
  useEffect(() => {
    if (runId && history.find(r => r.runId === runId)) {
      addedRef.current.add(runId)
      setPolling(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Polling effect
  useEffect(() => {
    if (!runId || !polling) return

    const id = setInterval(async () => {
      try {
        const res = await getRunStatus(runId)
        if (res.status === 'completed' || res.status === 'failed') {
          clearInterval(id)
          setPolling(false)

          if (!addedRef.current.has(runId)) {
            addedRef.current.add(runId)
            addRunResult({
              runId:              res.id,
              retrievalStrategy:  res.retrieval_strategy,
              question:           res.question,
              faithfulness:       res.faithfulness,
              contextUtilization: res.context_utilization,
              answerRelevancy:    res.answer_relevancy,
              latencyMs:          res.latency_ms,
              generatedAnswer:    res.generated_answer,
              retrievedChunks:    res.retrieved_chunks,
              timestamp:          Date.now(),
              status:             res.status,
              errorMessage:       res.error_message ?? undefined,
            })
          }

          if (res.status === 'failed') {
            setPollError(res.error_message ?? 'The evaluation run failed.')
          }
        }
      } catch {
        // Network hiccup -- keep polling; only surface persistent errors
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [runId, polling]) // eslint-disable-line react-hooks/exhaustive-deps

  const completed = history.filter(r => r.status === 'completed')
  const selectedRun = history.find(r => r.runId === selectedId) ?? completed[0] ?? null

  const handleSelect = useCallback((id: string) => setSelectedId(id), [])

  const handleClearHistory = () => {
    clearHistory()
    dispatch({ type: 'SET_RUN_ID', payload: '' })
    setSelectedId(null)
  }

  // ---- Render: polling state
  if (polling) {
    return <PollingProgress startedAt={startedAt} />
  }

  // ---- Render: failed run
  if (pollError) {
    return (
      <div className="max-w-2xl mx-auto py-16 flex flex-col items-center gap-6 text-center">
        <p className="text-sm" style={{ color: '#FF6B6B' }}>{pollError}</p>
        <button onClick={() => setStep(2)} className="btn-ghost">
          <ArrowLeft size={14} aria-hidden="true" /> Back to configure
        </button>
      </div>
    )
  }

  // ---- Render: no results yet (edge case)
  if (completed.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-16 flex flex-col items-center gap-4 text-center">
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          No completed runs yet.
        </p>
        <button onClick={() => setStep(2)} className="btn-ghost">
          Run a benchmark
        </button>
      </div>
    )
  }

  // ---- Render: results dashboard
  return (
    <div className="w-full flex flex-col gap-10 py-6">

      {/* Actions bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setStep(2)} className="btn-ghost text-xs flex items-center gap-1.5"
            aria-label="Run another benchmark with this corpus">
            <RotateCcw size={13} aria-hidden="true" /> Run again
          </button>
          <button type="button" onClick={() => setStep(1)} className="btn-ghost text-xs flex items-center gap-1.5"
            aria-label="Upload a new corpus">
            <ArrowLeft size={13} aria-hidden="true" /> New corpus
          </button>
        </div>
        <button type="button" onClick={handleClearHistory}
          className="flex items-center gap-1.5 text-xs transition-colors"
          style={{ color: 'var(--color-text-secondary)' }}
          aria-label="Clear run history and reset charts">
          <Trash2 size={13} aria-hidden="true" /> Clear history
        </button>
      </div>

      {/* Winner badge */}
      <WinnerBadge runs={completed} />

      {/*
       * xl layout: radar chart LEFT, score cards RIGHT (side by side).
       * Below lg: stacked -- radar first, then score cards.
       * The xl grid gives the radar more height (auto) while score cards
       * fill the right column with their 2x2 grid.
       */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 xl:gap-10 items-start">
        {/* Left: radar chart */}
        <div className="card">
          <MetricRadar runs={completed} selectedId={selectedId} onSelect={handleSelect} />
        </div>

        {/* Right: score cards (2x2 grid) */}
        {selectedRun && (
          <div>
            <ScoreCards run={selectedRun} allRuns={history} />
          </div>
        )}
      </div>

      {/* Latency bar chart -- full width */}
      <div className="card">
        <LatencyBars runs={completed} selectedId={selectedId} onSelect={handleSelect} />
      </div>

      {/* Comparison table */}
      <ComparisonTable runs={completed} selectedId={selectedId} onSelect={handleSelect} />

      {/* Generated answer for selected run */}
      {selectedRun?.generatedAnswer && (
        <div>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
            Generated answer
            <span className="ml-2 text-xs font-normal" style={{ color: 'var(--color-text-secondary)' }}>
              {strategyLabel(selectedRun.retrievalStrategy)}
            </span>
          </h3>
          <div className="card">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-primary)' }}>
              {selectedRun.generatedAnswer}
            </p>
            <p className="text-xs mt-4" style={{ color: 'var(--color-text-secondary)' }}>
              Q: {selectedRun.question}
            </p>
          </div>
        </div>
      )}

      {/* Proceed to Chat */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setStep(4)}
          className="btn-accent"
          aria-label="Proceed to chat interface"
        >
          Chat with corpus
        </button>
      </div>

    </div>
  )
}
