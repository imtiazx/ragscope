'use client'

/**
 * App shell -- the four-step benchmark experience.
 *
 * Wraps everything in AppContextProvider so all step components can read and
 * update shared state without prop drilling. On first visit, shows the tier
 * information modal before rendering any step content.
 *
 * Step navigation:
 *   - Forward: triggered by each step's own "Proceed" / "Run" buttons.
 *   - Backward: clicking any completed step in the StepIndicator.
 *   Going back never clears later steps, so the user can return to results
 *   or adjust config without losing their run history.
 *
 * Step transitions use framer-motion AnimatePresence with a subtle fade +
 * vertical slide. The ErrorBoundary wraps each step so a render crash in one
 * step shows a recovery UI rather than unmounting the whole app.
 */

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Nav from '@/components/Nav'
import StepIndicator from '@/components/StepIndicator'
import TierModal from '@/components/TierModal'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppContextProvider, useAppContext, type StepNumber } from '@/context/AppContext'
import Step1Upload from './steps/Step1Upload'
import Step2Configure from './steps/Step2Configure'
import Step3Results from './steps/Step3Results'
import Step4Chat from './steps/Step4Chat'

const DISMISS_KEY = 'ragscope_tier_modal_dismissed'

function AppShellInner() {
  const { state, setStep } = useAppContext()
  const [showTierModal, setShowTierModal] = useState(false)

  useEffect(() => {
    // Persist the dev token from ?dev=<token> into sessionStorage so apiFetch
    // can include it as X-Dev-Token on every request. sessionStorage scope is
    // intentional: the token clears when the tab closes, matching the CLAUDE.md
    // spec that says it is stored in sessionStorage, not localStorage.
    try {
      const params = new URLSearchParams(window.location.search)
      const devParam = params.get('dev')
      if (devParam) {
        sessionStorage.setItem('ragscope_dev_token', devParam)
      }
    } catch {
      // sessionStorage unavailable (private mode) -- dev access simply won't work
    }

    try {
      const dismissed = localStorage.getItem(DISMISS_KEY) === 'true'
      if (!dismissed) setShowTierModal(true)
    } catch {
      setShowTierModal(true)
    }
  }, [])

  const STEP_COMPONENTS: Record<StepNumber, React.ReactNode> = {
    1: <Step1Upload />,
    2: <Step2Configure />,
    3: <Step3Results />,
    4: <Step4Chat />,
  }

  return (
    <div
      className="min-h-screen flex flex-col pt-16"
      style={{ background: 'var(--color-bg)' }}
    >
      <Nav />

      <div
        className="sticky z-40 border-b"
        style={{
          top: '64px',
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <StepIndicator
          current={state.currentStep}
          onNavigate={step => setStep(step)}
        />
      </div>

      <main
        className="flex-1 pt-8 pb-16 px-8 xl:px-12 2xl:px-16 max-w-[1400px] mx-auto w-full"
        aria-label="Benchmark workspace"
      >
        {/*
         * AnimatePresence mode="wait" -- the exiting step fully fades out
         * before the entering step appears, preventing two steps from being
         * visible simultaneously during the transition.
         * The `key` is the step number so React knows when to swap.
         */}
        <AnimatePresence mode="wait">
          <motion.div
            key={state.currentStep}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <ErrorBoundary>
              {STEP_COMPONENTS[state.currentStep]}
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      <TierModal
        isOpen={showTierModal}
        onClose={() => setShowTierModal(false)}
      />
    </div>
  )
}

export default function AppPage() {
  return (
    <AppContextProvider>
      <AppShellInner />
    </AppContextProvider>
  )
}
