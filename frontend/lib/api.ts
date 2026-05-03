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
  run_id: string
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

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`/api${path}`, options)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body?.detail ?? detail
    } catch {
      // Non-JSON error body -- keep the status code message
    }
    throw new Error(detail)
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
 * Create a new benchmark run. Returns immediately with a run_id.
 * Poll GET /results/{run_id} for results.
 */
export async function createBenchmark(payload: {
  corpus_hash: string
  question: string
  retrieval_strategy: string
  retrieval_params: Record<string, unknown>
  chunker_strategy: string
  chunker_params: Record<string, unknown>
  compression_enabled: boolean
  compression_params: Record<string, unknown>
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
