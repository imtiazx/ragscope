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
import { Trophy, ArrowLeft, RotateCcw, Trash2, ChevronUp, ChevronDown, Loader2, Info, CheckCircle2 } from 'lucide-react'
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

/**
 * Pick the run with the highest weighted score from the given list. Returns
 * null when the list is empty so callers can branch without a second length
 * check. Used by WinnerBadge, LatencyBars (to highlight the winner's bar in
 * accent teal), and the score-card default selection so all three always
 * agree on which run is "the winner."
 */
function pickWinner(runs: RunResult[]): RunResult | null {
  if (runs.length === 0) return null
  return runs.reduce(
    (best, r) => (weightedAverage(r) > weightedAverage(best) ? r : best),
    runs[0],
  )
}

/**
 * Cycle of human-readable status messages shown beneath the spinner while
 * any benchmark run is still pending. The list deliberately walks through
 * retrieval, fusion, then RAGAS scoring so the user has a sense that
 * something concrete is happening even when individual API calls are slow.
 */
const PROGRESS_MESSAGES: ReadonlyArray<string> = [
  'Retrieving relevant chunks from your corpus...',
  'Generating hypothetical documents with HyDE...',
  'Running BM25 sparse search and dense vector search...',
  'Merging results with Reciprocal Rank Fusion...',
  'Scoring faithfulness with gpt-4o-mini as judge...',
  'Measuring context utilization...',
  'Evaluating answer relevancy...',
  'Almost there, finalising RAGAS scores...',
]

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
// Evaluation progress card (engagement state shown before the first result)
// ---------------------------------------------------------------------------
//
// While the user waits for the first run to finish there is otherwise
// nothing on screen. This card keeps them engaged with three layers of
// feedback:
//   1. A spinning teal ring confirming work is happening
//   2. A cycling status message that walks through stages of the pipeline
//      every 3 seconds so the screen never feels frozen
//   3. A wide progress bar that animates from 0% to 85% over 70 seconds and
//      snaps to 100% when everything completes
//   4. Per-strategy pills showing pending/done state alongside the score
//      for any strategy that has already returned

interface ProgressPill {
  runId: string
  strategy: string
  done: boolean
  score: number | null
}

function EvaluationProgressCard({
  pills,
  totalDone,
  totalCount,
  resetKey,
}: {
  pills: ProgressPill[]
  totalDone: number
  totalCount: number
  /**
   * Changes whenever the parent wants the card to reset its internal
   * progress + message-cycle state (e.g. after Clear History). Used as a
   * dependency in the effects below.
   */
  resetKey: number
}) {
  const [messageIdx, setMessageIdx] = useState(0)
  // The bar starts at 0 and is set to 85% shortly after mount so the CSS
  // transition has a frame to register the initial 0% before animating.
  const [progress, setProgress] = useState(0)
  const allDone = totalDone === totalCount && totalCount > 0

  // Cycle the status message every 3 seconds. The interval reschedules
  // itself whenever resetKey changes so a fresh evaluation starts at the
  // first message instead of mid-cycle.
  useEffect(() => {
    setMessageIdx(0)
    const id = setInterval(
      () => setMessageIdx(i => (i + 1) % PROGRESS_MESSAGES.length),
      3000,
    )
    return () => clearInterval(id)
  }, [resetKey])

  // Drive the progress bar: 0 -> 85% over 70s while pending, then snap to
  // 100% once everything completes. The 100ms delay before the 85% kickoff
  // lets the browser commit the initial 0% width so the CSS transition
  // actually animates instead of jumping.
  useEffect(() => {
    setProgress(0)
    if (allDone) {
      setProgress(100)
      return
    }
    const t = setTimeout(() => setProgress(85), 100)
    return () => clearTimeout(t)
  }, [resetKey, allDone])

  return (
    <div
      className="card flex flex-col items-center gap-6 py-10 px-6"
      role="status"
      aria-live="polite"
      aria-label={`Evaluating ${totalCount - totalDone} of ${totalCount} strategies`}
    >
      {/*
       * Spinning ring built from a single div: the transparent top border
       * combined with the accent colour on the other three creates the
       * familiar "chasing arc" effect when spun.
       */}
      <div
        className="w-12 h-12 rounded-full border-4 animate-spin"
        style={{
          borderColor: 'var(--color-accent)',
          borderTopColor: 'transparent',
        }}
        aria-hidden="true"
      />

      {/*
       * The current message fades in/out via key change. Using a key on the
       * <p> element makes React unmount and remount it whenever messageIdx
       * advances, so the CSS opacity transition triggers cleanly each cycle.
       */}
      <p
        key={messageIdx}
        className="text-sm text-center transition-opacity duration-500"
        style={{
          color: 'var(--color-text-secondary)',
          // animation: a fresh node is rendered with opacity 1; the
          // duration-500 transition on opacity is consumed naturally by
          // the unmount/remount cycle so we do not need additional state.
        }}
      >
        {PROGRESS_MESSAGES[messageIdx]}
      </p>

      {/* Thin progress bar -- transitions over 70s, locked at 85% until
          everything finishes. */}
      <div
        className="w-full rounded-full h-1"
        style={{ background: 'var(--color-border)' }}
        aria-hidden="true"
      >
        <div
          className="h-1 rounded-full"
          style={{
            background: 'var(--color-accent)',
            width: `${progress}%`,
            transition: allDone
              ? 'width 400ms ease-out'
              : 'width 70000ms ease-out',
          }}
        />
      </div>

      {/* Strategy pills: pulsing dot when pending, green check + score
          when done. Gives the user granular visibility into which run
          they are still waiting on. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {pills.map(p => (
          <div
            key={p.runId}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
            style={{
              background: p.done
                ? 'rgba(74,222,128,0.08)'
                : 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)',
              border: `1px solid ${p.done
                ? 'rgba(74,222,128,0.25)'
                : 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)'}`,
              color: 'var(--color-text-primary)',
            }}
          >
            {p.done ? (
              <CheckCircle2
                size={12}
                style={{ color: '#4ADE80' }}
                aria-hidden="true"
              />
            ) : (
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: 'var(--color-accent)' }}
                aria-hidden="true"
              />
            )}
            <span>{strategyLabel(p.strategy)}</span>
            {p.done && p.score !== null && (
              <span
                className="font-mono"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {(p.score * 100).toFixed(1)}%
              </span>
            )}
          </div>
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
  const winner = pickWinner(completed)
  if (winner === null) return null

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
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
        Strategy comparison
      </h3>
      {/* min-h-0 + flex-1 lets the chart actually shrink to fit the
          available height without overflowing its flex parent. The
          recharts ResponsiveContainer requires a sized parent so a fixed
          minimum keeps the polygon readable when no other sibling forces a
          taller row. */}
      <div className="flex-1 min-h-0" style={{ minHeight: '280px' }}>
        <ResponsiveContainer width="100%" height="100%">
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
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-3">
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
  winnerId,
  onSelect,
}: {
  runs: RunResult[]
  selectedId: string | null
  winnerId:   string | null
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

  // The accent colour is whichever run the user clicked on; if nothing has
  // been selected yet the winner gets the spotlight so the chart always has
  // one bar that stands out. Other bars take a muted slate border colour so
  // they fade into the chart background.
  const highlightedId = selectedId ?? winnerId
  const ACCENT_FILL = 'var(--color-accent)'
  const MUTED_FILL  = 'var(--color-border)'

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
        Retrieval latency
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={data}
          barCategoryGap="35%"
          // barSize caps each bar's pixel width so a single tall bar does
          // not visually dominate the chart when latency values are similar.
          barSize={48}
          margin={{ top: 12, right: 16, bottom: 8, left: 8 }}
        >
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
            // domain [0, 'auto'] anchors the bottom at zero so the bar
            // heights communicate absolute latency, not relative differences.
            domain={[0, 'auto']}
            // Reuse formatLatency so the y-axis ticks match the format used
            // in score cards and the comparison table ("72.524 s" not "72524").
            tickFormatter={v => formatLatency(v)}
            width={64}
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
            {data.map(d => (
              <Cell
                key={d.id}
                fill={highlightedId === d.id ? ACCENT_FILL : MUTED_FILL}
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
    // Latency is graded on absolute thresholds, not relative position, so a
    // single fast run does not paint the only row green and a single slow
    // run does not paint everything red. Thresholds reflect what feels
    // "fast vs sluggish" on this benchmark surface specifically.
    if (key === 'latencyMs') {
      if (value <= 30_000) return '#4ADE80'           // green:  0 - 30 s
      if (value <= 60_000) return '#F59E0B'           // amber: 30 - 60 s
      return 'rgba(255,107,107,0.85)'                  // red:  60 s and up
    }
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

  // Three fixed vertical zones so every card lines up:
  //   1. Label, anchored at the top
  //   2. Value, vertically centred in the remaining space (flex-1 + items-center)
  //   3. Description, anchored at the bottom; min-height keeps alignment
  //      consistent across cards with shorter/missing interpretation text
  // The optional sparkline tucks below the description when present.
  return (
    <div className="card flex flex-col justify-between h-full p-4">
      <p className="metric-label">{label}</p>

      <div className="flex-1 flex items-center justify-start">
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
          // Reserve a constant bottom band so all four cards close at the
          // same baseline regardless of how long the interpretation string
          // is (or whether there is one at all).
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
    <div className="grid grid-cols-2 grid-rows-2 gap-3 h-full">
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

  /*
   * The winner of the current submission (or, if nothing in the submission
   * has completed yet, the winner across all history). Drives the radar
   * highlight, the latency-chart accent bar, and the default score-card
   * focus so all three views stay consistent with the WinnerBadge.
   */
  const winnerRun = useMemo(
    () => pickWinner(currentRuns.length > 0 ? currentRuns : completed),
    [currentRuns, completed],
  )

  // Focus run for the score cards. Explicit row click wins; otherwise we
  // surface the winner so the cards do not silently track whichever result
  // happened to arrive last from polling.
  const selectedRun = useMemo(() => {
    if (selectedId) {
      const explicit = completed.find(r => r.runId === selectedId)
      if (explicit) return explicit
    }
    return winnerRun
  }, [selectedId, completed, winnerRun])

  const handleSelect = useCallback((id: string) => setSelectedId(id), [])

  // Bumped whenever the user clears history (or when the polling state
  // transitions cleanly) so the EvaluationProgressCard restarts its
  // message-cycle and progress-bar animations from scratch.
  const [progressResetKey, setProgressResetKey] = useState(0)

  const handleClearHistory = () => {
    // If runs are still mid-flight, confirm before wiping their results;
    // otherwise the user clicks Clear by mistake and loses output that the
    // backend is about to produce.
    if (pendingRunIds.length > 0) {
      const ok = window.confirm(
        'Evaluations are still running. Clearing history will remove their ' +
        'results when they finish. Continue?',
      )
      if (!ok) return
    }
    clearHistory()
    dispatch({ type: 'SET_RUN_IDS', payload: [] })
    dispatch({ type: 'SET_SELECTED_STRATEGIES', payload: [] })
    setSelectedId(null)
    // Pre-populate completedRunIds with the now-empty runIds list so the
    // polling effect sees an empty pendingRunIds set and tears down cleanly.
    setCompletedRunIds(new Set())
    setErrorByRunId({})
    addedRef.current = new Set()
    // Re-arm the EvaluationProgressCard so its next appearance starts at the
    // first message and 0% progress instead of mid-animation.
    setProgressResetKey(k => k + 1)
  }

  /*
   * One pill per current-submission run, in click order. Pending pills show
   * the strategy and a pulse dot; completed pills show the strategy plus a
   * green check and weighted score.
   */
  const progressPills: ProgressPill[] = useMemo(
    () =>
      runIds.map((id, i) => {
        const r = completed.find(x => x.runId === id) ?? null
        return {
          runId: id,
          strategy: strategies[i] ?? 'unknown',
          done: r !== null,
          score: r !== null ? weightedAverage(r) : null,
        }
      }),
    [runIds, strategies, completed],
  )

  /*
   * Show the engagement card only before the first run of the current
   * submission reaches a terminal state. As soon as at least one current
   * run succeeds OR fails we drop back to the standard dashboard so the
   * user sees partial data immediately; the LiveProgressBanner above the
   * dashboard still indicates "M of N still evaluating" until everything
   * finishes. We also keep the engagement card hidden when there is no
   * current submission at all (so the dashboard can render the user's
   * prior history without interruption).
   */
  const showProgressCard =
    runIds.length > 0 &&
    pendingRunIds.length > 0 &&
    currentRuns.length === 0 &&
    failed.length === 0

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

      {/*
       * Engagement card while nothing from the current submission has
       * landed yet. Once the first result arrives we drop back to the
       * dashboard layout below; the LiveProgressBanner continues to show
       * "M of N still evaluating" until everything is done.
       */}
      {showProgressCard ? (
        <EvaluationProgressCard
          pills={progressPills}
          totalDone={progressPills.filter(p => p.done).length}
          totalCount={progressPills.length}
          resetKey={progressResetKey}
        />
      ) : (
        <>
          {/* Winner badge */}
          <WinnerBadge runs={completed} />

          {/*
           * xl layout: radar chart LEFT, score cards RIGHT (side by side).
           * Below lg: stacked -- radar first, then score cards.
           *
           * `items-stretch` lets the right-hand column grow to match the
           * radar panel's height. ScoreCards uses `h-full` + `grid-rows-2`
           * so the four metric cards expand to fill that height in a 2x2
           * layout. The radar's parent .card uses flex so the chart inside
           * can claim flex-1 of the available height.
           */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 xl:gap-10 items-stretch">
            <div className="card flex flex-col">
              <MetricRadar runs={completed} selectedId={selectedId ?? winnerRun?.runId ?? null} onSelect={handleSelect} />
            </div>

            {selectedRun && (
              <div className="h-full">
                <ScoreCards run={selectedRun} allRuns={completed} />
              </div>
            )}
          </div>

          {/* Latency bar chart -- full width */}
          {completed.length > 0 && (
            <div className="card">
              <LatencyBars
                runs={completed}
                selectedId={selectedId}
                winnerId={winnerRun?.runId ?? null}
                onSelect={handleSelect}
              />
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
        </>
      )}

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
