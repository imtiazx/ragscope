'use client'

/**
 * Landing page -- the public face of RAGScope.
 *
 * Sections:
 *   Nav        global navigation bar
 *   Hero       full-viewport, particle background, wordmark, CTA
 *   Why        three-point value proposition
 *   Features   three feature cards
 *   Enter CTA  secondary call to action before the footer
 *   Footer     attribution and external links
 *
 * No stock imagery, no emoji. Typography and spacing carry the design.
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowRight, BarChart2, FlaskConical, Layers } from 'lucide-react'
import Nav from '@/components/Nav'
import SnowflakeBackground from '@/components/SnowflakeBackground'
import TierSelectionModal from '@/components/TierSelectionModal'
import { useUI } from '@/context/UIContext'

/** Shared variants for scroll-triggered reveals on every section below the hero. */
const revealVariants = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0 },
}
const revealTransition = { duration: 0.5, ease: 'easeOut' as const }

// ---- Value proposition data -----------------------------------------------

const WHY_ITEMS = [
  {
    number: '01',
    title: 'Three metrics that tell the full story',
    body: 'Faithfulness measures whether the answer is grounded in your documents. Context utilization measures whether the retrieved chunks were relevant. Answer relevancy measures whether the answer addressed the question. Most RAG evaluations ignore at least one of these. RAGScope scores all three.',
  },
  {
    number: '02',
    title: 'Four retrieval strategies, one benchmark run',
    body: 'Naive RAG, HyDE, Multi-Query, and Hybrid BM25+Dense. Combine any of them with contextual compression as an optional post-retrieval step. Run against the same question on the same corpus. See the ranked result. Know which approach fits your data before writing a line of production code.',
  },
  {
    number: '03',
    title: 'Bring your own key for unlimited runs',
    body: 'Guest access covers 12 strategy runs per day using the shared API key. Paste your own OpenAI or Anthropic key to remove all limits. Your key is read directly from the browser and never forwarded to the backend.',
  },
]

// ---- Feature card data ------------------------------------------------------

const FEATURES = [
  {
    Icon: BarChart2,
    title: 'Benchmark 4 strategies head to head',
    body: 'Upload a corpus, ask a question, and receive a ranked comparison across four retrieval approaches. Radar charts, latency bars, and a sortable comparison table give you the full picture at a glance.',
  },
  {
    Icon: FlaskConical,
    title: 'Ground truth metrics with RAGAS',
    body: 'Every run is evaluated by RAGAS, an open-source framework that uses GPT-4o-mini as an impartial judge. Scores are reproducible, explainable, and aligned with real retrieval quality, not proxy metrics.',
  },
  {
    Icon: Layers,
    title: 'Modular and extensible by design',
    body: 'Every component follows a registry pattern. Add a new retrieval strategy, chunker, or LLM provider with a single file. No other code changes required. The API and UI discover it automatically.',
  },
]

// ---- Page ------------------------------------------------------------------

export default function LandingPage() {
  /*
   * Controls the tier-selection overlay shown when the user clicks any
   * "Enter App" CTA on this page. We do not navigate to /app directly any
   * more: the user picks Guest, BYOK, or Developer first and the modal
   * routes them appropriately.
   */
  const [tierOpen, setTierOpen] = useState(false)
  const { openBYOKDrawer } = useUI()

  // When the user picks BYOK inside the modal, close the modal and slide
  // open the global drawer. The drawer's Back button re-opens the modal so
  // the user can change their mind without committing to a key.
  const handleSelectByok = () => {
    setTierOpen(false)
    openBYOKDrawer({ onBack: () => setTierOpen(true) })
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/*
       * Shooting stars canvas -- fixed so it covers the entire page scroll
       * including all sections below the hero fold.
       */}
      <SnowflakeBackground />

      {/*
       * CSS grid overlay -- sits above the canvas, below all content.
       * .bg-grid-light/.bg-grid-dark defined in globals.css because CSS custom
       * properties cannot be used inside background-image gradient alpha values.
       */}
      <div
        id="page-grid-overlay"
        className="fixed inset-0 pointer-events-none bg-grid"
        style={{ zIndex: 1 }}
        aria-hidden="true"
      />

      <Nav />

      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="relative flex flex-col items-center justify-center min-h-screen px-6 pt-16 overflow-hidden"
        aria-label="Hero"
        style={{ zIndex: 2 }}
      >
        {/* Radial accent glow from centre */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.05) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />

        {/* Hero content */}
        <div className="relative z-10 flex flex-col items-center text-center max-w-4xl mx-auto">
          {/* Eyebrow */}
          <span
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold tracking-widest uppercase mb-8"
            style={{
              background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)',
              border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)',
              color: 'var(--color-accent)',
            }}
          >
            Open source RAG benchmarking
          </span>

          {/* Wordmark */}
          <h1
            className="text-[clamp(3.5rem,10vw,8rem)] font-black tracking-tight leading-none mb-6"
            style={{
              background:
                'linear-gradient(135deg, var(--color-text-primary) 40%, var(--color-accent) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            RAGScope
          </h1>

          {/* Tagline */}
          <p
            className="text-[clamp(1.1rem,2.5vw,1.5rem)] font-medium mb-4 tracking-tight"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Ground truth for your retrieval pipeline
          </p>

          {/* Supporting copy */}
          <p
            className="max-w-xl text-base leading-relaxed mb-12"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Upload a corpus, run four retrieval strategies, and see ranked scores
            for faithfulness, context utilization, and answer relevancy. Know what
            works on your data before shipping.
          </p>

          {/* Primary CTA */}
          <button
            type="button"
            onClick={() => setTierOpen(true)}
            className="inline-flex items-center gap-3 px-8 py-4 rounded-xl font-semibold text-base animate-glow-pulse transition-transform hover:scale-[1.03] active:scale-[0.98]"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-text)' }}
            aria-label="Open the RAGScope application"
          >
            Enter App
            <ArrowRight size={18} aria-hidden="true" />
          </button>

          {/* Subtle secondary note */}
          <p
            className="mt-5 text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            12 strategy runs per day - no account required.
          </p>
        </div>

        {/* Fade to surface at the bottom of the hero */}
        <div
          className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
          style={{
            background:
              'linear-gradient(to bottom, transparent, var(--color-bg))',
          }}
          aria-hidden="true"
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Why RAGScope                                                        */}
      {/* ------------------------------------------------------------------ */}
      <motion.section
        className="py-28 px-8 xl:px-12 2xl:px-16 max-w-[1400px] mx-auto w-full relative"
        style={{ zIndex: 2, background: 'var(--color-bg)' }}
        aria-label="Why RAGScope"
        variants={revealVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
        transition={revealTransition}
      >
        <div className="mb-16 max-w-xl">
          <p
            className="text-xs font-semibold tracking-widest uppercase mb-4"
            style={{ color: 'var(--color-accent)' }}
          >
            Why it matters
          </p>
          <h2
            className="text-[clamp(1.75rem,3vw,2.5rem)] font-bold tracking-tight leading-tight"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Stop guessing which retrieval strategy fits your corpus
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {WHY_ITEMS.map(({ number, title, body }) => (
            <div key={number} className="flex flex-col gap-4">
              <span
                className="text-4xl font-black leading-none"
                style={{ color: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.2)' }}
                aria-hidden="true"
              >
                {number}
              </span>
              <h3
                className="text-base font-semibold leading-snug"
                style={{ color: 'var(--color-text-primary)' }}
              >
                {title}
              </h3>
              <p
                className="text-sm leading-relaxed"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {body}
              </p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* ------------------------------------------------------------------ */}
      {/* Features                                                            */}
      {/* ------------------------------------------------------------------ */}
      <motion.section
        className="py-20 px-8 xl:px-12 2xl:px-16 max-w-[1400px] mx-auto w-full relative"
        aria-label="Features"
        style={{ zIndex: 2, background: 'var(--color-bg)' }}
        variants={revealVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
        transition={{ ...revealTransition, delay: 0.08 }}
      >
        <p
          className="text-xs font-semibold tracking-widest uppercase mb-4"
          style={{ color: 'var(--color-accent)' }}
        >
          What you get
        </p>
        <h2
          className="text-[clamp(1.75rem,3vw,2.5rem)] font-bold tracking-tight leading-tight mb-14 max-w-xl"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Everything you need for serious RAG evaluation
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 xl:gap-8">
          {FEATURES.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="card flex flex-col gap-5 hover:border-accent/30 transition-colors duration-200"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{
                  background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)',
                  border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15)',
                }}
                aria-hidden="true"
              >
                <Icon size={20} style={{ color: 'var(--color-accent)' }} />
              </div>
              <h3
                className="text-base font-semibold leading-snug"
                style={{ color: 'var(--color-text-primary)' }}
              >
                {title}
              </h3>
              <p
                className="text-sm leading-relaxed flex-1"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {body}
              </p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* ------------------------------------------------------------------ */}
      {/* Secondary CTA                                                       */}
      {/* ------------------------------------------------------------------ */}
      <motion.section
        className="py-28 px-6 flex flex-col items-center text-center relative"
        aria-label="Call to action"
        style={{ zIndex: 2, background: 'var(--color-bg)' }}
        variants={revealVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.2 }}
        transition={{ ...revealTransition, delay: 0.1 }}
      >
        <div
          className="max-w-2xl w-full rounded-2xl px-8 py-16 relative overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
          }}
        >
          {/* Subtle radial glow behind the CTA card */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse 70% 50% at 50% 100%, rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.06) 0%, transparent 70%)',
            }}
            aria-hidden="true"
          />

          <div className="relative z-10">
            <h2
              className="text-[clamp(1.5rem,3vw,2rem)] font-bold tracking-tight mb-4"
              style={{ color: 'var(--color-text-primary)' }}
            >
              Ready to measure what actually matters?
            </h2>
            <p
              className="text-sm leading-relaxed mb-10 max-w-md mx-auto"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Start with your own corpus and question. Results in under a minute.
              No account required.
            </p>
            <button
              type="button"
              onClick={() => setTierOpen(true)}
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl font-semibold text-base transition-transform hover:scale-[1.03] active:scale-[0.98]"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-text)' }}
              aria-label="Open the RAGScope application"
            >
              Run your first benchmark
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      </motion.section>

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                              */}
      {/* ------------------------------------------------------------------ */}
      <footer
        className="border-t py-10 px-6 relative"
        style={{ borderColor: 'var(--color-border)', zIndex: 2, background: 'var(--color-bg)' }}
        aria-label="Site footer"
      >
        <div className="max-w-[1400px] mx-auto px-8 xl:px-12 2xl:px-16 w-full flex flex-col sm:flex-row items-center justify-between gap-4">
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <span>Built by</span>
            <a
              href="https://imtiazx.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold transition-colors hover:text-accent"
              style={{ color: 'var(--color-text-primary)' }}
            >
              ImtiazX
            </a>
          </div>

          <nav
            className="flex items-center gap-6 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
            aria-label="Footer navigation"
          >
            <a
              href="https://github.com/imtiazx/ragscope"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://hashnode.com/@imtiazx"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent transition-colors"
            >
              Hashnode
            </a>
            <Link
              href="/docs"
              className="hover:text-accent transition-colors"
            >
              Docs
            </Link>
          </nav>
        </div>
      </footer>

      {/* Tier-selection overlay. Always mounted so AnimatePresence can play
          the exit animation when the user dismisses it. */}
      <TierSelectionModal
        isOpen={tierOpen}
        onClose={() => setTierOpen(false)}
        onSelectByok={handleSelectByok}
      />
    </div>
  )
}
