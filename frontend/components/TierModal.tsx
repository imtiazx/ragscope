'use client'

/**
 * TierModal -- access tier information shown on first visit to /app.
 *
 * Explains the three access tiers clearly before the user starts using the
 * product. Designed to feel informative rather than obstructive: Tier 1
 * Guest is highlighted as the default and a single "Continue as Guest"
 * button dismisses the modal. A "Do not show again" checkbox stores the
 * preference in localStorage.
 *
 * The modal traps focus and closes on ESC key press.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Zap, User, Key } from 'lucide-react'
import { useUI } from '@/context/UIContext'

const DISMISS_KEY = 'ragscope_tier_modal_dismissed'

interface TierModalProps {
  isOpen: boolean
  onClose: () => void
  /** @deprecated Pass no-op; drawer is now opened via UIContext */
  onOpenByok?: () => void
}

const TIERS = [
  {
    id: 'dev',
    Icon: Zap,
    label: 'Tier 0',
    name: 'Developer',
    tagline: 'By invitation only',
    isDefault: false,
    features: [
      'Unlimited benchmark runs',
      'No rate limits',
      'All features unlocked',
      'Priority support',
    ],
    cta: null,
    ctaNote: (
      <span>
        Contact{' '}
        <a
          href="https://linkedin.com/in/imtiazx"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          style={{ color: 'var(--color-accent)' }}
        >
          ImtiazX on LinkedIn
        </a>{' '}
        to request access.
      </span>
    ),
  },
  {
    id: 'guest',
    Icon: User,
    label: 'Tier 1',
    name: 'Guest',
    tagline: 'Start immediately, no account needed',
    isDefault: true,
    features: [
      '3 benchmark runs per day',
      '3 chat questions per run',
      '10MB combined corpus limit',
      'Shared OpenAI API key',
    ],
    cta: null,
    ctaNote: null,
  },
  {
    id: 'byok',
    Icon: Key,
    label: 'Tier 2',
    name: 'BYOK',
    tagline: 'Bring your own API key',
    isDefault: false,
    features: [
      'Unlimited benchmark runs',
      'Full corpus size',
      'LangSmith trace export',
      'Key stays in your browser only',
    ],
    cta: 'Configure API Key',
    ctaNote: null,
  },
]

export default function TierModal({ isOpen, onClose }: TierModalProps) {
  const { openBYOKDrawer } = useUI()
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Focus the close button when the modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => closeButtonRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(DISMISS_KEY, 'true')
      } catch {
        // Private mode or quota exceeded -- non-fatal
      }
    }
    onClose()
  }

  const handleByok = () => {
    handleClose()
    openBYOKDrawer()
  }

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
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Modal */}
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tier-modal-title"
          >
            <motion.div
              className="relative w-full max-w-4xl rounded-2xl overflow-hidden"
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
                className="flex items-start justify-between px-8 pt-8 pb-6"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <div>
                  <h2
                    id="tier-modal-title"
                    className="text-xl font-bold tracking-tight mb-1"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    Choose how you want to use RAGScope
                  </h2>
                  <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    Guest access is free and instant. Upgrade any time by adding
                    your own API key.
                  </p>
                </div>
                <button
                  ref={closeButtonRef}
                  onClick={handleClose}
                  className="p-1.5 rounded-lg transition-colors ml-4 flex-shrink-0"
                  style={{ color: 'var(--color-text-secondary)' }}
                  aria-label="Close this dialog"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              {/* Tier cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 px-8 py-6">
                {TIERS.map(tier => (
                  <div
                    key={tier.id}
                    className="rounded-xl p-5 flex flex-col gap-4 relative"
                    style={
                      tier.isDefault
                        ? {
                            background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.05)',
                            border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.3)',
                          }
                        : {
                            background: 'var(--color-bg)',
                            border: '1px solid var(--color-border)',
                          }
                    }
                  >
                    {/* Default badge */}
                    {tier.isDefault && (
                      <span
                        className="absolute top-4 right-4 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider"
                        style={{
                          background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15)',
                          color: 'var(--color-accent)',
                        }}
                      >
                        Default
                      </span>
                    )}

                    {/* Icon + title */}
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{
                          background: tier.isDefault
                            ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.12)'
                            : 'var(--color-surface)',
                          border: tier.isDefault
                            ? '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)'
                            : '1px solid var(--color-border)',
                        }}
                        aria-hidden="true"
                      >
                        <tier.Icon
                          size={18}
                          style={{
                            color: tier.isDefault
                              ? 'var(--color-accent)'
                              : 'var(--color-text-secondary)',
                          }}
                        />
                      </div>
                      <div>
                        <p
                          className="text-[11px] font-semibold tracking-widest uppercase"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {tier.label}
                        </p>
                        <p
                          className="text-base font-bold leading-tight"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {tier.name}
                        </p>
                      </div>
                    </div>

                    {/* Tagline */}
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      {tier.tagline}
                    </p>

                    {/* Feature list */}
                    <ul className="flex flex-col gap-1.5 flex-1">
                      {tier.features.map(f => (
                        <li
                          key={f}
                          className="flex items-start gap-2 text-xs"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          <span
                            className="mt-0.5 text-[8px] leading-none"
                            style={{ color: 'var(--color-accent)' }}
                            aria-hidden="true"
                          >
                            ●
                          </span>
                          {f}
                        </li>
                      ))}
                    </ul>

                    {/* CTA or note */}
                    {tier.cta && (
                      <button
                        onClick={handleByok}
                        className="w-full py-2 rounded-lg text-xs font-semibold transition-colors"
                        style={{
                          background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)',
                          border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)',
                          color: 'var(--color-accent)',
                        }}
                      >
                        {tier.cta}
                      </button>
                    )}
                    {tier.ctaNote && (
                      <p
                        className="text-xs"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {tier.ctaNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div
                className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-8 pb-8"
              >
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={e => setDontShowAgain(e.target.checked)}
                    className="w-4 h-4 rounded accent-accent"
                    aria-label="Do not show this dialog again"
                  />
                  <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    Do not show again
                  </span>
                </label>

                <button
                  onClick={handleClose}
                  className="btn-accent px-8"
                  aria-label="Continue as a guest user"
                >
                  Continue as Guest
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}
