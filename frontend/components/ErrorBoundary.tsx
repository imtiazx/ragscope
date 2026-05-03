'use client'

/**
 * ErrorBoundary -- catches render errors anywhere in the wrapped subtree.
 *
 * React error boundaries must be class components because getDerivedStateFromError
 * and componentDidCatch are class lifecycle methods with no hooks equivalent.
 * The fallback shows the error message and a Retry button that resets the
 * boundary, allowing the subtree to re-mount cleanly.
 *
 * Async fetch errors (network failures, API 4xx/5xx responses) are NOT caught
 * here -- those must be handled inside async functions with try/catch. This
 * boundary catches errors that occur during React's render and commit phases.
 */

import React, { type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

// ---------------------------------------------------------------------------
// Fallback UI
// ---------------------------------------------------------------------------

function ErrorFallback({
  error,
  onRetry,
}: {
  error: Error | null
  onRetry: () => void
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-5 py-20 text-center max-w-sm mx-auto"
      role="alert"
      aria-live="assertive"
    >
      <AlertCircle
        size={32}
        style={{ color: '#FF6B6B' }}
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
          Something went wrong
        </p>
        {error?.message && (
          <p
            className="text-xs font-mono px-3 py-2 rounded-lg mt-2"
            style={{
              background: 'rgba(255,107,107,0.06)',
              border: '1px solid rgba(255,107,107,0.15)',
              color: '#FF6B6B',
            }}
          >
            {error.message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="btn-ghost flex items-center gap-2"
        aria-label="Retry the failed operation"
      >
        <RefreshCw size={14} aria-hidden="true" />
        Try again
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error boundary class component
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional custom fallback. Receives onRetry callback. */
  fallback?: (onRetry: () => void) => ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
    this.handleRetry = this.handleRetry.bind(this)
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // In production this would send to an error monitoring service.
    // For now, log to console so developers can diagnose.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info.componentStack)
    }
  }

  handleRetry() {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
        ? this.props.fallback(this.handleRetry)
        : <ErrorFallback error={this.state.error} onRetry={this.handleRetry} />
    }
    return this.props.children
  }
}
