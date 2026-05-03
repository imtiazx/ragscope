'use client'

/**
 * Step 2 -- Configure and launch a benchmark run.
 *
 * Collects the question, retrieval strategy + params, and optional contextual
 * compression settings, then POSTs to /benchmark. On success the run_id is
 * stored in AppContext and the app advances to Step 3 where results are polled.
 *
 * Guest users see a live counter showing how many of their three daily runs
 * they have already used. The counter is tracked in localStorage and resets
 * at midnight local time.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronLeft, Zap } from 'lucide-react'
import { useAppContext } from '@/context/AppContext'
import { useUI } from '@/context/UIContext'
import ParamForm from '@/components/ParamForm'
import { fetchStrategies, createBenchmark } from '@/lib/api'
import type { RetrieverInfo, ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAILY_LIMIT = 3
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

function incrementDailyCount(): void {
  try {
    localStorage.setItem(DAILY_DATE_KEY, getTodayStr())
    localStorage.setItem(DAILY_COUNT_KEY, String(getDailyCount() + 1))
  } catch { /* non-fatal */ }
}

function buildDefaults(schema: ParamSchemaEntry[]): Record<string, unknown> {
  return Object.fromEntries(schema.map(e => [e.name, e.default]))
}

// ---------------------------------------------------------------------------
// Strategy card
// ---------------------------------------------------------------------------

function StrategyCard({
  retriever,
  selected,
  onSelect,
}: {
  retriever: RetrieverInfo
  selected: boolean
  onSelect: () => void
}) {
  const meta = STRATEGY_META[retriever.name] ?? {
    badge: 'Custom',
    badgeBg: 'rgba(136,136,170,0.18)',
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="text-left rounded-xl p-4 flex flex-col gap-3 transition-all duration-150"
      style={{
        background: selected ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)' : 'var(--color-surface)',
        border: selected
          ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.35)'
          : '1px solid var(--color-border)',
      }}
    >
      {/* Name + badge */}
      <div className="flex items-start justify-between gap-2">
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
        one additional API call per chunk.
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

  // Retrieval strategy
  const [retrievers, setRetrievers] = useState<RetrieverInfo[]>([])
  const [selectedStrategy, setSelectedStrategy] = useState(state.retrievalStrategy || '')
  const [retrievalParams, setRetrievalParams] = useState<Record<string, unknown>>(
    state.retrievalParams || {}
  )

  // Compression
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
  const isGuest = !state.byokKey
  const runsRemaining = Math.max(0, DAILY_LIMIT - dailyCount)

  useEffect(() => {
    setDailyCount(getDailyCount())
  }, [])

  // Fetch strategies on mount
  useEffect(() => {
    fetchStrategies()
      .then(data => {
        setRetrievers(data.retrievers)
        setCompressionSchema(data.compression.param_schema)
        if (compressionParams && Object.keys(compressionParams).length === 0) {
          setCompressionParams(buildDefaults(data.compression.param_schema))
        }
        // Restore previously selected strategy params
        if (state.retrievalStrategy && Object.keys(retrievalParams).length === 0) {
          const prev = data.retrievers.find(r => r.name === state.retrievalStrategy)
          if (prev) setRetrievalParams(buildDefaults(prev.param_schema))
        }
      })
      .catch(err => setStrategiesError(String(err)))
      .finally(() => setLoadingStrategies(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStrategySelect = useCallback(
    (name: string) => {
      setSelectedStrategy(name)
      const r = retrievers.find(r => r.name === name)
      if (r) setRetrievalParams(buildDefaults(r.param_schema))
      setRunError(null)
    },
    [retrievers]
  )

  const selectedRetriever = retrievers.find(r => r.name === selectedStrategy)

  const canRun =
    question.trim().length > 0 &&
    selectedStrategy !== '' &&
    !running &&
    (isGuest ? runsRemaining > 0 : true)

  const handleRun = async () => {
    if (!state.corpusHash) return
    setRunning(true)
    setRunError(null)

    try {
      const result = await createBenchmark({
        corpus_hash: state.corpusHash,
        question: question.trim(),
        retrieval_strategy: selectedStrategy,
        retrieval_params: retrievalParams,
        chunker_strategy: state.chunkerStrategy,
        chunker_params: state.chunkerParams,
        compression_enabled: compressionEnabled,
        compression_params: compressionEnabled ? compressionParams : {},
      })

      // Persist to context
      dispatch({ type: 'SET_QUESTION',            payload: question.trim()    })
      dispatch({ type: 'SET_RETRIEVAL_STRATEGY',  payload: selectedStrategy   })
      dispatch({ type: 'SET_RETRIEVAL_PARAMS',    payload: retrievalParams    })
      dispatch({ type: 'SET_COMPRESSION_ENABLED', payload: compressionEnabled })
      dispatch({ type: 'SET_COMPRESSION_PARAMS',  payload: compressionParams  })
      dispatch({ type: 'SET_RUN_ID',              payload: result.run_id      })

      if (isGuest) {
        incrementDailyCount()
        setDailyCount(getDailyCount())
      }

      addToast('info', 'Benchmark started. Results will be ready in about 20 seconds.')
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

      {/* Section: Retrieval strategy */}
      <section aria-labelledby="strategy-heading">
        <h2
          id="strategy-heading"
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Choose a retrieval strategy
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--color-text-secondary)' }}>
          Select one strategy to benchmark. Run again with a different strategy
          to add it to the comparison chart.
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
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3" role="radiogroup" aria-label="Retrieval strategies">
            {retrievers.map(r => (
              <StrategyCard
                key={r.name}
                retriever={r}
                selected={r.name === selectedStrategy}
                onSelect={() => handleStrategySelect(r.name)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section: Retrieval params */}
      {selectedRetriever && selectedRetriever.param_schema.length > 0 && (
        <section aria-labelledby="retrieval-params-heading">
          <div className="flex items-center justify-between mb-4">
            <h2
              id="retrieval-params-heading"
              className="text-base font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {selectedRetriever.display_name} parameters
            </h2>
            <button
              type="button"
              onClick={() => setRetrievalParams(buildDefaults(selectedRetriever.param_schema))}
              className="btn-ghost text-xs"
              aria-label="Reset retrieval parameters to defaults"
            >
              Reset defaults
            </button>
          </div>
          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          >
            <ParamForm
              schema={selectedRetriever.param_schema}
              values={retrievalParams}
              onChange={(name, val) => setRetrievalParams(prev => ({ ...prev, [name]: val }))}
            />
          </div>
        </section>
      )}

      {/* Section: Compression */}
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
        {/* Guest run counter */}
        {isGuest && (
          <p
            className="text-xs order-2 sm:order-1"
            style={{
              color: runsRemaining === 0 ? '#FF6B6B' : 'var(--color-text-secondary)',
            }}
            aria-live="polite"
          >
            {runsRemaining === 0
              ? 'Daily limit reached. Add an API key for unlimited runs.'
              : `${runsRemaining} of ${DAILY_LIMIT} runs remaining today`}
          </p>
        )}

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
              : !selectedStrategy
              ? 'Select a retrieval strategy to continue'
              : 'Run the benchmark'
          }
        >
          {running ? 'Starting...' : 'Run benchmark'}
        </button>
      </div>

    </div>
  )
}
