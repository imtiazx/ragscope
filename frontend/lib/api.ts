/**
 * Typed API client for all RAGScope backend calls.
 *
 * All paths go through /api/... which Next.js rewrites to the FastAPI backend
 * (configured in next.config.js). This avoids direct cross-origin calls from
 * the browser and means CORS only needs to be configured on the Next.js server,
 * not the backend.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParamSchemaEntry {
  name: string
  type: 'int' | 'float' | 'enum'
  default: number | string
  min: number | null
  max: number | null
  options?: string[]
  description: string
}

export interface ChunkerInfo {
  name: string
  display_name: string
  param_schema: ParamSchemaEntry[]
}

export interface RetrieverInfo {
  name: string
  display_name: string
  description: string
  param_schema: ParamSchemaEntry[]
}

export interface StrategiesResponse {
  retrievers: RetrieverInfo[]
  chunkers: ChunkerInfo[]
  compression: { param_schema: ParamSchemaEntry[] }
}

export interface IngestResponse {
  corpus_hash: string
  chunk_count: number
}

export interface BenchmarkResponse {
  run_ids: string[]
}

export interface RunStatusResponse {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  retrieval_strategy: string
  question: string
  faithfulness: number | null
  context_utilization: number | null
  answer_relevancy: number | null
  latency_ms: number | null
  generated_answer: string | null
  retrieved_chunks: Array<{
    chunk_id: string
    content: string
    score: number
    metadata?: Record<string, unknown>
  }>
  error_message: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Base fetch with error handling
// ---------------------------------------------------------------------------

/**
 * Error thrown by apiFetch on a non-2xx response. Carries the HTTP status
 * code as a property so callers can branch on specific cases (e.g. 429
 * rate limit) rather than string-matching the message. Extends Error so
 * legacy callers that only read .message keep working unchanged.
 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function getDevTokenHeader(): Record<string, string> {
  try {
    const token = sessionStorage.getItem('ragscope_dev_token')
    if (token) return { 'X-Dev-Token': token }
  } catch {
    // sessionStorage unavailable (SSR, private mode) -- omit the header silently
  }
  return {}
}

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const existing = (options?.headers ?? {}) as Record<string, string>
  const merged: RequestInit = {
    ...options,
    headers: { ...existing, ...getDevTokenHeader() },
  }
  const res = await fetch(`/api${path}`, merged)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body?.detail ?? detail
    } catch {
      // Non-JSON error body -- keep the status code message
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Endpoint functions
// ---------------------------------------------------------------------------

/** Fetch all registered strategies and their param schemas. */
export async function fetchStrategies(): Promise<StrategiesResponse> {
  return apiFetch<StrategiesResponse>('/strategies')
}

/**
 * Upload files and index the resulting corpus.
 *
 * Files are sent as multipart/form-data alongside the chunker configuration.
 * Returns the corpus hash and total number of stored chunks.
 */
export async function ingestFiles(
  files: File[],
  chunkerStrategy: string,
  chunkerParams: Record<string, unknown>
): Promise<IngestResponse> {
  const form = new FormData()
  for (const file of files) {
    form.append('files', file)
  }
  form.append('chunker_strategy', chunkerStrategy)
  form.append('chunker_params', JSON.stringify(chunkerParams))

  return apiFetch<IngestResponse>('/ingest', { method: 'POST', body: form })
}

/**
 * Strategy configuration for a single retrieval run within a multi-strategy request.
 * Each item in the strategies list results in one background task and one run_id.
 */
export interface StrategyConfig {
  strategy: string
  retrieval_params?: Record<string, unknown>
  compression_enabled?: boolean
  compression_params?: Record<string, unknown>
}

/**
 * Create one or more benchmark runs (one per strategy). Returns immediately with
 * a list of run_ids. Poll GET /results/{run_id} for each one independently.
 */
export async function createBenchmark(payload: {
  corpus_hash: string
  question: string
  chunker_strategy: string
  chunker_params: Record<string, unknown>
  strategies: StrategyConfig[]
}): Promise<BenchmarkResponse> {
  return apiFetch<BenchmarkResponse>('/benchmark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** Poll for the status and results of a benchmark run. */
export async function getRunStatus(runId: string): Promise<RunStatusResponse> {
  return apiFetch<RunStatusResponse>(`/results/${runId}`)
}

/**
 * Body and response shape for POST /chat.
 *
 * Chat is a synchronous endpoint: one request produces one answer without
 * creating a benchmark_runs row and without RAGAS evaluation. The backend
 * enforces a Tier 1 daily limit of 5 questions per fingerprint+date via the
 * chat_count column in rate_limit_counters. HTTP 429 means the limit has
 * been reached for today; HTTP 404 means the corpus has not been ingested.
 */
export interface ChatRequest {
  corpus_hash: string
  question: string
  retrieval_strategy: string
  retrieval_params: Record<string, unknown>
  compression_enabled: boolean
  compression_params: Record<string, unknown>
}

export interface ChatChunk {
  chunk_id: string
  content: string
  score: number
  metadata?: Record<string, unknown>
}

export interface ChatResponse {
  answer: string
  retrieved_chunks: ChatChunk[]
  strategy_used: string
}

/**
 * Send one chat question against an already-ingested corpus.
 *
 * Returns the generated answer plus the chunks the retriever surfaced.
 * Throws ApiError with status=429 when the daily chat quota is exhausted -
 * callers should branch on err.status to disable the input rather than
 * matching the message text.
 */
export async function chatRequest(payload: ChatRequest): Promise<ChatResponse> {
  return apiFetch<ChatResponse>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
