'use client'

/**
 * AppContext -- single source of truth for all benchmark session state.
 *
 * Every piece of state the user builds up across the four steps (corpus hash,
 * chunker config, question, retrieval strategy, run results) lives here rather
 * than in the individual step components. This eliminates prop drilling: the
 * alternative would be passing corpus_hash from Step1 -> page -> Step2 -> Step3
 * as function arguments through every layer. With context, any component
 * anywhere in the tree can call useAppContext() and read or update state
 * directly without its parent knowing or caring.
 *
 * A useReducer pattern is used instead of multiple useState calls so that
 * related updates are atomic and the full state shape is always visible in one
 * place.
 */

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepNumber = 1 | 2 | 3 | 4

/** A completed benchmark run stored in session history. */
export interface RunResult {
  runId: string
  retrievalStrategy: string
  question: string
  faithfulness: number | null
  contextUtilization: number | null
  answerRelevancy: number | null
  latencyMs: number | null
  generatedAnswer: string | null
  retrievedChunks: RetrievedChunk[]
  timestamp: number
  status: 'completed' | 'failed'
  errorMessage?: string
}

export interface RetrievedChunk {
  chunk_id: string
  content: string
  score: number
  metadata?: Record<string, unknown>
}

export interface AppState {
  currentStep: StepNumber

  // Step 1 -- corpus upload
  uploadedFiles: { name: string; size: number }[]
  corpusHash: string | null
  chunkCount: number | null
  chunkerStrategy: string
  chunkerParams: Record<string, unknown>

  // Step 2 -- benchmark configuration
  question: string

  // Multi-strategy selection. selectedStrategies is the list of strategy names
  // the user has selected; paramsByStrategy maps strategy name to that
  // strategy's specific retrieval_params. Compression is orthogonal: a single
  // compressionEnabled/compressionParams pair applies to every selected
  // strategy when the request is submitted.
  selectedStrategies: string[]
  paramsByStrategy: Record<string, Record<string, unknown>>
  compressionEnabled: boolean
  compressionParams: Record<string, unknown>

  // Legacy single-value mirrors of the multi-strategy state, kept populated
  // (set to the first selected strategy and its params at submit time) so
  // Step4Chat - which has no concept of multi-strategy - can still find a
  // sensible default to chat with after the benchmark completes.
  retrievalStrategy: string
  retrievalParams: Record<string, unknown>

  // Step 3 -- results. runIds is parallel to selectedStrategies: runIds[i]
  // is the background-task ID created by the backend for selectedStrategies[i].
  // Step3Results polls every entry of runIds in parallel.
  runIds: string[]
  runHistory: RunResult[]

  // Global
  byokKey: string | null
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type AppAction =
  | { type: 'SET_STEP'; payload: StepNumber }
  | { type: 'SET_UPLOADED_FILES'; payload: { name: string; size: number }[] }
  | { type: 'SET_CORPUS'; payload: { hash: string; count: number } }
  | { type: 'SET_CHUNKER_STRATEGY'; payload: string }
  | { type: 'SET_CHUNKER_PARAMS'; payload: Record<string, unknown> }
  | { type: 'SET_QUESTION'; payload: string }
  | { type: 'SET_RETRIEVAL_STRATEGY'; payload: string }
  | { type: 'SET_RETRIEVAL_PARAMS'; payload: Record<string, unknown> }
  | { type: 'SET_SELECTED_STRATEGIES'; payload: string[] }
  | { type: 'SET_PARAMS_BY_STRATEGY'; payload: Record<string, Record<string, unknown>> }
  | { type: 'SET_COMPRESSION_ENABLED'; payload: boolean }
  | { type: 'SET_COMPRESSION_PARAMS'; payload: Record<string, unknown> }
  | { type: 'SET_RUN_IDS'; payload: string[] }
  | { type: 'ADD_RUN_RESULT'; payload: RunResult }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'SET_BYOK_KEY'; payload: string | null }
  | { type: 'HYDRATE_HISTORY'; payload: RunResult[] }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const HISTORY_STORAGE_KEY = 'ragscope_run_history'

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.payload }
    case 'SET_UPLOADED_FILES':
      return { ...state, uploadedFiles: action.payload }
    case 'SET_CORPUS':
      return {
        ...state,
        corpusHash: action.payload.hash,
        chunkCount: action.payload.count,
      }
    case 'SET_CHUNKER_STRATEGY':
      return { ...state, chunkerStrategy: action.payload }
    case 'SET_CHUNKER_PARAMS':
      return { ...state, chunkerParams: action.payload }
    case 'SET_QUESTION':
      return { ...state, question: action.payload }
    case 'SET_RETRIEVAL_STRATEGY':
      return { ...state, retrievalStrategy: action.payload }
    case 'SET_RETRIEVAL_PARAMS':
      return { ...state, retrievalParams: action.payload }
    case 'SET_SELECTED_STRATEGIES':
      return { ...state, selectedStrategies: action.payload }
    case 'SET_PARAMS_BY_STRATEGY':
      return { ...state, paramsByStrategy: action.payload }
    case 'SET_COMPRESSION_ENABLED':
      return { ...state, compressionEnabled: action.payload }
    case 'SET_COMPRESSION_PARAMS':
      return { ...state, compressionParams: action.payload }
    case 'SET_RUN_IDS':
      return { ...state, runIds: action.payload }
    case 'ADD_RUN_RESULT': {
      const updated = [action.payload, ...state.runHistory].slice(0, 20)
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // Quota exceeded or private mode -- non-fatal
      }
      return { ...state, runHistory: updated }
    }
    case 'CLEAR_HISTORY':
      try {
        localStorage.removeItem(HISTORY_STORAGE_KEY)
      } catch {
        // Non-fatal
      }
      return { ...state, runHistory: [] }
    case 'SET_BYOK_KEY':
      return { ...state, byokKey: action.payload }
    case 'HYDRATE_HISTORY':
      return { ...state, runHistory: action.payload }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState: AppState = {
  currentStep: 1,
  uploadedFiles: [],
  corpusHash: null,
  chunkCount: null,
  chunkerStrategy: 'fixed_size',
  chunkerParams: {},
  question: '',
  selectedStrategies: [],
  paramsByStrategy: {},
  compressionEnabled: false,
  compressionParams: {},
  retrievalStrategy: '',
  retrievalParams: {},
  runIds: [],
  runHistory: [],
  byokKey: null,
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface AppContextValue {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  // Convenience helpers so callers do not repeat dispatch boilerplate
  setStep: (step: StepNumber) => void
  setCorpus: (hash: string, count: number) => void
  addRunResult: (result: RunResult) => void
  clearHistory: () => void
}

const AppContext = createContext<AppContextValue>({
  state: initialState,
  dispatch: () => {},
  setStep: () => {},
  setCorpus: () => {},
  addRunResult: () => {},
  clearHistory: () => {},
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppContextProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Hydrate run history from localStorage on first mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
      if (raw) {
        const parsed: RunResult[] = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) {
          dispatch({ type: 'HYDRATE_HISTORY', payload: parsed })
        }
      }
    } catch {
      // Malformed JSON or private mode -- start fresh
    }

    // Read BYOK key if stored
    const storedKey = localStorage.getItem('ragscope_byok_key')
    if (storedKey) {
      dispatch({ type: 'SET_BYOK_KEY', payload: storedKey })
    }

    // React to BYOK changes made via BYOKDrawer without a page reload.
    // BYOKDrawer dispatches this custom event whenever the key is saved or cleared.
    const onByokChange = (e: Event) => {
      const key = (e as CustomEvent<{ key: string | null }>).detail?.key ?? null
      dispatch({ type: 'SET_BYOK_KEY', payload: key })
    }
    window.addEventListener('ragscope_byok_changed', onByokChange)
    return () => window.removeEventListener('ragscope_byok_changed', onByokChange)
  }, [])

  const setStep = useCallback(
    (step: StepNumber) => dispatch({ type: 'SET_STEP', payload: step }),
    []
  )

  const setCorpus = useCallback((hash: string, count: number) => {
    dispatch({ type: 'SET_CORPUS', payload: { hash, count } })
  }, [])

  const addRunResult = useCallback((result: RunResult) => {
    dispatch({ type: 'ADD_RUN_RESULT', payload: result })
  }, [])

  const clearHistory = useCallback(() => {
    dispatch({ type: 'CLEAR_HISTORY' })
  }, [])

  return (
    <AppContext.Provider
      value={{ state, dispatch, setStep, setCorpus, addRunResult, clearHistory }}
    >
      {children}
    </AppContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAppContext() {
  return useContext(AppContext)
}
