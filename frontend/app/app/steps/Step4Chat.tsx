'use client'

/**
 * Step 4 -- Chat with your corpus.
 *
 * Each user message triggers POST /benchmark with the current question and
 * strategy settings, then polls GET /results/{runId} until the answer is
 * ready. This reuses the full RAG evaluation pipeline -- every response
 * carries a faithfulness-evaluated answer alongside the retrieval metadata.
 *
 * The winning strategy from Step 3 is pre-selected. A collapsible config
 * panel lets the user switch strategy or tune parameters without leaving chat.
 * Guest users receive a soft limit of 3 questions per benchmark session.
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
import { fetchStrategies, createBenchmark, getRunStatus } from '@/lib/api'
import type { RetrieverInfo, ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUEST_QUESTION_LIMIT = 3
const POLL_MS = 2000

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

function chatCountKey(sessionId: string): string {
  return `ragscope_chat_q_${sessionId}`
}

function getChatCount(sessionId: string): number {
  try { return parseInt(localStorage.getItem(chatCountKey(sessionId)) ?? '0', 10) } catch { return 0 }
}

function incChatCount(sessionId: string): void {
  try { localStorage.setItem(chatCountKey(sessionId), String(getChatCount(sessionId) + 1)) } catch {}
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

  const isGuest   = !state.byokKey
  const sessionId = state.runId ?? 'default'

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

  // Guest question tracking
  const [questionsUsed, setQuestionsUsed] = useState(getChatCount(sessionId))
  const questionsLeft = Math.max(0, GUEST_QUESTION_LIMIT - questionsUsed)
  const limitReached  = isGuest && questionsLeft === 0

  // Scroll-to-bottom ref
  const bottomRef = useRef<HTMLDivElement>(null)

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

    // Append user message + thinking placeholder
    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: text, timestamp: Date.now() },
      { id: thinkMsgId, role: 'thinking', content: '', timestamp: Date.now() },
    ])

    if (isGuest) {
      incChatCount(sessionId)
      setQuestionsUsed(getChatCount(sessionId))
    }

    try {
      // Create a benchmark run for this chat turn
      const { run_id } = await createBenchmark({
        corpus_hash:         state.corpusHash,
        question:            text,
        retrieval_strategy:  strategy,
        retrieval_params:    params,
        chunker_strategy:    state.chunkerStrategy,
        chunker_params:      state.chunkerParams,
        compression_enabled: state.compressionEnabled,
        compression_params:  state.compressionParams,
      })

      // Poll until done, then replace the thinking placeholder
      const poll = (): Promise<void> =>
        new Promise(resolve => {
          const id = setInterval(async () => {
            try {
              const res = await getRunStatus(run_id)
              if (res.status === 'completed' || res.status === 'failed') {
                clearInterval(id)
                const answer = res.status === 'completed'
                  ? (res.generated_answer ?? 'No answer generated.')
                  : (res.error_message ?? 'The run failed.')

                setMessages(prev =>
                  prev.map(m =>
                    m.id === thinkMsgId
                      ? {
                          id: `asst-${run_id}`,
                          role: 'assistant' as const,
                          content: answer,
                          strategy: res.retrieval_strategy,
                          chunkCount: res.retrieved_chunks?.length ?? 0,
                          timestamp: Date.now(),
                        }
                      : m
                  )
                )
                resolve()
              }
            } catch {
              // Network hiccup -- keep polling
            }
          }, POLL_MS)
        })

      await poll()
    } catch (err) {
      // Replace thinking with error message
      const errText = err instanceof Error ? err.message : 'Failed to generate a response.'
      setMessages(prev =>
        prev.map(m =>
          m.id === thinkMsgId
            ? { id: `err-${Date.now()}`, role: 'assistant' as const, content: errText, timestamp: Date.now() }
            : m
        )
      )
    } finally {
      setSending(false)
    }
  }, [
    inputValue, sending, limitReached, state.corpusHash,
    strategy, params, state.chunkerStrategy, state.chunkerParams,
    state.compressionEnabled, state.compressionParams,
    isGuest, sessionId,
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
      {/* Guest question counter                                            */}
      {/* ---------------------------------------------------------------- */}
      {isGuest && !limitReached && (
        <p
          className="text-[11px] text-center py-1"
          style={{ color: 'var(--color-text-secondary)' }}
          aria-live="polite"
        >
          {questionsLeft === 1
            ? '1 question remaining for this run'
            : `${questionsLeft} questions remaining for this run`}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Limit reached banner                                              */}
      {/* ---------------------------------------------------------------- */}
      {limitReached && (
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
              3 questions used for this run
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
