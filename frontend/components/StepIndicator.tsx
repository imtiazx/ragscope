'use client'

/**
 * StepIndicator -- linear progress tracker for the four-step app flow.
 *
 * Completed steps are clickable so the user can navigate back without losing
 * the state they already built. The current step is accent-highlighted. Future
 * steps are muted. A connecting line fills left-to-right based on progress.
 */

import { Check } from 'lucide-react'
import type { StepNumber } from '@/context/AppContext'

const STEPS: { number: StepNumber; label: string; shortLabel: string }[] = [
  { number: 1, label: 'Upload corpus',     shortLabel: 'Upload'    },
  { number: 2, label: 'Configure',         shortLabel: 'Configure' },
  { number: 3, label: 'Results',           shortLabel: 'Results'   },
  { number: 4, label: 'Chat',             shortLabel: 'Chat'      },
]

interface StepIndicatorProps {
  current: StepNumber
  /** Called when the user clicks a completed step to navigate back. */
  onNavigate: (step: StepNumber) => void
}

export default function StepIndicator({ current, onNavigate }: StepIndicatorProps) {
  return (
    <div
      className="flex items-center justify-center px-8 xl:px-12 2xl:px-16 py-5 max-w-[1400px] mx-auto w-full"
      role="navigation"
      aria-label="Benchmark steps"
    >
      <ol className="flex items-center w-full max-w-2xl">
        {STEPS.map((step, idx) => {
          const isCompleted = step.number < current
          const isCurrent  = step.number === current
          const isFuture   = step.number > current
          const isLast     = idx === STEPS.length - 1

          return (
            <li
              key={step.number}
              className="flex items-center"
              style={{ flex: isLast ? '0 0 auto' : '1 1 0' }}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {/* Circle + label */}
              <button
                type="button"
                onClick={() => isCompleted && onNavigate(step.number)}
                disabled={!isCompleted}
                className="flex flex-col items-center gap-1.5 group focus-visible:outline-none"
                aria-label={`${step.label}${isCompleted ? ' (completed, click to go back)' : isCurrent ? ' (current step)' : ' (not reached yet)'}`}
              >
                {/* Circle */}
                <span
                  className={[
                    'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold',
                    'border-2 transition-all duration-200',
                    isCompleted
                      ? 'border-accent bg-accent/20 text-accent cursor-pointer group-hover:bg-accent/30'
                      : isCurrent
                      ? 'border-accent bg-accent text-black'
                      : 'border-border bg-surface text-text-secondary cursor-default',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {isCompleted ? (
                    <Check size={14} strokeWidth={3} />
                  ) : (
                    step.number
                  )}
                </span>

                {/* Label -- hidden on very small screens */}
                <span
                  className={[
                    'hidden sm:block text-[11px] font-medium whitespace-nowrap',
                    isCurrent
                      ? 'text-text-primary'
                      : isCompleted
                      ? 'text-accent'
                      : 'text-text-secondary',
                  ].join(' ')}
                >
                  {step.shortLabel}
                </span>
              </button>

              {/* Connector line (not rendered after the last step) */}
              {!isLast && (
                <div
                  className="flex-1 mx-2 sm:mx-3 h-px transition-all duration-300"
                  style={{
                    background: isCompleted
                      ? 'var(--color-accent)'
                      : 'var(--color-border)',
                    opacity: isCompleted ? 0.5 : 1,
                  }}
                  aria-hidden="true"
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
