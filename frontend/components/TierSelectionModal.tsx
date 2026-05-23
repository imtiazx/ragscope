'use client'

/**
 * TierSelectionModal -- gateway between the landing page CTA and the app.
 *
 * Renders an overlay with three tier cards (Guest, BYOK, Developer). Each
 * card maps to a distinct entry path:
 *
 *   Guest      navigate directly to /app (default Tier 1 behaviour)
 *   BYOK       close this modal, open the global BYOK drawer; the drawer
 *              gets a back callback that re-opens this modal so the user
 *              can change their mind without committing to a key
 *   Developer  swap the card grid for a token input view inside the same
 *              modal; on confirm, store the token in sessionStorage under
 *              the same key Step2Configure reads ('ragscope_dev_token')
 *              and navigate to /app
 *
 * This file owns no routing rules other than what is described above; the
 * landing page mounts and controls it via the `isOpen`/`onClose` props.
 *
 * No em-dashes, no emojis, no hardcoded secrets.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Key, User, X, Zap, AlertCircle, type LucideIcon } from 'lucide-react'

const DEV_TOKEN_STORAGE_KEY = 'ragscope_dev_token'

/** What the modal is currently showing. */
type View = 'cards' | 'dev'

interface TierSelectionModalProps {
  isOpen: boolean
  onClose: () => void
  /**
   * Invoked when the user picks the BYOK tier. The parent is responsible for
   * closing this modal and opening the BYOK drawer, and for wiring the
   * drawer's Back affordance back to a re-open of this modal.
   */
  onSelectByok: () => void
}

export default function TierSelectionModal({
  isOpen,
  onClose,
  onSelectByok,
}: TierSelectionModalProps) {
  const router = useRouter()

  const [view, setView] = useState<View>('cards')
  const [token, setToken] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const tokenInputRef = useRef<HTMLInputElement>(null)

  /** Reset transient state every time the modal is reopened from scratch. */
  useEffect(() => {
    if (isOpen) {
      setView('cards')
      setToken('')
      setTokenError(null)
    }
  }, [isOpen])

  /** Focus the token field shortly after the dev view is shown. */
  useEffect(() => {
    if (isOpen && view === 'dev') {
      const t = setTimeout(() => tokenInputRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [isOpen, view])

  /** Escape closes the modal entirely (dismissal is equivalent to Guest). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // ---- Action handlers ----------------------------------------------------

  const handleGuest = () => {
    onClose()
    router.push('/app')
  }

  const handleByok = () => {
    // Delegate to the parent: it closes this modal, opens the BYOK drawer,
    // and registers a back callback that will re-open this modal on the
    // card view if the user changes their mind inside the drawer.
    onSelectByok()
  }

  const handleDeveloper = () => {
    setView('dev')
  }

  const handleConfirmDev = () => {
    const trimmed = token.trim()
    if (!trimmed) {
      setTokenError('Token required')
      return
    }
    try {
      sessionStorage.setItem(DEV_TOKEN_STORAGE_KEY, trimmed)
    } catch {
      // sessionStorage unavailable (private mode) -- the backend will reject
      // the request and the user will see an error there.
    }
    onClose()
    router.push('/app')
  }

  const handleBackToCards = () => {
    setView('cards')
    setTokenError(null)
  }

  // ---- Render -------------------------------------------------------------

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Modal container */}
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tier-selection-title"
          >
            <motion.div
              className="relative w-full max-w-3xl rounded-2xl overflow-hidden"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.97 }}
              transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div
                className="flex items-start justify-between px-8 pt-8 pb-6 gap-4"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  {view === 'dev' && (
                    <button
                      type="button"
                      onClick={handleBackToCards}
                      className="p-1.5 rounded-lg transition-colors flex-shrink-0 mt-0.5"
                      style={{ color: 'var(--color-text-secondary)' }}
                      aria-label="Back to tier selection"
                    >
                      <ArrowLeft size={16} aria-hidden="true" />
                    </button>
                  )}
                  <div className="min-w-0">
                    <h2
                      id="tier-selection-title"
                      className="text-xl font-bold tracking-tight mb-1"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {view === 'cards'
                        ? 'How do you want to enter?'
                        : 'Enter your dev token'}
                    </h2>
                    <p
                      className="text-sm"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {view === 'cards'
                        ? 'Pick your access tier. Guest is the default and requires no setup.'
                        : 'The token is stored in your browser session only. It is never logged or sent to a third party.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                  style={{ color: 'var(--color-text-secondary)' }}
                  aria-label="Close tier selection"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              {/* Body */}
              {view === 'cards' ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 px-8 py-8">
                  <TierCard
                    Icon={User}
                    name="Guest"
                    description="12 benchmark runs per day. 5 chat questions per day. No account required."
                    onClick={handleGuest}
                    highlighted
                  />
                  <TierCard
                    Icon={Key}
                    name="BYOK"
                    description="Unlimited runs and chat. Paste your OpenAI or Anthropic key. Your key stays in your browser and is never sent to our servers."
                    onClick={handleByok}
                  />
                  <TierCard
                    Icon={Zap}
                    name="Developer"
                    description="Unlimited runs and chat. Enter your dev token to enable dev mode."
                    onClick={handleDeveloper}
                  />
                </div>
              ) : (
                <DevTokenView
                  inputRef={tokenInputRef}
                  token={token}
                  setToken={t => {
                    setToken(t)
                    if (tokenError) setTokenError(null)
                  }}
                  onConfirm={handleConfirmDev}
                  onBack={handleBackToCards}
                  error={tokenError}
                />
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface TierCardProps {
  Icon: LucideIcon
  name: string
  description: string
  onClick: () => void
  highlighted?: boolean
}

/**
 * Single clickable tier card. The whole card is a button so any click region
 * triggers the action and keyboard focus is unambiguous.
 */
function TierCard({ Icon, name, description, onClick, highlighted }: TierCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl p-5 flex flex-col gap-3 text-left transition-all duration-150 hover:scale-[1.015] focus:outline-none"
      style={
        highlighted
          ? {
              background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.05)',
              border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)',
            }
          : {
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
            }
      }
      aria-label={`Choose ${name} tier`}
    >
      <div className="flex items-center justify-between">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{
            background: highlighted
              ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.12)'
              : 'var(--color-surface)',
            border: highlighted
              ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)'
              : '1px solid var(--color-border)',
          }}
          aria-hidden="true"
        >
          <Icon
            size={18}
            style={{
              color: highlighted ? 'var(--color-accent)' : 'var(--color-text-secondary)',
            }}
          />
        </div>
        <ArrowRight
          size={14}
          style={{ color: 'var(--color-text-secondary)' }}
          aria-hidden="true"
        />
      </div>
      <p
        className="text-base font-bold leading-tight"
        style={{ color: 'var(--color-text-primary)' }}
      >
        {name}
      </p>
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {description}
      </p>
    </button>
  )
}

interface DevTokenViewProps {
  inputRef: React.RefObject<HTMLInputElement>
  token: string
  setToken: (t: string) => void
  onConfirm: () => void
  onBack: () => void
  error: string | null
}

/**
 * Secondary view inside the same modal: collects the developer token.
 * Submitted via Enter or the Confirm button; Back returns to the card view.
 */
function DevTokenView({
  inputRef,
  token,
  setToken,
  onConfirm,
  onBack,
  error,
}: DevTokenViewProps) {
  return (
    <div className="px-8 py-8 flex flex-col gap-4">
      <label
        htmlFor="dev-token-input"
        className="text-xs font-semibold"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        Dev token
      </label>
      <input
        id="dev-token-input"
        ref={inputRef}
        type="password"
        value={token}
        onChange={e => setToken(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onConfirm()
        }}
        placeholder="Dev token"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-lg px-3 py-2.5 text-sm font-mono transition-colors"
        style={{
          background: 'var(--color-bg)',
          border: `1px solid ${error ? 'rgba(255,107,107,0.5)' : 'var(--color-border)'}`,
          color: 'var(--color-text-primary)',
          outline: 'none',
        }}
        aria-describedby={error ? 'dev-token-error' : undefined}
        aria-invalid={Boolean(error)}
      />

      {error && (
        <p
          id="dev-token-error"
          className="flex items-center gap-1.5 text-xs"
          style={{ color: '#FF6B6B' }}
          role="alert"
        >
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onBack}
          className="btn-ghost"
          aria-label="Back to tier selection"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="btn-accent"
          aria-label="Confirm dev token and enter app"
        >
          Confirm
        </button>
      </div>
    </div>
  )
}
