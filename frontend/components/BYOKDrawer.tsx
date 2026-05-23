'use client'

/**
 * BYOKDrawer -- slide-in settings panel for Bring Your Own Key configuration.
 *
 * Allows users to supply their own OpenAI or Anthropic API key to remove
 * guest-tier rate limits. The key is stored exclusively in localStorage and
 * is never sent to the RAGScope backend. When a key is saved, a custom DOM
 * event is dispatched so any mounted AppContext can update its byokKey state
 * without requiring a shared context reference.
 *
 * Drawer animates in from the right with a backdrop blur overlay.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Eye, EyeOff, Shield, Trash2, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react'
import { useUI } from '@/context/UIContext'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY_KEY   = 'ragscope_byok_key'
const STORAGE_KEY_MODEL = 'ragscope_byok_model'

type Provider = 'openai' | 'anthropic'

const MODEL_OPTIONS: Record<Provider, string[]> = {
  openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
  anthropic: ['claude-haiku-3-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
}

const KEY_PREFIXES: Record<Provider, string> = {
  openai:    'sk-',
  anthropic: 'sk-ant-',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (key.length <= 10) return '*'.repeat(key.length)
  return '*'.repeat(key.length - 10) + key.slice(-10)
}

function detectProvider(key: string): Provider | null {
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('sk-'))     return 'openai'
  return null
}

function broadcastByokChange(key: string | null) {
  // Custom event so AppContext (which may be mounted elsewhere in the tree)
  // can react to the change without a shared context reference.
  window.dispatchEvent(
    new CustomEvent('ragscope_byok_changed', { detail: { key } })
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BYOKDrawer() {
  const { byokDrawerOpen, closeBYOKDrawer, byokOnBack } = useUI()

  /**
   * Fires the onBack callback (typically reopens a parent modal) and closes
   * the drawer. Used when the drawer was opened from the landing-page tier
   * selection so the user can return to that selection without picking BYOK.
   */
  const handleBack = () => {
    const cb = byokOnBack
    closeBYOKDrawer()
    cb?.()
  }

  const [provider, setProvider]     = useState<Provider>('openai')
  const [keyInput, setKeyInput]     = useState('')
  const [showKey, setShowKey]       = useState(false)
  const [savedKey, setSavedKey]     = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [saveError, setSaveError]   = useState<string | null>(null)
  const [justSaved, setJustSaved]   = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Hydrate from localStorage on open
  useEffect(() => {
    if (!byokDrawerOpen) return
    const stored = localStorage.getItem(STORAGE_KEY_KEY)
    const storedModel = localStorage.getItem(STORAGE_KEY_MODEL)

    if (stored) {
      setSavedKey(stored)
      const detected = detectProvider(stored)
      if (detected) setProvider(detected)
      setSelectedModel(storedModel ?? MODEL_OPTIONS[detected ?? 'openai'][0])
    } else {
      setSavedKey(null)
      setSelectedModel(MODEL_OPTIONS[provider][0])
    }

    // Focus the input shortly after open
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [byokDrawerOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (byokDrawerOpen && e.key === 'Escape') closeBYOKDrawer()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [byokDrawerOpen, closeBYOKDrawer])

  // When provider changes, reset model selector to first option
  const handleProviderChange = (p: Provider) => {
    setProvider(p)
    setKeyInput('')
    setSaveError(null)
    setSelectedModel(MODEL_OPTIONS[p][0])
  }

  const handleSave = () => {
    const trimmed = keyInput.trim()
    if (!trimmed) {
      setSaveError('Enter an API key before saving.')
      return
    }

    // Basic format validation -- not a live API call
    if (!trimmed.startsWith(KEY_PREFIXES[provider])) {
      setSaveError(
        `${provider === 'openai' ? 'OpenAI' : 'Anthropic'} keys start with "${KEY_PREFIXES[provider]}".`
      )
      return
    }

    setSaveError(null)
    localStorage.setItem(STORAGE_KEY_KEY,   trimmed)
    localStorage.setItem(STORAGE_KEY_MODEL, selectedModel)
    setSavedKey(trimmed)
    setKeyInput('')
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 2500)
    broadcastByokChange(trimmed)
  }

  const handleClear = () => {
    localStorage.removeItem(STORAGE_KEY_KEY)
    localStorage.removeItem(STORAGE_KEY_MODEL)
    setSavedKey(null)
    setKeyInput('')
    setSaveError(null)
    setSelectedModel(MODEL_OPTIONS[provider][0])
    broadcastByokChange(null)
  }

  return (
    <AnimatePresence>
      {byokDrawerOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeBYOKDrawer}
            aria-hidden="true"
          />

          {/* Drawer panel */}
          <motion.aside
            className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-96 flex flex-col overflow-y-auto"
            style={{
              background: 'var(--color-surface)',
              borderLeft: '1px solid var(--color-border)',
            }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="byok-drawer-title"
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-6 pt-6 pb-4 gap-3"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                {byokOnBack && (
                  <button
                    onClick={handleBack}
                    className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                    style={{ color: 'var(--color-text-secondary)' }}
                    aria-label="Back to tier selection"
                  >
                    <ArrowLeft size={16} aria-hidden="true" />
                  </button>
                )}
                <div className="min-w-0">
                  <h2
                    id="byok-drawer-title"
                    className="text-base font-bold"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    API Key Settings
                  </h2>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    Bring your own key for unlimited access
                  </p>
                </div>
              </div>
              <button
                onClick={closeBYOKDrawer}
                className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                style={{ color: 'var(--color-text-secondary)' }}
                aria-label="Close API key settings"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-6 px-6 py-6 flex-1">

              {/* BYOK explanation */}
              <div
                className="rounded-xl p-4 flex flex-col gap-2"
                style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                <p className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  What is BYOK?
                </p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  Bring Your Own Key means you supply your own OpenAI or Anthropic
                  API key instead of using the shared guest key. Your key unlocks
                  unlimited benchmark runs and chat questions, full corpus size,
                  and LangSmith trace export.
                </p>
              </div>

              {/* Provider selector */}
              <div>
                <p className="text-xs font-semibold mb-2.5" style={{ color: 'var(--color-text-secondary)' }}>
                  Provider
                </p>
                <div className="flex gap-2" role="radiogroup" aria-label="API provider">
                  {(['openai', 'anthropic'] as Provider[]).map(p => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={provider === p}
                      onClick={() => handleProviderChange(p)}
                      className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all duration-150"
                      style={{
                        background: provider === p ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)' : 'var(--color-bg)',
                        border: `1px solid ${provider === p ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)' : 'var(--color-border)'}`,
                        color: provider === p ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                      }}
                    >
                      {p === 'openai' ? 'OpenAI' : 'Anthropic'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Current saved key indicator */}
              {savedKey && (
                <div
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                  style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)' }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={14} style={{ color: '#4ADE80', flexShrink: 0 }} aria-hidden="true" />
                    <span
                      className="font-mono text-xs truncate"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {maskKey(savedKey)}
                    </span>
                  </div>
                  <button
                    onClick={handleClear}
                    className="flex items-center gap-1 text-xs ml-3 transition-colors"
                    style={{ color: '#FF6B6B', flexShrink: 0 }}
                    aria-label="Remove stored API key"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    Remove
                  </button>
                </div>
              )}

              {/* Key input */}
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="byok-key-input"
                  className="text-xs font-semibold"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {savedKey ? 'Replace key' : `${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`}
                </label>

                <div className="relative flex items-center">
                  <input
                    id="byok-key-input"
                    ref={inputRef}
                    type={showKey ? 'text' : 'password'}
                    value={keyInput}
                    onChange={e => { setKeyInput(e.target.value); setSaveError(null) }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                    placeholder={`${KEY_PREFIXES[provider]}...`}
                    className="w-full rounded-lg px-3 py-2.5 pr-10 text-sm font-mono transition-colors"
                    style={{
                      background: 'var(--color-bg)',
                      border: `1px solid ${saveError ? 'rgba(255,107,107,0.5)' : 'var(--color-border)'}`,
                      color: 'var(--color-text-primary)',
                      outline: 'none',
                    }}
                    aria-describedby={saveError ? 'key-error' : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(s => !s)}
                    className="absolute right-3 transition-colors"
                    style={{ color: 'var(--color-text-secondary)' }}
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showKey
                      ? <EyeOff size={15} aria-hidden="true" />
                      : <Eye    size={15} aria-hidden="true" />}
                  </button>
                </div>

                {saveError && (
                  <p
                    id="key-error"
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: '#FF6B6B' }}
                    role="alert"
                  >
                    <AlertCircle size={12} aria-hidden="true" />
                    {saveError}
                  </p>
                )}

                {justSaved && (
                  <p
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: '#4ADE80' }}
                    role="status"
                    aria-live="polite"
                  >
                    <CheckCircle2 size={12} aria-hidden="true" />
                    Key saved. Unlimited access unlocked.
                  </p>
                )}
              </div>

              {/* Model selector -- shown once a key is saved */}
              {savedKey && (
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="byok-model-select"
                    className="text-xs font-semibold"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    Preferred model
                  </label>
                  <select
                    id="byok-model-select"
                    value={selectedModel}
                    onChange={e => {
                      setSelectedModel(e.target.value)
                      localStorage.setItem(STORAGE_KEY_MODEL, e.target.value)
                    }}
                    className="rounded-lg px-3 py-2 text-sm"
                    style={{
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-primary)',
                    }}
                    aria-label="Preferred model for BYOK runs"
                  >
                    {MODEL_OPTIONS[provider].map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    Used for retrieval LLM calls when your key is active.
                  </p>
                </div>
              )}

              {/* Save button */}
              {keyInput.trim() && (
                <button
                  type="button"
                  onClick={handleSave}
                  className="btn-accent w-full"
                  aria-label="Save API key"
                >
                  Save key
                </button>
              )}

              {/* Security note */}
              <div
                className="mt-auto rounded-xl p-4 flex gap-3"
                style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                <Shield
                  size={16}
                  style={{ color: 'var(--color-text-secondary)', flexShrink: 0, marginTop: '1px' }}
                  aria-hidden="true"
                />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  Your API key is stored in your browser&apos;s localStorage only. It is never
                  transmitted to the RAGScope backend or any third-party service. Clearing
                  your browser data removes it permanently. You can verify this by
                  inspecting network requests in your browser developer tools.
                </p>
              </div>

            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
