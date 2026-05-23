'use client'

/**
 * Step 3 -- Multi-strategy live results dashboard.
 *
 * Reads state.runIds (the array of run_ids returned by /benchmark, parallel
 * to state.selectedStrategies) and polls every entry independently. As each
 * run reaches a terminal state ("completed" or "failed"), its result is
 * added to runHistory and the corresponding chart and table cells update
 * immediately - the dashboard does not wait for all strategies to finish.
 *
 * Strategies still in progress do NOT show up in the comparison table.
 * Instead, a banner at the top reports "M of N still evaluating" so the
 * table only ever contains terminal rows (completed, failed). Failed runs
 * appear as red rows; other charts (radar, latency, score cards) render
 * once at least one strategy has completed.
 *
 * Run history persists across browser sessions in localStorage so the
 * comparison view accumulates across multiple benchmark submissions.
 * Within the table, rows are split into "current submission" (the runs
 * just kicked off in Step 2, in click order) and "Prior runs" (everything
 * else), deduplicated by runId so the same run never appears twice.
 */

import {
  useCallback,
  useEffect,
  useMemo,
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
import { Trophy, ArrowLeft, RotateCcw, Trash2, ChevronUp, ChevronDown, Loader2, Info } from 'lucide-react'
import { useAppContext, type RunResult } from '@/context/AppContext'
import { getRunStatus } from '@/lib/api'
import { formatLatency } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000

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

/**
 * Per-metric weights used by the winner calculation. Latency is intentionally
 * excluded from the score because latency is a cost dimension, not a quality
 * one: a fast but wrong answer should not outrank a slower correct one. Null
 * metrics are treated as zero so a run with a missing metric is penalised
 * proportionally rather than silently inflated by removing it from the mean.
 */
const SCORE_WEIGHTS = {
  faithfulness:       0.4,
  contextUtilization: 0.3,
  answerRelevancy:    0.3,
} as const

/**
 * Compute the run's weighted average score in the [0, 1] range using
 * SCORE_WEIGHTS. Null metrics contribute 0, so the formula stays consistent
 * regardless of how many metrics RAGAS managed to produce.
 */
function weightedAverage(r: RunResult): number {
  return (
    (r.faithfulness        ?? 0) * SCORE_WEIGHTS.faithfulness +
    (r.contextUtilization  ?? 0) * SCORE_WEIGHTS.contextUtilization +
    (r.answerRelevancy     ?? 0) * SCORE_WEIGHTS.answerRelevancy
  )
}

const WINNER_FORMULA_TOOLTIP =
  'Winner is the strategy with the highest weighted average score: ' +
  'Faithfulness 40% + Context Utilization 30% + Answer Relevancy 30%. ' +
  'Null metrics are scored as 0. Latency is not included in the score.'

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
// Live progress banner (replaces the prior full-screen polling indicator)
// ---------------------------------------------------------------------------

function LiveProgressBanner({
  pendingCount,
  totalCount,
}: {
  pendingCount: number
  totalCount: number
}) {
  if (pendingCount === 0) return null
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl"
      style={{
        background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.05)',
        border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.18)',
      }}
      role="status"
      aria-live="polite"
    >
      <Loader2
        size={16}
        className="animate-spin"
        style={{ color: 'var(--color-accent)' }}
        aria-hidden="true"
      />
      <p className="text-xs" style={{ color: 'var(--color-text-primary)' }}>
        Evaluating {pendingCount} of {totalCount} {totalCount === 1 ? 'strategy' : 'strategies'}.
        Results appear as each one finishes.
      </p>
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
          <InfoTooltip text={WINNER_FORMULA_TOOLTIP}>
            <Info
              size={13}
              style={{ color: 'var(--color-text-secondary)', cursor: 'help' }}
              aria-hidden="true"
            />
          </InfoTooltip>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
          Highest weighted average. Led on {bestMetric}.
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
              `${formatLatency(value)}, ${latencyLabel(value)}`,
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
//
// Pending strategies are NOT shown here -- the LiveProgressBanner above the
// table communicates "M of N still evaluating" instead. Only terminal rows
// (completed, failed) render in the table so the row count stays consistent
// with the run state.
//
// Rows are split into two sections:
//   - Current submission: runs whose runId is in state.runIds, ordered to
//     match the selectedStrategies click order
//   - Prior runs: history rows whose runId is not in the current submission,
//     separated by a faint divider row labelled "Prior runs"
//
// Newly arrived rows (recorded in newRunIds for one render tick) get a
// subtle slide/fade transition the first time they paint.

interface FailedRow {
  strategy: string
  errorMessage: string
}

function ComparisonTable({
  currentRuns,
  priorRuns,
  failed,
  selectedId,
  newRunIds,
  onSelect,
}: {
  currentRuns: RunResult[]
  priorRuns:   RunResult[]
  failed:      FailedRow[]
  selectedId:  string | null
  newRunIds:   Set<string>
  onSelect:    (id: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('faithfulness')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const completed = [...currentRuns, ...priorRuns]
  const hasAnything = completed.length > 0 || failed.length > 0
  if (!hasAnything) return null

  // Best / worst computed across all completed rows so colour-coding is
  // consistent whether the cell sits in the current or prior section.
  const safeMin = (vals: number[]) => (vals.length ? Math.min(...vals) : Infinity)
  const safeMax = (vals: number[]) => (vals.length ? Math.max(...vals) : -Infinity)

  const best: Record<string, number> = {
    faithfulness:        safeMax(completed.map(r => r.faithfulness       ?? -Infinity)),
    contextUtilization:  safeMax(completed.map(r => r.contextUtilization ?? -Infinity)),
    answerRelevancy:     safeMax(completed.map(r => r.answerRelevancy    ?? -Infinity)),
    latencyMs:           safeMin(completed.map(r => r.latencyMs          ?? Infinity)),
  }
  const worst: Record<string, number> = {
    faithfulness:        safeMin(completed.map(r => r.faithfulness       ?? Infinity)),
    contextUtilization:  safeMin(completed.map(r => r.contextUtilization ?? Infinity)),
    answerRelevancy:     safeMin(completed.map(r => r.answerRelevancy    ?? Infinity)),
    latencyMs:           safeMax(completed.map(r => r.latencyMs          ?? -Infinity)),
  }

  /**
   * Sort runs by the active sort key. Sorting only reorders within each
   * section -- we never interleave current and prior rows, since the divider
   * row would lose its meaning if rows crossed it.
   */
  const sortRuns = (rs: RunResult[]) =>
    [...rs].sort((a, b) => {
      const va = (a[sortKey as keyof RunResult] as number | null) ?? 0
      const vb = (b[sortKey as keyof RunResult] as number | null) ?? 0
      // Lower latency is better, so invert the sign for latency sorts.
      const flip = sortKey === 'latencyMs' ? -1 : 1
      return sortDir === 'desc' ? flip * (vb - va) : flip * (va - vb)
    })

  const sortedCurrent = sortRuns(currentRuns)
  const sortedPrior   = sortRuns(priorRuns)

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

  /**
   * Render a single body row for a completed run. Rows whose runId is in
   * `newRunIds` get a brief enter transition so they fade in instead of
   * popping when polling finishes.
   */
  const renderRow = (r: RunResult) => {
    const isNew = newRunIds.has(r.runId)
    return (
      <tr
        key={r.runId}
        onClick={() => onSelect(r.runId)}
        className="cursor-pointer transition-all duration-300 ease-out"
        style={{
          background: selectedId === r.runId
            ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.04)'
            : 'transparent',
          borderBottom: '1px solid var(--color-border)',
          // Newly arrived rows start slightly translated and faded; the
          // transition above carries them to the resting state on the next
          // tick.
          opacity:   isNew ? 0 : 1,
          transform: isNew ? 'translateY(-4px)' : 'translateY(0)',
        }}
        aria-selected={selectedId === r.runId}
        role="row"
      >
        <td className="px-4 py-3 font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {strategyLabel(r.retrievalStrategy)}
        </td>
        {(['faithfulness', 'contextUtilization', 'answerRelevancy'] as MetricKey[]).map(k => (
          <td
            key={k}
            className="px-4 py-3 text-center font-mono font-semibold"
            style={{ color: cellColor(k, r[k]) }}
          >
            {r[k] !== null ? (r[k]! * 100).toFixed(1) + '%' : '--'}
          </td>
        ))}
        <td
          className="px-4 py-3 text-center font-mono"
          style={{ color: cellColor('latencyMs', r.latencyMs) }}
        >
          {r.latencyMs !== null ? formatLatency(r.latencyMs) : '--'}
        </td>
      </tr>
    )
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
            {sortedCurrent.map(renderRow)}

            {/* Failed rows belong to the current submission and sit at the
                bottom of the current section. */}
            {failed.map(({ strategy, errorMessage }) => (
              <tr
                key={`fail-${strategy}`}
                className="transition-colors"
                style={{
                  background: 'rgba(255,107,107,0.04)',
                  borderBottom: '1px solid var(--color-border)',
                }}
                role="row"
              >
                <td className="px-4 py-3 font-medium" style={{ color: '#FF6B6B' }}>
                  {strategyLabel(strategy)}
                </td>
                <td colSpan={4} className="px-4 py-3 text-center text-xs" style={{ color: 'rgba(255,107,107,0.85)' }}>
                  failed: {errorMessage}
                </td>
              </tr>
            ))}

            {/* Divider row + prior-session runs, only when there is at least
                one prior run that is not part of the current submission. */}
            {sortedPrior.length > 0 && (
              <tr
                aria-hidden="true"
                style={{
                  background: 'var(--color-surface)',
                  borderTop:    '1px solid var(--color-border)',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <td
                  colSpan={5}
                  className="px-4 py-2 text-[10px] font-semibold tracking-widest uppercase"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Prior runs
                </td>
              </tr>
            )}
            {sortedPrior.map(renderRow)}
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
    ? formatLatency(animated)
    : `${(animated * 100).toFixed(1)}%`

  // The card is split into three vertical zones so every metric card lines
  // up regardless of string lengths:
  //   top    -- label, fixed
  //   middle -- value, vertically centered (flex-1 + justify-center)
  //   bottom -- interpretation, fixed at the floor
  // The optional sparkline tucks in below the description.
  return (
    <div className="card flex flex-col h-full">
      <p className="metric-label">{label}</p>

      <div className="flex-1 flex flex-col justify-center py-2">
        <p
          className="text-3xl font-black font-mono leading-none"
          style={{ color: value === null ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}
          aria-label={`${label}: ${formatted}`}
        >
          {value !== null ? formatted : '--'}
        </p>
      </div>

      <p
        className="text-xs leading-snug"
        style={{
          color: 'var(--color-text-secondary)',
          // Keep the bottom band the same height across cards regardless of
          // whether an interpretation string is present, so labels and
          // values line up across the 2x2 grid.
          minHeight: '2.5rem',
        }}
      >
        {interpretation}
      </p>

      {sparkValues.length >= 2 && (
        <div className="h-8 mt-2" aria-hidden="true">
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

  /*
   * 2x2 grid (`grid-rows-2`) so the cards stretch to fill the radar panel's
   * height when the parent uses items-stretch. `h-full` on the wrapper plus
   * `h-full` on each card ensures internal zones line up regardless of how
   * tall the row becomes.
   */
  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-4 xl:gap-6 h-full">
      <ScoreCard label="Faithfulness"        value={run.faithfulness}       metricKey="faithfulness"       sparkValues={sparkFor('faithfulness')}       delay={0}   />
      <ScoreCard label="Context Utilization" value={run.contextUtilization} metricKey="contextUtilization" sparkValues={sparkFor('contextUtilization')} delay={80}  />
      <ScoreCard label="Answer Relevancy"    value={run.answerRelevancy}    metricKey="answerRelevancy"    sparkValues={sparkFor('answerRelevancy')}    delay={160} />
      <ScoreCard label="Latency"             value={run.latencyMs}          metricKey="latencyMs"          sparkValues={sparkFor('latencyMs')}          delay={240} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Step 3 component
// ---------------------------------------------------------------------------

export default function Step3Results() {
  const { state, dispatch, addRunResult, clearHistory, setStep } = useAppContext()

  // Pull parallel arrays out of context. runIds[i] corresponds to
  // selectedStrategies[i] - the backend returns run_ids in the same order
  // the strategies list was sent.
  const runIds = state.runIds
  const strategies = state.selectedStrategies
  const history = state.runHistory

  // Map runId -> strategy for the current submission. Used by failed-row
  // rendering to label each error row with the strategy that produced it.
  const strategyByRunId = useMemo(() => {
    const m: Record<string, string> = {}
    runIds.forEach((id, i) => { m[id] = strategies[i] ?? 'unknown' })
    return m
  }, [runIds, strategies])

  // Tracks runIds whose terminal state has already been observed and pushed
  // to runHistory. Initialized from history in case the user revisits Step 3
  // after a tab refresh or a back-then-forward navigation.
  const [completedRunIds, setCompletedRunIds] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const r of history) {
      if (runIds.includes(r.runId)) initial.add(r.runId)
    }
    return initial
  })

  const [errorByRunId, setErrorByRunId] = useState<Record<string, string>>({})
  const [pollError, setPollError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Ref-based "already-added" guard prevents double-inserting a result into
  // runHistory across re-renders. addedRef survives re-renders while
  // state-based dedupe would not because state updates are async.
  const addedRef = useRef<Set<string>>(new Set())

  // The pending runIds (subset of runIds not yet terminal) drives the polling
  // effect. Joining to a string gives the effect a stable primitive dep so
  // the interval is only torn down and rebuilt when set membership changes.
  const pendingRunIds = useMemo(
    () => runIds.filter(id => !completedRunIds.has(id)),
    [runIds, completedRunIds]
  )
  const pendingKey = pendingRunIds.join(',')

  // Polling effect: every POLL_INTERVAL_MS, query the status of every still-
  // pending run in parallel. When one terminates, push it into runHistory
  // and add its id to completedRunIds so the next tick stops polling it.
  // Other pending runs continue independently.
  useEffect(() => {
    if (pendingRunIds.length === 0) return

    const interval = setInterval(async () => {
      await Promise.all(
        pendingRunIds.map(async (runId) => {
          try {
            const res = await getRunStatus(runId)
            if (res.status === 'completed' || res.status === 'failed') {
              if (addedRef.current.has(runId)) return
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

              setCompletedRunIds(prev => {
                const next = new Set(prev)
                next.add(runId)
                return next
              })

              if (res.status === 'failed') {
                setErrorByRunId(prev => ({
                  ...prev,
                  [runId]: res.error_message ?? 'The evaluation run failed.',
                }))
              } else {
                // First successful completion picks up the focus selection
                // so the radar/score cards have something to highlight.
                setSelectedId(prev => prev ?? res.id)
              }
            }
          } catch {
            // Network hiccup -- keep polling. A persistent connectivity
            // failure surfaces via the per-run timeouts on the backend.
          }
        })
      )
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  // pendingKey changes only when the set membership of pendingRunIds changes,
  // not on every re-render -- avoids tearing down the interval unnecessarily.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey])

  // Surface a poll-level error only when ALL strategies in the current
  // submission have failed. Per-strategy failures are shown as table rows
  // instead so other strategies continue to be visible.
  useEffect(() => {
    if (runIds.length === 0) return
    const failedCount = runIds.filter(id => errorByRunId[id]).length
    if (failedCount === runIds.length) {
      setPollError(
        'Every strategy in this run failed. See the per-strategy errors in the table below.'
      )
    } else {
      setPollError(null)
    }
  }, [errorByRunId, runIds])

  /*
   * Build a deduplicated list of completed runs keyed by runId. The history
   * array already prepends new arrivals, so iterating in order and keeping
   * the first occurrence of each runId gives the freshest copy. This guards
   * against the corner case where a runId is somehow recorded twice (e.g.
   * tab refresh mid-poll).
   */
  const completed = useMemo(() => {
    const seen = new Set<string>()
    const result: RunResult[] = []
    for (const r of history) {
      if (r.status !== 'completed') continue
      if (seen.has(r.runId)) continue
      seen.add(r.runId)
      result.push(r)
    }
    return result
  }, [history])

  /*
   * Runs that belong to the CURRENT submission, in the same click order the
   * user picked in Step 2. We look each runId up by id rather than filtering
   * `completed` so the order matches state.runIds exactly. Runs still
   * pending have no entry in `completed` and are skipped here -- they show
   * up in the LiveProgressBanner instead.
   */
  const currentRuns = useMemo(() => {
    const byId = new Map(completed.map(r => [r.runId, r]))
    return runIds
      .map(id => byId.get(id))
      .filter((r): r is RunResult => Boolean(r))
  }, [completed, runIds])

  /*
   * Prior-session runs: anything in completed that is not part of the
   * current submission. Deduplication by runId already happened above so
   * this is a straightforward filter.
   */
  const priorRuns = useMemo(() => {
    const currentSet = new Set(runIds)
    return completed.filter(r => !currentSet.has(r.runId))
  }, [completed, runIds])

  const failed = Object.entries(errorByRunId).map(([id, msg]) => ({
    strategy: strategyByRunId[id] ?? 'unknown',
    errorMessage: msg,
  }))

  /*
   * Track which runIds are "newly arrived" so their table rows can animate
   * in with a fade/slide transition the first time they paint. seenRef is
   * primed on the first effect run with whatever runs already exist (so
   * history runs do not all animate together on mount); subsequent arrivals
   * via polling get the transition.
   */
  const seenRef = useRef<Set<string> | null>(null)
  const [newRunIds, setNewRunIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const allIds = [...currentRuns, ...priorRuns].map(r => r.runId)
    if (seenRef.current === null) {
      seenRef.current = new Set(allIds)
      return
    }
    const newlyArrived = allIds.filter(id => !seenRef.current!.has(id))
    if (newlyArrived.length === 0) return
    newlyArrived.forEach(id => seenRef.current!.add(id))
    setNewRunIds(prev => {
      const next = new Set(prev)
      newlyArrived.forEach(id => next.add(id))
      return next
    })
    // Clear the "new" flag on the next tick so the row's resting style
    // takes effect, triggering the CSS transition declared on the <tr>.
    const t = setTimeout(() => {
      setNewRunIds(prev => {
        const next = new Set(prev)
        newlyArrived.forEach(id => next.delete(id))
        return next
      })
    }, 50)
    return () => clearTimeout(t)
  }, [currentRuns, priorRuns])

  // The score-card focus run: explicit selection wins; otherwise pick the
  // most recently completed run in the current submission, then fall back
  // to the most recent in the entire history. `completed` is already the
  // deduped list, so this never returns the same runId twice.
  const selectedRun = useMemo(() => {
    if (selectedId) {
      const explicit = completed.find(r => r.runId === selectedId)
      if (explicit) return explicit
    }
    const fromSubmission = completed.find(r => runIds.includes(r.runId))
    return fromSubmission ?? completed[0] ?? null
  }, [selectedId, runIds, completed])

  const handleSelect = useCallback((id: string) => setSelectedId(id), [])

  const handleClearHistory = () => {
    clearHistory()
    dispatch({ type: 'SET_RUN_IDS', payload: [] })
    dispatch({ type: 'SET_SELECTED_STRATEGIES', payload: [] })
    setSelectedId(null)
    setCompletedRunIds(new Set())
    setErrorByRunId({})
    addedRef.current = new Set()
  }

  // ---- Render: empty state (no current submission and no history)
  if (
    runIds.length === 0 &&
    history.length === 0 &&
    pendingRunIds.length === 0 &&
    failed.length === 0
  ) {
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

      {/* Live progress banner -- visible only while strategies are pending */}
      <LiveProgressBanner pendingCount={pendingRunIds.length} totalCount={runIds.length} />

      {/* All-failed banner (per-strategy errors still appear in the table) */}
      {pollError && (
        <div
          className="flex items-start gap-2 p-4 rounded-xl text-sm"
          style={{ background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#FF6B6B' }}
          role="alert"
        >
          <span>{pollError}</span>
        </div>
      )}

      {/* Winner badge */}
      <WinnerBadge runs={completed} />

      {/*
       * xl layout: radar chart LEFT, score cards RIGHT (side by side).
       * Below lg: stacked -- radar first, then score cards.
       *
       * `items-stretch` lets the right-hand column grow to match the radar
       * panel's height. ScoreCards uses `h-full` + `grid-rows-2` so the
       * four metric cards expand to fill that height in a 2x2 layout.
       */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 xl:gap-10 items-stretch">
        <div className="card">
          <MetricRadar runs={completed} selectedId={selectedId} onSelect={handleSelect} />
        </div>

        {selectedRun && (
          <div className="h-full">
            <ScoreCards run={selectedRun} allRuns={history} />
          </div>
        )}
      </div>

      {/* Latency bar chart -- full width */}
      {completed.length > 0 && (
        <div className="card">
          <LatencyBars runs={completed} selectedId={selectedId} onSelect={handleSelect} />
        </div>
      )}

      {/* Comparison table -- shows terminal rows only. Pending strategies
          live in the LiveProgressBanner above. */}
      <ComparisonTable
        currentRuns={currentRuns}
        priorRuns={priorRuns}
        failed={failed}
        selectedId={selectedId}
        newRunIds={newRunIds}
        onSelect={handleSelect}
      />

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

      {/* Proceed to Chat -- only enabled once at least one run has completed
          so the chat picks a sensible default strategy. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setStep(4)}
          className="btn-accent"
          disabled={completed.length === 0}
          aria-label="Proceed to chat interface"
        >
          Chat with corpus
        </button>
      </div>

    </div>
  )
}
