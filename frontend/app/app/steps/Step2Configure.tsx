'use client'

/**
 * Step 2 -- Configure and launch a multi-strategy benchmark.
 *
 * Collects the question, one or more retrieval strategies, per-strategy
 * parameters, and the orthogonal compression toggle, then POSTs them to
 * /benchmark as a single request. The backend creates one benchmark_runs
 * row and dispatches one background task per selected strategy and returns
 * all run_ids together with HTTP 202. The ids are stored in AppContext as
 * runIds (parallel to selectedStrategies) and Step 3 polls each independently,
 * streaming results into the comparison view as each strategy finishes.
 *
 * Selecting N strategies counts as N runs against the guest daily limit.
 * Below the strategy grid the user sees "This will use N of your X remaining
 * runs." so the cost of the click is visible before they make it. Dev mode
 * (Tier 0) shows "Dev mode - unlimited" instead of the counter.
 *
 * Compression is rendered as an independent toggle below the strategy
 * configuration, deliberately outside the strategy selection area. The same
 * compression setting is applied to every selected strategy when the request
 * is submitted.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronLeft, Zap } from 'lucide-react'
import { useAppContext } from '@/context/AppContext'
import { useUI } from '@/context/UIContext'
import ParamForm from '@/components/ParamForm'
import { fetchStrategies, createBenchmark } from '@/lib/api'
import type { RetrieverInfo, ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAILY_LIMIT = 12
const DAILY_COUNT_KEY  = 'ragscope_daily_count'
const DAILY_DATE_KEY   = 'ragscope_daily_date'

/** Badge labels and background colours for each retrieval strategy. */
const STRATEGY_META: Record<string, { badge: string; badgeBg: string }> = {
  naive:       { badge: 'Baseline',           badgeBg: 'rgba(136,136,170,0.18)' },
  hyde:        { badge: 'Hypothesis-driven',  badgeBg: 'rgba(147,51,234,0.18)'  },
  multiquery:  { badge: 'Multi-perspective',  badgeBg: 'rgba(249,115,22,0.18)'  },
  hybrid:      { badge: 'Hybrid',             badgeBg: 'rgba(34,197,94,0.18)'   },
}

// ---------------------------------------------------------------------------
// Daily run counter helpers
// ---------------------------------------------------------------------------

function getTodayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function getDailyCount(): number {
  try {
    if (localStorage.getItem(DAILY_DATE_KEY) !== getTodayStr()) return 0
    return parseInt(localStorage.getItem(DAILY_COUNT_KEY) ?? '0', 10)
  } catch { return 0 }
}

function bumpDailyCount(by: number): void {
  try {
    localStorage.setItem(DAILY_DATE_KEY, getTodayStr())
    localStorage.setItem(DAILY_COUNT_KEY, String(getDailyCount() + by))
  } catch { /* non-fatal */ }
}

function buildDefaults(schema: ParamSchemaEntry[]): Record<string, unknown> {
  return Object.fromEntries(schema.map(e => [e.name, e.default]))
}

// ---------------------------------------------------------------------------
// Strategy card (checkbox)
// ---------------------------------------------------------------------------

function StrategyCard({
  retriever,
  selected,
  onToggle,
}: {
  retriever: RetrieverInfo
  selected: boolean
  onToggle: () => void
}) {
  const meta = STRATEGY_META[retriever.name] ?? {
    badge: 'Custom',
    badgeBg: 'rgba(136,136,170,0.18)',
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggle}
      className="relative text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-150"
      style={{
        background: selected ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)' : 'var(--color-surface)',
        border: selected
          ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.35)'
          : '1px solid var(--color-border)',
      }}
    >
      {/* Selection indicator (checkbox) in the top-right */}
      <span
        className="absolute top-3 right-3 w-4 h-4 rounded flex items-center justify-center"
        style={{
          background: selected
            ? 'var(--color-accent)'
            : 'transparent',
          border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        }}
        aria-hidden="true"
      >
        {selected && <Check size={11} style={{ color: 'var(--color-accent-text)' }} />}
      </span>

      {/* Name + badge */}
      <div className="flex items-start justify-between gap-2 pr-6">
        <span
          className="text-sm font-semibold leading-tight"
          style={{ color: selected ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
        >
          {retriever.display_name}
        </span>
        <span
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0"
          style={{
            background: meta.badgeBg,
            color: 'var(--color-text-secondary)',
          }}
        >
          {meta.badge}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        {retriever.description}
      </p>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Compression toggle section
// ---------------------------------------------------------------------------

function CompressionSection({
  enabled,
  onToggle,
  schema,
  params,
  onParamChange,
}: {
  enabled: boolean
  onToggle: () => void
  schema: ParamSchemaEntry[]
  params: Record<string, unknown>
  onParamChange: (name: string, value: unknown) => void
}) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ border: '1px solid var(--color-border)' }}
    >
      {/* Toggle header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 transition-colors"
        style={{
          background: enabled ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.04)' : 'var(--color-surface)',
        }}
        aria-pressed={enabled}
        aria-label={enabled ? 'Disable contextual compression' : 'Enable contextual compression'}
      >
        <div className="flex items-center gap-3">
          {/* Toggle pill */}
          <div
            className="relative w-9 h-5 rounded-full transition-colors duration-200"
            style={{ background: enabled ? 'var(--color-accent)' : 'var(--color-border)' }}
            aria-hidden="true"
          >
            <div
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200"
              style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </div>

          <div className="text-left">
            <p
              className="text-sm font-semibold"
              style={{ color: enabled ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
            >
              Contextual compression
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              Trim each retrieved chunk to only the relevant sentences
            </p>
          </div>
        </div>

        <Zap
          size={15}
          aria-hidden="true"
          style={{ color: enabled ? 'var(--color-accent)' : 'var(--color-text-secondary)', flexShrink: 0 }}
        />
      </button>

      {/* Explanation (always visible) */}
      <div
        className="px-5 py-3 text-xs leading-relaxed"
        style={{
          background: 'var(--color-bg)',
          borderTop: '1px solid var(--color-border)',
          color: 'var(--color-text-secondary)',
        }}
      >
        When enabled, each retrieved chunk is passed through an LLM that extracts
        only the sentences directly relevant to your question. This reduces noise in
        the context window and tends to improve faithfulness scores at the cost of
        one additional API call per chunk. The same setting is applied to every
        selected strategy. Enabling or disabling compression does not cost an
        additional daily run.
      </div>

      {/* Params -- shown only when enabled */}
      {enabled && schema.length > 0 && (
        <div
          className="px-5 py-5"
          style={{
            background: 'var(--color-surface)',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <ParamForm schema={schema} values={params} onChange={onParamChange} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main step component
// ---------------------------------------------------------------------------

export default function Step2Configure() {
  const { state, dispatch, setStep } = useAppContext()
  const { addToast } = useUI()

  // Question
  const [question, setQuestion] = useState(state.question || '')
  const questionRef = useRef<HTMLTextAreaElement>(null)

  // Multi-strategy selection. selectedStrategies preserves order so the
  // backend receives strategies in the same order the user clicked them,
  // and Step 3 can render rows in that order.
  const [retrievers, setRetrievers] = useState<RetrieverInfo[]>([])
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>(
    state.selectedStrategies || []
  )
  const [paramsByStrategy, setParamsByStrategy] = useState<Record<string, Record<string, unknown>>>(
    state.paramsByStrategy || {}
  )

  // Compression (orthogonal to retrieval strategy)
  const [compressionEnabled, setCompressionEnabled] = useState(state.compressionEnabled)
  const [compressionParams, setCompressionParams] = useState<Record<string, unknown>>(
    state.compressionParams || {}
  )
  const [compressionSchema, setCompressionSchema] = useState<ParamSchemaEntry[]>([])

  // Loading / error / running
  const [loadingStrategies, setLoadingStrategies] = useState(true)
  const [strategiesError, setStrategiesError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // Daily counter
  const [dailyCount, setDailyCount] = useState(0)
  const [isDevMode, setIsDevMode] = useState(false)
  const isGuest = !state.byokKey
  const runsRemaining = Math.max(0, DAILY_LIMIT - dailyCount)

  useEffect(() => {
    setDailyCount(getDailyCount())
    try {
      setIsDevMode(!!sessionStorage.getItem('ragscope_dev_token'))
    } catch { /* sessionStorage unavailable */ }
  }, [])

  // Fetch strategies on mount and seed any missing per-strategy param defaults
  // for already-selected strategies (e.g. when the user navigates back to Step 2).
  useEffect(() => {
    fetchStrategies()
      .then(data => {
        setRetrievers(data.retrievers)
        setCompressionSchema(data.compression.param_schema)
        if (Object.keys(compressionParams).length === 0) {
          setCompressionParams(buildDefaults(data.compression.param_schema))
        }
        // For each currently selected strategy whose params dict is empty,
        // populate with defaults from the registry.
        setParamsByStrategy(prev => {
          const next = { ...prev }
          for (const name of selectedStrategies) {
            if (!next[name] || Object.keys(next[name]).length === 0) {
              const r = data.retrievers.find(r => r.name === name)
              if (r) next[name] = buildDefaults(r.param_schema)
            }
          }
          return next
        })
      })
      .catch(err => setStrategiesError(String(err)))
      .finally(() => setLoadingStrategies(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Toggle a strategy in or out of the selection. New selections are appended
   * to preserve click order; removals filter them out. When adding, default
   * params for that strategy are seeded so the param form has values to bind to.
   */
  const handleStrategyToggle = useCallback(
    (name: string) => {
      setRunError(null)
      setSelectedStrategies(prev => {
        if (prev.includes(name)) {
          return prev.filter(n => n !== name)
        }
        return [...prev, name]
      })
      setParamsByStrategy(prev => {
        if (prev[name]) return prev
        const r = retrievers.find(r => r.name === name)
        if (!r) return prev
        return { ...prev, [name]: buildDefaults(r.param_schema) }
      })
    },
    [retrievers]
  )

  const setParamFor = useCallback(
    (strategy: string, name: string, value: unknown) => {
      setParamsByStrategy(prev => ({
        ...prev,
        [strategy]: { ...(prev[strategy] ?? {}), [name]: value },
      }))
    },
    []
  )

  const resetParamsFor = useCallback(
    (strategy: string) => {
      const r = retrievers.find(r => r.name === strategy)
      if (!r) return
      setParamsByStrategy(prev => ({
        ...prev,
        [strategy]: buildDefaults(r.param_schema),
      }))
    },
    [retrievers]
  )

  // canRun: a question, at least one strategy, not currently running, and
  // enough remaining quota for the selection (guest tier only; dev and BYOK
  // are unlimited from the UI's point of view).
  const n_selected = selectedStrategies.length
  const overQuota = isGuest && !isDevMode && n_selected > runsRemaining
  const canRun =
    question.trim().length > 0 &&
    n_selected > 0 &&
    !running &&
    !overQuota

  const handleRun = async () => {
    if (!state.corpusHash) return
    setRunning(true)
    setRunError(null)

    try {
      // Build the strategies list in the order the user selected. Each entry
      // carries its own retrieval_params and shares the single global
      // compression setting (per the architecture decision: compression is
      // orthogonal to retrieval strategy).
      const strategies = selectedStrategies.map(name => ({
        strategy: name,
        retrieval_params: paramsByStrategy[name] ?? {},
        compression_enabled: compressionEnabled,
        compression_params: compressionEnabled ? compressionParams : {},
      }))

      const result = await createBenchmark({
        corpus_hash: state.corpusHash,
        question: question.trim(),
        chunker_strategy: state.chunkerStrategy,
        chunker_params: state.chunkerParams,
        strategies,
      })

      // Persist the multi-strategy submission to context so Step 3 can find
      // it. retrievalStrategy / retrievalParams are also set to the first
      // selected strategy so Step 4 (single-strategy chat) has a sensible
      // default after the benchmark completes.
      const firstStrategy = selectedStrategies[0]
      dispatch({ type: 'SET_QUESTION',             payload: question.trim()         })
      dispatch({ type: 'SET_SELECTED_STRATEGIES',  payload: selectedStrategies      })
      dispatch({ type: 'SET_PARAMS_BY_STRATEGY',   payload: paramsByStrategy        })
      dispatch({ type: 'SET_RETRIEVAL_STRATEGY',   payload: firstStrategy           })
      dispatch({ type: 'SET_RETRIEVAL_PARAMS',     payload: paramsByStrategy[firstStrategy] ?? {} })
      dispatch({ type: 'SET_COMPRESSION_ENABLED',  payload: compressionEnabled      })
      dispatch({ type: 'SET_COMPRESSION_PARAMS',   payload: compressionParams       })
      dispatch({ type: 'SET_RUN_IDS',              payload: result.run_ids          })

      // Decrement the local guest counter by the number of strategies. The
      // backend has already incremented its own counter by the same amount;
      // the local display value is best-effort and may desync (documented).
      if (isGuest && !isDevMode) {
        bumpDailyCount(n_selected)
        setDailyCount(getDailyCount())
      }

      addToast(
        'info',
        n_selected === 1
          ? 'Benchmark started. Results will appear shortly.'
          : `${n_selected} benchmarks started. Results stream in as each strategy finishes.`,
      )
      setStep(3)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start benchmark.'
      setRunError(msg)
      // Surface 429 rate limit hits prominently
      if (msg.includes('429') || msg.toLowerCase().includes('limit')) {
        addToast('warning', 'Daily limit reached. Add an API key for unlimited runs.')
      } else {
        addToast('error', msg)
      }
    } finally {
      setRunning(false)
    }
  }

  // Retrievers, indexed by name, restricted to those currently selected so
  // we can render their param forms in selection order.
  const selectedRetrievers = selectedStrategies
    .map(name => retrievers.find(r => r.name === name))
    .filter((r): r is RetrieverInfo => r !== undefined)

  return (
    <div className="max-w-3xl lg:max-w-5xl mx-auto flex flex-col gap-10 py-6">

      {/* Back link */}
      <button
        type="button"
        onClick={() => setStep(1)}
        className="flex items-center gap-1.5 text-xs self-start transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        aria-label="Go back to upload step"
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Back to upload
      </button>

      {/* Corpus indicator */}
      {state.corpusHash && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-xs"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          <span style={{ color: 'var(--color-text-secondary)' }}>Corpus:</span>
          <code className="font-mono" style={{ color: 'var(--color-accent)' }}>
            {state.corpusHash.slice(0, 16)}...
          </code>
          <span style={{ color: 'var(--color-text-secondary)' }}>
            ({state.chunkCount?.toLocaleString()} chunks)
          </span>
        </div>
      )}

      {/* Section: Question */}
      <section aria-labelledby="question-heading">
        <h2
          id="question-heading"
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-text-primary)' }}
        >
          What do you want to ask?
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
          Ask something your corpus should be able to answer. The same question
          is used across all strategies so results are directly comparable.
        </p>

        <textarea
          ref={questionRef}
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask something your corpus should be able to answer"
          rows={3}
          className="w-full rounded-xl px-4 py-3 text-sm resize-none transition-colors"
          style={{
            background: 'var(--color-surface)',
            border: `1px solid ${question.trim() ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)' : 'var(--color-border)'}`,
            color: 'var(--color-text-primary)',
            outline: 'none',
          }}
          aria-label="Benchmark question"
          aria-required="true"
        />
      </section>

      {/* Section: Retrieval strategies */}
      <section aria-labelledby="strategy-heading">
        <h2
          id="strategy-heading"
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Choose one or more retrieval strategies
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--color-text-secondary)' }}>
          Select one or more strategies to compare. Each strategy counts as one
          daily run.
        </p>

        {loadingStrategies && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3" aria-busy="true" aria-label="Loading strategies">
            {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-32 rounded-xl" />)}
          </div>
        )}

        {strategiesError && (
          <div
            className="flex items-center gap-2 p-4 rounded-xl text-sm"
            style={{ background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#FF6B6B' }}
            role="alert"
          >
            <AlertCircle size={16} aria-hidden="true" />
            {strategiesError}
          </div>
        )}

        {!loadingStrategies && !strategiesError && (
          <>
            <div
              className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"
              role="group"
              aria-label="Retrieval strategies (multi-select)"
            >
              {retrievers.map(r => (
                <StrategyCard
                  key={r.name}
                  retriever={r}
                  selected={selectedStrategies.includes(r.name)}
                  onToggle={() => handleStrategyToggle(r.name)}
                />
              ))}
            </div>

            {/* Quota / selection hint below the grid */}
            <p
              className="text-xs mt-4"
              style={{
                color: overQuota ? '#FF6B6B' : 'var(--color-text-secondary)',
              }}
              aria-live="polite"
            >
              {isDevMode ? (
                'Dev mode - unlimited'
              ) : n_selected === 0 ? (
                'Select at least one strategy to run a benchmark.'
              ) : isGuest ? (
                overQuota
                  ? `Selected ${n_selected} but only ${runsRemaining} of ${DAILY_LIMIT} daily runs remain.`
                  : `This will use ${n_selected} of your ${runsRemaining} remaining runs.`
              ) : (
                `${n_selected} strategy${n_selected === 1 ? '' : ' strategies'} selected.`
              )}
            </p>
          </>
        )}
      </section>

      {/* Section: per-strategy retrieval params */}
      {selectedRetrievers.length > 0 && (
        <section aria-labelledby="retrieval-params-heading">
          <h2
            id="retrieval-params-heading"
            className="text-base font-semibold mb-4"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Strategy parameters
          </h2>

          <div className="flex flex-col gap-4">
            {selectedRetrievers.map(r => (
              <div
                key={r.name}
                className="rounded-xl"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <span className="text-sm font-semibold" style={{ color: 'var(--color-accent)' }}>
                    {r.display_name}
                  </span>
                  <button
                    type="button"
                    onClick={() => resetParamsFor(r.name)}
                    className="btn-ghost text-xs"
                    aria-label={`Reset ${r.display_name} parameters to defaults`}
                  >
                    Reset defaults
                  </button>
                </div>
                <div className="px-5 py-4">
                  {r.param_schema.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      This strategy has no configurable parameters.
                    </p>
                  ) : (
                    <ParamForm
                      schema={r.param_schema}
                      values={paramsByStrategy[r.name] ?? {}}
                      onChange={(name, val) => setParamFor(r.name, name, val)}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section: Compression (orthogonal toggle) */}
      <section aria-labelledby="compression-heading">
        <h2
          id="compression-heading"
          className="text-base font-semibold mb-4"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Post-retrieval processing
        </h2>
        <CompressionSection
          enabled={compressionEnabled}
          onToggle={() => setCompressionEnabled(p => !p)}
          schema={compressionSchema}
          params={compressionParams}
          onParamChange={(name, val) =>
            setCompressionParams(prev => ({ ...prev, [name]: val }))
          }
        />
      </section>

      {/* Error */}
      {runError && (
        <div
          className="flex items-start gap-2 p-4 rounded-xl text-sm"
          style={{ background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#FF6B6B' }}
          role="alert"
        >
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{runError}</span>
        </div>
      )}

      {/* Run button + guest counter */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        {isDevMode ? (
          <p className="text-xs order-2 sm:order-1 font-medium" style={{ color: '#14b8a6' }}>
            Dev mode - unlimited
          </p>
        ) : isGuest ? (
          <p
            className="text-xs order-2 sm:order-1"
            style={{
              color: runsRemaining === 0 ? '#FF6B6B' : 'var(--color-text-secondary)',
            }}
            aria-live="polite"
          >
            {runsRemaining === 0
              ? 'Daily limit reached. Add an API key for unlimited runs.'
              : `${runsRemaining} of ${DAILY_LIMIT} runs remaining`}
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleRun}
          disabled={!canRun}
          className="btn-accent order-1 sm:order-2 w-full sm:w-auto"
          aria-label={
            running
              ? 'Starting benchmark run'
              : !question.trim()
              ? 'Enter a question to continue'
              : n_selected === 0
              ? 'Select at least one strategy to continue'
              : overQuota
              ? 'Selected more strategies than remaining daily runs'
              : 'Run the benchmark'
          }
        >
          {running ? 'Starting...' : 'Run benchmark'}
        </button>
      </div>

    </div>
  )
}
