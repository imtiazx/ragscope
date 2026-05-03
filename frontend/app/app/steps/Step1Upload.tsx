'use client'

/**
 * Step 1 -- Upload corpus and configure chunking.
 *
 * Flow:
 *   1. User drops or selects PDF / TXT files.
 *   2. User selects a chunker strategy (fetched from GET /strategies).
 *   3. User adjusts chunker parameters via the dynamic param form, or
 *      resets to recommended defaults.
 *   4. User clicks "Proceed" which calls POST /ingest.
 *   5. On success: corpus_hash and chunkCount are stored in AppContext and
 *      the app advances to Step 2.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, FileText, X, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react'
import { useAppContext } from '@/context/AppContext'
import { useUI } from '@/context/UIContext'
import ParamForm from '@/components/ParamForm'
import { fetchStrategies, ingestFiles } from '@/lib/api'
import type { ChunkerInfo, ParamSchemaEntry } from '@/lib/api'

// ---------------------------------------------------------------------------
// Static descriptions for each chunker (backend does not include these)
// ---------------------------------------------------------------------------

const CHUNKER_DESCRIPTIONS: Record<string, string> = {
  fixed_size:
    'Splits text into fixed-length token windows with configurable overlap. Fast, predictable, and the standard baseline for every RAG comparison.',
  semantic:
    'Places boundaries where cosine similarity drops between adjacent sentences. Produces thematically coherent chunks at the cost of additional embedding API calls.',
  hierarchical:
    'Creates two levels: large parent chunks for broad context and small child chunks for precise retrieval. The retriever returns child matches backed by parent context.',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function buildDefaultParams(schema: ParamSchemaEntry[]): Record<string, unknown> {
  return Object.fromEntries(schema.map(e => [e.name, e.default]))
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileDropZone({
  files,
  onAdd,
  onRemove,
}: {
  files: File[]
  onAdd: (f: File[]) => void
  onRemove: (name: string) => void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = (incoming: FileList | null) => {
    if (!incoming) return
    const valid = Array.from(incoming).filter(
      f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.txt')
    )
    onAdd(valid)
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      accept(e.dataTransfer.files)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const overLimit = totalBytes > MAX_BYTES

  return (
    <div className="flex flex-col gap-3">
      {/* Drop zone */}
      <button
        type="button"
        className="w-full rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center gap-3 py-10 px-6 cursor-pointer"
        style={{
          borderColor: dragging
            ? 'var(--color-accent)'
            : 'var(--color-border)',
          background: dragging
            ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.04)'
            : 'var(--color-surface)',
        }}
        onDragEnter={e => { e.preventDefault(); setDragging(true) }}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        aria-label="Drop PDF or TXT files here, or click to browse"
      >
        <Upload
          size={28}
          aria-hidden="true"
          style={{ color: dragging ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}
        />
        <div className="text-center">
          <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
            Drop PDF or TXT files here
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            or{' '}
            <span style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}>
              click to browse
            </span>
            , 10 MB combined limit
          </p>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.txt,application/pdf,text/plain"
        className="hidden"
        onChange={e => accept(e.target.files)}
        aria-hidden="true"
      />

      {/* File list */}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Selected files">
          {files.map(f => (
            <li
              key={`${f.name}-${f.size}`}
              className="flex items-center justify-between px-3 py-2 rounded-lg"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText
                  size={14}
                  aria-hidden="true"
                  style={{ color: 'var(--color-accent)', flexShrink: 0 }}
                />
                <span
                  className="text-xs font-medium truncate"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {f.name}
                </span>
                <span
                  className="text-xs flex-shrink-0"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {formatBytes(f.size)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onRemove(f.name)}
                className="p-1 rounded transition-colors ml-2 flex-shrink-0"
                style={{ color: 'var(--color-text-secondary)' }}
                aria-label={`Remove ${f.name}`}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Size summary + over-limit warning */}
      {files.length > 0 && (
        <div className="flex items-center justify-between text-xs px-1">
          <span style={{ color: 'var(--color-text-secondary)' }}>
            Total: {formatBytes(totalBytes)}
          </span>
          {overLimit && (
            <span
              className="flex items-center gap-1 font-medium"
              style={{ color: '#FF6B6B' }}
              role="alert"
            >
              <AlertCircle size={12} aria-hidden="true" />
              Exceeds 10 MB limit
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main step component
// ---------------------------------------------------------------------------

export default function Step1Upload() {
  const { state, dispatch, setCorpus, setStep } = useAppContext()
  const { addToast } = useUI()

  // Files
  const [files, setFiles] = useState<File[]>([])

  // Strategies data
  const [chunkers, setChunkers] = useState<ChunkerInfo[]>([])
  const [loadingStrategies, setLoadingStrategies] = useState(true)
  const [strategiesError, setStrategiesError] = useState<string | null>(null)

  // Chunker selection (lift into context when proceeding)
  const [selectedChunker, setSelectedChunker] = useState(state.chunkerStrategy || 'fixed_size')
  const [params, setParams] = useState<Record<string, unknown>>(state.chunkerParams || {})

  // Ingest state
  const [ingesting, setIngesting] = useState(false)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [ingestDone, setIngestDone] = useState(
    !!state.corpusHash // already ingested this session
  )

  // Fetch available chunkers
  useEffect(() => {
    fetchStrategies()
      .then(data => {
        setChunkers(data.chunkers)
        // Initialise params from the currently selected chunker's defaults
        const current = data.chunkers.find(c => c.name === selectedChunker)
        if (current && Object.keys(params).length === 0) {
          setParams(buildDefaultParams(current.param_schema))
        }
      })
      .catch(err => setStrategiesError(String(err)))
      .finally(() => setLoadingStrategies(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentChunker = chunkers.find(c => c.name === selectedChunker)

  const handleChunkerSelect = (name: string) => {
    setSelectedChunker(name)
    const c = chunkers.find(ch => ch.name === name)
    if (c) setParams(buildDefaultParams(c.param_schema))
    setIngestDone(false)
  }

  const handleParamChange = (name: string, value: unknown) => {
    setParams(prev => ({ ...prev, [name]: value }))
    setIngestDone(false)
  }

  const handleDefaults = () => {
    if (currentChunker) setParams(buildDefaultParams(currentChunker.param_schema))
  }

  const handleAddFiles = (incoming: File[]) => {
    setFiles(prev => {
      const combined = [...prev, ...incoming]
      // Deduplicate by name + size
      return combined.filter(
        (f, i) => combined.findIndex(x => x.name === f.name && x.size === f.size) === i
      )
    })
    setIngestDone(false)
  }

  const handleRemoveFile = (name: string) => {
    setFiles(prev => prev.filter(f => f.name !== name))
    setIngestDone(false)
  }

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const overLimit = totalBytes > MAX_BYTES
  const canProceed = files.length > 0 && !overLimit && !ingesting && !ingestDone

  const handleProceed = async () => {
    setIngesting(true)
    setIngestError(null)
    try {
      const result = await ingestFiles(files, selectedChunker, params)
      // Persist to context
      setCorpus(result.corpus_hash, result.chunk_count)
      dispatch({ type: 'SET_CHUNKER_STRATEGY', payload: selectedChunker })
      dispatch({ type: 'SET_CHUNKER_PARAMS', payload: params })
      setIngestDone(true)
      addToast('success', `Corpus ready. ${result.chunk_count.toLocaleString()} chunks indexed.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ingest failed. Please try again.'
      setIngestError(msg)
      addToast('error', msg)
    } finally {
      setIngesting(false)
    }
  }

  const handleAdvance = () => setStep(2)

  return (
    <div className="max-w-3xl lg:max-w-4xl mx-auto flex flex-col gap-10 py-6">

      {/* Section: Upload files */}
      <section aria-labelledby="upload-heading">
        <h2
          id="upload-heading"
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Upload your corpus
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--color-text-secondary)' }}>
          Supported formats: PDF and plain text. Multiple files are treated as a
          single combined corpus.
        </p>
        <FileDropZone files={files} onAdd={handleAddFiles} onRemove={handleRemoveFile} />
      </section>

      {/* Section: Chunker strategy */}
      <section aria-labelledby="chunker-heading">
        <h2
          id="chunker-heading"
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Choose a chunking strategy
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--color-text-secondary)' }}>
          Chunking splits your documents into pieces before embedding. The
          strategy affects retrieval quality.
        </p>

        {loadingStrategies && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" aria-busy="true" aria-label="Loading strategies">
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton h-28 rounded-xl" />
            ))}
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Chunker strategies">
            {chunkers.map(chunker => {
              const selected = chunker.name === selectedChunker
              return (
                <button
                  key={chunker.name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => handleChunkerSelect(chunker.name)}
                  className="text-left rounded-xl p-4 flex flex-col gap-2 transition-all duration-150"
                  style={{
                    background: selected ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)' : 'var(--color-surface)',
                    border: selected
                      ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.35)'
                      : '1px solid var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-sm font-semibold"
                      style={{ color: selected ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
                    >
                      {chunker.display_name}
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {chunker.param_schema.length}p
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    {CHUNKER_DESCRIPTIONS[chunker.name] ?? 'A custom chunking strategy.'}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Section: Parameters */}
      {currentChunker && (
        <section aria-labelledby="params-heading">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2
                id="params-heading"
                className="text-base font-semibold"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Configure parameters
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                Adjust or leave as recommended defaults.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDefaults}
              className="btn-ghost text-xs flex items-center gap-1.5"
              aria-label="Reset all parameters to their recommended defaults"
            >
              <RefreshCw size={13} aria-hidden="true" />
              Reset defaults
            </button>
          </div>

          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          >
            <ParamForm
              schema={currentChunker.param_schema}
              values={params}
              onChange={handleParamChange}
            />
          </div>
        </section>
      )}

      {/* Loading bar */}
      {ingesting && (
        <div
          className="rounded-xl overflow-hidden h-1.5"
          style={{ background: 'var(--color-border)' }}
          role="progressbar"
          aria-label="Ingesting corpus"
          aria-valuenow={50}
        >
          <div
            className="h-full rounded-xl animate-scan"
            style={{ background: 'var(--color-accent)', width: '30%' }}
          />
        </div>
      )}

      {/* Error */}
      {ingestError && (
        <div
          className="flex items-center gap-2 p-4 rounded-xl text-sm"
          style={{ background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#FF6B6B' }}
          role="alert"
        >
          <AlertCircle size={16} aria-hidden="true" />
          {ingestError}
        </div>
      )}

      {/* Success state */}
      {ingestDone && state.corpusHash && (
        <div
          className="flex items-center gap-3 p-4 rounded-xl"
          style={{ background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06)', border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)' }}
          role="status"
        >
          <CheckCircle2 size={18} style={{ color: 'var(--color-accent)', flexShrink: 0 }} aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              Corpus ready
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {state.chunkCount?.toLocaleString()} chunks created and indexed.
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3">
        {ingestDone ? (
          <button
            type="button"
            onClick={handleAdvance}
            className="btn-accent"
            aria-label="Advance to benchmark configuration"
          >
            Configure benchmark
          </button>
        ) : (
          <button
            type="button"
            onClick={handleProceed}
            disabled={!canProceed}
            className="btn-accent"
            aria-label="Upload and index the corpus"
          >
            {ingesting ? 'Processing...' : 'Proceed'}
          </button>
        )}
      </div>

    </div>
  )
}
