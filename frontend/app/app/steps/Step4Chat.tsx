'use client'

/**
 * Step 4 -- Chat with your corpus.
 *
 * Each user message triggers POST /chat with the current question and
 * strategy settings, and the backend returns a generated answer in a single
 * synchronous response. No benchmark_runs row is created and no RAGAS
 * evaluation runs - the chat endpoint is the lightweight conversational
 * surface, distinct from /benchmark which is for measurement.
 *
 * The winning strategy from Step 3 is pre-selected. A collapsible config
 * panel lets the user switch strategy or tune parameters without leaving chat.
 * Guest users get a Tier 1 daily limit of 5 chat questions enforced by the
 * backend (chat_count in rate_limit_counters). The frontend keeps an in-memory
 * counter purely for display - it initialises to 0 on mount and decrements on
 * each successful response. The backend is authoritative on enforcement; if
 * it returns HTTP 429, the input is disabled and the upgrade prompt is shown
 * regardless of what the local counter says. Tier 0 dev mode bypasses the
 * limit entirely and displays "Dev mode - unlimited".
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  SendHorizonal,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Settings2,
  Key,
} from 'lucide-react'
import { useAppContext, type RunResult } from '@/context/AppContext'
import { useUI } from '@/context/UIContext'
import ParamForm from '@/components/ParamForm'
import { fetchStrategies, chatRequest, ApiError } from '@/lib/api'
import type { RetrieverInfo, ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUEST_QUESTION_LIMIT = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thinking'
  content: string
  strategy?: string
  chunkCount?: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weightedAverage(r: RunResult): number {
  const vals = [r.faithfulness, r.contextUtilization, r.answerRelevancy].filter(
    (v): v is number => v !== null
  )
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
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

function buildDefaults(schema: ParamSchemaEntry[]): Record<string, unknown> {
  return Object.fromEntries(schema.map(e => [e.name, e.default]))
}

// ---------------------------------------------------------------------------
// Thinking indicator (three animated dots)
// ---------------------------------------------------------------------------

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Generating response">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: 'var(--color-text-secondary)',
            animation: `thinking-dot 1.2s ${i * 0.2}s ease-in-out infinite`,
          }}
          aria-hidden="true"
        />
      ))}
      <style>{`
        @keyframes thinking-dot {
          0%, 80%, 100% { transform: scale(1); opacity: 0.4; }
          40%            { transform: scale(1.4); opacity: 1; }
        }
      `}</style>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Single chat message row
// ---------------------------------------------------------------------------

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <motion.div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      layout
    >
      <div
        className={`max-w-[78%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1.5`}
      >
        {/* Bubble */}
        <div
          className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
          style={{
            background: isUser
              ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.12)'
              : 'var(--color-surface)',
            border: isUser
              ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.25)'
              : '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            borderBottomRightRadius: isUser ? '4px' : '16px',
            borderBottomLeftRadius: isUser ? '16px' : '4px',
          }}
        >
          {message.role === 'thinking' ? <ThinkingDots /> : message.content}
        </div>

        {/* Assistant metadata */}
        {message.role === 'assistant' && (message.strategy || message.chunkCount) && (
          <p className="text-[11px] px-1" style={{ color: 'var(--color-text-secondary)' }}>
            {message.strategy && strategyLabel(message.strategy)}
            {message.chunkCount !== undefined && ` · ${message.chunkCount} chunks retrieved`}
          </p>
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Compact strategy pills for the config panel
// ---------------------------------------------------------------------------

function StrategyPills({
  retrievers,
  selected,
  onSelect,
}: {
  retrievers: RetrieverInfo[]
  selected: string
  onSelect: (name: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Select retrieval strategy">
      {retrievers.map(r => (
        <button
          key={r.name}
          type="button"
          role="radio"
          aria-checked={r.name === selected}
          onClick={() => onSelect(r.name)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150"
          style={{
            background: r.name === selected ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.1)' : 'transparent',
            border: `1px solid ${r.name === selected ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)' : 'var(--color-border)'}`,
            color:  r.name === selected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
          aria-label={`Use ${r.display_name} strategy`}
        >
          {r.display_name}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Step4Chat() {
  const { state, setStep } = useAppContext()
  const { openBYOKDrawer } = useUI()

  const isGuest = !state.byokKey
  const [isDevMode, setIsDevMode] = useState(false)

  // Derive winning strategy from run history
  const completed = state.runHistory.filter(r => r.status === 'completed')
  const winner    = completed.length
    ? completed.reduce((b, r) => weightedAverage(r) > weightedAverage(b) ? r : b, completed[0])
    : null
  const defaultStrategy = winner?.retrievalStrategy ?? state.retrievalStrategy ?? 'naive'

  // Strategies data
  const [retrievers, setRetrievers]   = useState<RetrieverInfo[]>([])
  const [loadingStrats, setLoadingStrats] = useState(true)

  // Config panel
  const [configOpen, setConfigOpen]   = useState(false)
  const [strategy, setStrategy]       = useState(defaultStrategy)
  const [params, setParams]           = useState<Record<string, unknown>>(
    state.retrievalParams ?? {}
  )

  // Messages and send state
  const [messages, setMessages]       = useState<ChatMessage[]>([])
  const [inputValue, setInputValue]   = useState('')
  const [sending, setSending]         = useState(false)

  // Guest question tracking. Component-local state (not localStorage): the
  // counter is display-only and the backend is authoritative on enforcement.
  // questionsUsed starts at 0 on mount, increments by 1 per successful /chat
  // response, and is forced to GUEST_QUESTION_LIMIT when the backend returns
  // HTTP 429 (so the limit-reached UI activates immediately even if the
  // local count says otherwise).
  const [questionsUsed, setQuestionsUsed] = useState(0)
  const [forcedLimitReached, setForcedLimitReached] = useState(false)
  const questionsLeft = Math.max(0, GUEST_QUESTION_LIMIT - questionsUsed)
  const limitReached  = isGuest && !isDevMode && (forcedLimitReached || questionsLeft === 0)

  // Scroll-to-bottom ref
  const bottomRef = useRef<HTMLDivElement>(null)

  // Detect dev mode on mount so counter fetch is skipped entirely in dev mode
  useEffect(() => {
    try {
      setIsDevMode(!!sessionStorage.getItem('ragscope_dev_token'))
    } catch { /* sessionStorage unavailable */ }
  }, [])

  // Fetch strategies once
  useEffect(() => {
    fetchStrategies()
      .then(data => {
        setRetrievers(data.retrievers)
        const current = data.retrievers.find(r => r.name === strategy)
        if (current && Object.keys(params).length === 0) {
          setParams(buildDefaults(current.param_schema))
        }
      })
      .finally(() => setLoadingStrats(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleStrategySelect = useCallback((name: string) => {
    setStrategy(name)
    const r = retrievers.find(x => x.name === name)
    if (r) setParams(buildDefaults(r.param_schema))
  }, [retrievers])

  // ---- Send a message
  const handleSend = useCallback(async () => {
    const text = inputValue.trim()
    if (!text || sending || limitReached || !state.corpusHash) return

    setSending(true)
    setInputValue('')

    const userMsgId = `user-${Date.now()}`
    const thinkMsgId = `think-${Date.now()}`

    // Append user message + thinking placeholder before the network call so
    // the UI shows immediate feedback while the backend works.
    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: text, timestamp: Date.now() },
      { id: thinkMsgId, role: 'thinking', content: '', timestamp: Date.now() },
    ])

    try {
      // Single synchronous request to /chat. No benchmark_runs row is created
      // and no polling is needed - the endpoint blocks until the answer is
      // ready and returns the answer plus retrieved chunks in one payload.
      const response = await chatRequest({
        corpus_hash:         state.corpusHash,
        question:            text,
        retrieval_strategy:  strategy,
        retrieval_params:    params,
        compression_enabled: state.compressionEnabled,
        compression_params:  state.compressionParams,
      })

      // Successful response: swap the thinking placeholder for the answer
      // and bump the local usage counter (display only - backend already
      // recorded chat_count + 1 atomically before retrieval ran).
      setMessages(prev =>
        prev.map(m =>
          m.id === thinkMsgId
            ? {
                id: `asst-${Date.now()}`,
                role: 'assistant' as const,
                content: response.answer,
                strategy: response.strategy_used,
                chunkCount: response.retrieved_chunks.length,
                timestamp: Date.now(),
              }
            : m
        )
      )
      if (isGuest && !isDevMode) {
        setQuestionsUsed(c => c + 1)
      }
    } catch (err) {
      // HTTP 429 means the backend has rejected the question because the
      // daily chat_count is already at DAILY_CHAT_LIMIT. Force the
      // limit-reached UI on regardless of what the local counter says,
      // since the backend is authoritative.
      if (err instanceof ApiError && err.status === 429) {
        setForcedLimitReached(true)
        setQuestionsUsed(GUEST_QUESTION_LIMIT)
        setMessages(prev =>
          prev.map(m =>
            m.id === thinkMsgId
              ? {
                  id: `err-${Date.now()}`,
                  role: 'assistant' as const,
                  content:
                    'Daily chat limit reached. Add an API key in Settings ' +
                    'to continue chatting without limits.',
                  timestamp: Date.now(),
                }
              : m
          )
        )
      } else {
        const errText = err instanceof Error ? err.message : 'Failed to generate a response.'
        setMessages(prev =>
          prev.map(m =>
            m.id === thinkMsgId
              ? { id: `err-${Date.now()}`, role: 'assistant' as const, content: errText, timestamp: Date.now() }
              : m
          )
        )
      }
    } finally {
      setSending(false)
    }
  }, [
    inputValue, sending, limitReached, state.corpusHash,
    strategy, params,
    state.compressionEnabled, state.compressionParams,
    isGuest, isDevMode,
  ])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const currentRetriever = retrievers.find(r => r.name === strategy)

  return (
    <div className="max-w-4xl lg:max-w-5xl mx-auto flex flex-col h-[calc(100vh-160px)] gap-0">

      {/* ---------------------------------------------------------------- */}
      {/* Strategy banner                                                   */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="flex items-center justify-between px-4 py-3 rounded-xl mb-3"
        style={{
          background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.04)',
          border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            Chatting with corpus using
          </span>
          <span className="text-xs font-bold" style={{ color: 'var(--color-accent)' }}>
            {strategyLabel(strategy)}
          </span>
          {winner && winner.retrievalStrategy === strategy && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
              style={{ background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.1)', color: 'var(--color-accent)' }}
            >
              top scorer
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStep(3)}
            className="text-xs flex items-center gap-1.5 transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
            aria-label="Back to results"
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span className="hidden sm:inline">Results</span>
          </button>

          <button
            type="button"
            onClick={() => setConfigOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: configOpen ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)' : 'transparent',
              border: '1px solid var(--color-border)',
              color: configOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)',
            }}
            aria-expanded={configOpen}
            aria-controls="config-panel"
          >
            <Settings2 size={13} aria-hidden="true" />
            Configure
            {configOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Collapsible config panel                                          */}
      {/* ---------------------------------------------------------------- */}
      <AnimatePresence>
        {configOpen && (
          <motion.div
            id="config-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden mb-3"
          >
            <div
              className="rounded-xl p-4 flex flex-col gap-4"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div>
                <p className="text-xs font-semibold mb-2.5" style={{ color: 'var(--color-text-secondary)' }}>
                  Retrieval strategy
                </p>
                {loadingStrats ? (
                  <div className="flex gap-2">
                    {[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-7 w-24 rounded-lg" />)}
                  </div>
                ) : (
                  <StrategyPills
                    retrievers={retrievers}
                    selected={strategy}
                    onSelect={handleStrategySelect}
                  />
                )}
              </div>

              {currentRetriever && currentRetriever.param_schema.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-3" style={{ color: 'var(--color-text-secondary)' }}>
                    Parameters
                  </p>
                  <ParamForm
                    schema={currentRetriever.param_schema}
                    values={params}
                    onChange={(name, val) => setParams(prev => ({ ...prev, [name]: val }))}
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------------------------------------------------------- */}
      {/* Message thread                                                    */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="flex-1 overflow-y-auto flex flex-col gap-4 px-1 py-2"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
              Ask your corpus anything
            </p>
            <p className="text-xs max-w-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Every response is generated by retrieving relevant chunks and then
              answering from them. Strategy and chunk count appear below each reply.
            </p>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {messages.map(msg => (
            <MessageRow key={msg.id} message={msg} />
          ))}
        </AnimatePresence>

        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Question counter: dev mode shows "unlimited", guest shows count  */}
      {/* ---------------------------------------------------------------- */}
      {isDevMode ? (
        <p className="text-[11px] text-center py-1 font-medium" style={{ color: '#14b8a6' }}>
          Dev mode - unlimited
        </p>
      ) : isGuest && !limitReached ? (
        <p
          className="text-[11px] text-center py-1"
          style={{ color: 'var(--color-text-secondary)' }}
          aria-live="polite"
        >
          {`${questionsLeft} of ${GUEST_QUESTION_LIMIT} chat questions remaining today`}
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Limit reached banner (hidden in dev mode)                         */}
      {/* ---------------------------------------------------------------- */}
      {!isDevMode && limitReached && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl mb-2"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
          }}
          role="status"
        >
          <Key size={16} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
              Daily chat limit reached ({GUEST_QUESTION_LIMIT} questions per day)
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              Add your own OpenAI or Anthropic key for unlimited chat. Your key
              stays in the browser and is never sent to our servers.
            </p>
          </div>
          <button
            type="button"
            onClick={openBYOKDrawer}
            className="text-xs font-semibold flex-shrink-0 transition-colors"
            style={{ color: 'var(--color-accent)' }}
            aria-label="Open BYOK settings to unlock unlimited chat"
          >
            Add key
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Input                                                             */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="flex gap-3 items-end pt-2 pb-1"
        style={{ borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}
      >
        <textarea
          value={inputValue}
          onChange={e => {
            setInputValue(e.target.value)
            // Auto-expand up to 5 lines
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            limitReached
              ? 'Add an API key to continue chatting...'
              : 'Ask a question about your corpus...'
          }
          disabled={sending || limitReached}
          rows={1}
          className="flex-1 rounded-xl px-4 py-2.5 text-sm resize-none transition-colors"
          style={{
            background: 'var(--color-surface)',
            border: `1px solid ${inputValue.trim() ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)' : 'var(--color-border)'}`,
            color: 'var(--color-text-primary)',
            outline: 'none',
            opacity: limitReached ? 0.45 : 1,
            minHeight: '44px',
          }}
          aria-label="Chat input"
          aria-disabled={limitReached}
        />

        <button
          type="button"
          onClick={handleSend}
          disabled={!inputValue.trim() || sending || limitReached}
          className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150"
          style={{
            background: inputValue.trim() && !sending && !limitReached
              ? 'var(--color-accent)'
              : 'var(--color-surface)',
            border: '1px solid var(--color-border)',
          }}
          aria-label="Send message"
        >
          <SendHorizonal
            size={16}
            aria-hidden="true"
            style={{
              color: inputValue.trim() && !sending && !limitReached
                ? '#000'
                : 'var(--color-text-secondary)',
            }}
          />
        </button>
      </div>

    </div>
  )
}
