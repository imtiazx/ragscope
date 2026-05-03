'use client'

/**
 * Documentation page -- structured reference for RAGScope.
 *
 * Left sidebar with section navigation uses IntersectionObserver to keep
 * the active link in sync with the reader's scroll position. Content sections
 * are plain prose, a CSS-only flow diagram, and a strategy comparison table.
 * No external diagram library is used.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Nav from '@/components/Nav'
import {
  Play,
  ExternalLink,
  ChevronRight,
  Upload,
  Scissors,
  Database,
  Search,
  Zap,
  BarChart2,
  MessageSquare,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Sidebar sections
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'what-is',     label: 'What is RAGScope'          },
  { id: 'how-it-works',label: 'How it works'              },
  { id: 'strategies',  label: 'The five strategies'       },
  { id: 'metrics',     label: 'Understanding metrics'     },
  { id: 'tiers',       label: 'Access tiers'              },
  { id: 'faq',         label: 'FAQ'                       },
]

// ---------------------------------------------------------------------------
// Flow diagram data
// ---------------------------------------------------------------------------

const INGEST_STEPS = [
  { Icon: Upload,   label: 'Upload',   sub: 'PDF or TXT'         },
  { Icon: Scissors, label: 'Chunk',    sub: 'Split text'         },
  { Icon: Zap,      label: 'Embed',    sub: 'text-embedding-3-small' },
  { Icon: Database, label: 'Store',    sub: 'pgvector index'     },
]

const BENCHMARK_STEPS = [
  { Icon: MessageSquare, label: 'Question', sub: 'User query'         },
  { Icon: Search,        label: 'Retrieve', sub: 'Top-k chunks'       },
  { Icon: Zap,           label: 'Generate', sub: 'GPT-4o-mini answer' },
  { Icon: BarChart2,     label: 'Evaluate', sub: 'RAGAS metrics'      },
]

function FlowDiagram({
  steps,
  label,
}: {
  steps: typeof INGEST_STEPS
  label: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-secondary)' }}>
        {label}
      </p>
      <div
        className="rounded-xl p-5 overflow-x-auto"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center gap-1 min-w-max">
          {steps.map((step, i) => (
            <div key={step.label} className="flex items-center gap-1">
              <div className="flex flex-col items-center gap-2 px-4 py-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ background: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)', border: '1px solid rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15)' }}
                >
                  <step.Icon size={17} style={{ color: 'var(--color-accent)' }} aria-hidden="true" />
                </div>
                <div className="text-center">
                  <p className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                    {step.label}
                  </p>
                  <p className="text-[10px]" style={{ color: 'var(--color-text-secondary)' }}>
                    {step.sub}
                  </p>
                </div>
              </div>
              {i < steps.length - 1 && (
                <ChevronRight
                  size={16}
                  style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section heading helper
// ---------------------------------------------------------------------------

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      data-section
      className="text-2xl font-bold tracking-tight scroll-mt-24 mb-5"
      style={{ color: 'var(--color-text-primary)' }}
    >
      {children}
    </h2>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-base font-semibold mt-8 mb-3" style={{ color: 'var(--color-text-primary)' }}>
      {children}
    </h3>
  )
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--color-text-secondary)' }}>
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Strategy cards
// ---------------------------------------------------------------------------

const STRATEGIES = [
  {
    name:       'Naive RAG',
    badge:      'Baseline',
    badgeColor: 'rgba(136,136,170,0.2)',
    when:       'Default starting point. Use when query vocabulary closely matches document vocabulary.',
    avoid:      'Queries phrased differently from the documents they target.',
    llmCalls:   '1 (embed)',
    latency:    'Fast',
  },
  {
    name:       'HyDE',
    badge:      'Hypothesis-driven',
    badgeColor: 'rgba(147,51,234,0.18)',
    when:       'Questions where the query phrasing is very different from how the answer is written in the corpus.',
    avoid:      'Factual lookups where the query uses the same terms as the document.',
    llmCalls:   '2 (complete + embed)',
    latency:    'Moderate',
  },
  {
    name:       'Multi-Query',
    badge:      'Multi-perspective',
    badgeColor: 'rgba(249,115,22,0.18)',
    when:       'Ambiguous questions or when you suspect the user may phrase the question differently from the corpus.',
    avoid:      'High-latency budgets where extra LLM calls are not acceptable.',
    llmCalls:   '1 complete + N embeds',
    latency:    'Moderate',
  },
  {
    name:       'Hybrid BM25 + Dense',
    badge:      'Hybrid',
    badgeColor: 'rgba(34,197,94,0.18)',
    when:       'Technical corpora with precise identifiers, product names, codes, or rare terms that semantic search alone misses.',
    avoid:      'Purely narrative or conversational corpora with no domain-specific keywords.',
    llmCalls:   '1 (embed)',
    latency:    'Fast to Moderate',
  },
  {
    name:       'Contextual Compression',
    badge:      'Post-processor',
    badgeColor: 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.15)',
    when:       'Corpus chunks are long and contain many irrelevant sentences alongside the relevant ones.',
    avoid:      'Short chunks or when every part of a chunk is relevant to the question.',
    llmCalls:   '1 per chunk (complete)',
    latency:    'Slow (scales with k)',
  },
]

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

const FAQ = [
  {
    q: 'How does RAGScope differ from a standalone RAGAS evaluation script?',
    a: 'RAGScope is a comparative harness, not just a scorer. You run multiple strategies against the same question and corpus in one session and see the ranked result. A standalone RAGAS script gives you a score for one pipeline run. RAGScope gives you the number for all five and a visual comparison.',
  },
  {
    q: 'Does RAGScope store my uploaded documents?',
    a: 'Yes. Document chunks and their embeddings are stored in a Postgres database with the pgvector extension. They are keyed by a SHA-256 hash of the original file bytes. Uploading the same files twice returns the cached corpus without re-processing.',
  },
  {
    q: 'What API key is used for guest evaluation runs?',
    a: 'Guest runs use a shared OpenAI API key provisioned for the RAGScope service. The key is never exposed to the browser. Guest users are limited to 3 benchmark runs per day to protect the shared quota.',
  },
  {
    q: 'Can I add a new retrieval strategy without changing the backend?',
    a: 'Yes. Create a class in backend/retrieval/ that extends BaseRetriever, implement the retrieve() method, and decorate with @register. The API and frontend discover it automatically via the registry. No other files need to change.',
  },
  {
    q: 'How accurate are the RAGAS scores?',
    a: 'RAGAS uses GPT-4o-mini as an LLM judge. LLM-as-judge evaluations correlate well with human judgement on average but have variance on individual items. Treat scores as directional signals across strategies, not as absolute ground truth. Consistent differences of more than 0.1 between strategies are meaningful; differences smaller than that may be noise.',
  },
  {
    q: 'Is BYOK key usage logged anywhere?',
    a: 'No. BYOK keys are stored exclusively in your browser localStorage and used directly in API calls made from your browser. The RAGScope backend never receives or logs your key. You can verify this by inspecting the network tab in your browser developer tools.',
  },
]

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('what-is')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        // The first entry that is intersecting from the top becomes active
        const intersecting = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (intersecting.length > 0) {
          setActiveSection(intersecting[0].target.id)
        }
      },
      { rootMargin: '-80px 0px -65% 0px', threshold: 0 }
    )

    const sections = contentRef.current?.querySelectorAll('[data-section]')
    sections?.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      <Nav />

      <div className="max-w-[1400px] mx-auto w-full px-8 xl:px-12 2xl:px-16 pt-24 pb-20 flex gap-12 xl:gap-20">

        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}
        <aside
          className="hidden md:flex flex-col gap-1 w-52 xl:w-60 flex-shrink-0 sticky self-start"
          style={{ top: '88px' }}
          aria-label="Documentation navigation"
        >
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2 px-3"
            style={{ color: 'var(--color-text-secondary)' }}>
            Contents
          </p>
          <nav role="navigation" aria-label="Sections">
            {SECTIONS.map(s => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150"
                style={{
                  background: activeSection === s.id ? 'rgba(var(--color-accent-r),var(--color-accent-g),var(--color-accent-b),0.08)' : 'transparent',
                  color: activeSection === s.id ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  borderLeft: activeSection === s.id ? '2px solid var(--color-accent)' : '2px solid transparent',
                }}
                aria-current={activeSection === s.id ? 'true' : undefined}
              >
                {s.label}
              </a>
            ))}
          </nav>

          {/* External links */}
          <div className="mt-8 flex flex-col gap-2 px-3">
            <a
              href="https://github.com/imtiazx/ragscope"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <ExternalLink size={11} aria-hidden="true" />
              GitHub repo
            </a>
            <a
              href="https://hashnode.com/@imtiazx"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <ExternalLink size={11} aria-hidden="true" />
              Hashnode blog
            </a>
          </div>
        </aside>

        {/* ---------------------------------------------------------------- */}
        {/* Content                                                          */}
        {/* ---------------------------------------------------------------- */}
        <main
          ref={contentRef}
          className="flex-1 min-w-0"
          aria-label="Documentation content"
        >

          {/* YouTube card */}
          <div
            className="rounded-2xl overflow-hidden mb-14 relative"
            style={{ background: '#0F0F0F', border: '1px solid var(--color-border)', aspectRatio: '16/6' }}
            aria-label="Tutorial video placeholder"
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                <Play size={22} style={{ color: 'rgba(255,255,255,0.7)', marginLeft: '3px' }} aria-hidden="true" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.7)' }}>
                  Tutorial coming soon
                </p>
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  A walkthrough of the full benchmark workflow
                </p>
              </div>
            </div>
          </div>

          {/* ---- Section: What is RAGScope ---- */}
          <section className="mb-16" aria-labelledby="what-is">
            <SectionHeading id="what-is">What is RAGScope</SectionHeading>
            <Prose>
              RAGScope is a benchmarking harness for Retrieval-Augmented Generation pipelines.
              Its purpose is measurement: you upload a document corpus, ask a question, run
              five retrieval strategies, and see which one produces the most faithful and
              relevant answer on your specific data.
            </Prose>
            <Prose>
              Most RAG systems are evaluated qualitatively ("it seems to work") or with
              proxy metrics that do not capture the full picture. RAGScope uses RAGAS, an
              open-source evaluation framework that applies an LLM judge (GPT-4o-mini) to
              score three properties simultaneously: whether the answer is grounded in the
              retrieved context, whether the retrieved context was relevant, and whether the
              answer addressed the question.
            </Prose>
            <Prose>
              RAGScope is not a production RAG system. It is a measurement instrument. You
              use it to answer "which strategy should I use for this corpus?" before committing
              to an architecture.
            </Prose>
          </section>

          {/* ---- Section: How it works ---- */}
          <section className="mb-16" aria-labelledby="how-it-works">
            <SectionHeading id="how-it-works">How it works</SectionHeading>
            <Prose>
              RAGScope has two phases. The ingest phase processes your documents once. The
              benchmark phase runs your question through a retrieval strategy and evaluates
              the result.
            </Prose>

            <div className="flex flex-col gap-5 my-8">
              <FlowDiagram steps={INGEST_STEPS} label="Phase 1 -- Ingest" />
              <FlowDiagram steps={BENCHMARK_STEPS} label="Phase 2 -- Benchmark" />
            </div>

            <SubHeading>Ingest phase</SubHeading>
            <Prose>
              Your uploaded files are passed to the appropriate ingestor (PDF or plain text),
              which extracts raw text. The text is split into chunks by the chunker strategy
              you choose. Each chunk is embedded using OpenAI text-embedding-3-small and stored
              in a pgvector index alongside the original text. This happens once per corpus.
              Re-uploading the same files returns the cached result immediately.
            </Prose>

            <SubHeading>Benchmark phase</SubHeading>
            <Prose>
              You submit a question and select a retrieval strategy. The strategy searches the
              pgvector index for the most relevant chunks. Those chunks are passed to GPT-4o-mini
              which generates an answer constrained to the retrieved context. RAGAS then evaluates
              the question, answer, and context together and produces three scores. The entire
              process runs as a FastAPI background task so the HTTP response returns immediately
              with a run ID that you poll until results are ready.
            </Prose>
          </section>

          {/* ---- Section: Strategies ---- */}
          <section className="mb-16" aria-labelledby="strategies">
            <SectionHeading id="strategies">The five strategies</SectionHeading>
            <Prose>
              RAGScope benchmarks four retrieval methods and one post-retrieval processor.
              The methods differ in how they find chunks. The processor changes what happens
              to chunks after they are found. The processor can be combined with any of the
              four methods.
            </Prose>

            <div className="flex flex-col gap-5 mt-8">
              {STRATEGIES.map(s => (
                <div
                  key={s.name}
                  className="rounded-xl p-5"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>
                      {s.name}
                    </h3>
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: s.badgeColor, color: 'var(--color-text-secondary)' }}
                    >
                      {s.badge}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
                        Use when
                      </p>
                      <p style={{ color: 'var(--color-text-secondary)' }}>{s.when}</p>
                    </div>
                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
                        Avoid when
                      </p>
                      <p style={{ color: 'var(--color-text-secondary)' }}>{s.avoid}</p>
                    </div>
                  </div>

                  <div className="flex gap-6 mt-4 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    <span>
                      <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>LLM calls: </span>
                      {s.llmCalls}
                    </span>
                    <span>
                      <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>Latency: </span>
                      {s.latency}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ---- Section: Metrics ---- */}
          <section className="mb-16" aria-labelledby="metrics">
            <SectionHeading id="metrics">Understanding metrics</SectionHeading>
            <Prose>
              All three metrics are scored by an LLM judge (GPT-4o-mini) and return a value
              between 0.0 and 1.0. Higher is better for all three. Scores should be interpreted
              comparatively across strategies rather than as absolute quality thresholds.
            </Prose>

            {[
              {
                name: 'Faithfulness',
                definition:
                  'For each claim in the generated answer, RAGAS asks the LLM judge whether it is supported by the retrieved chunks. Faithfulness is the fraction of claims that are supported. A score of 1.0 means the answer contains no statements that go beyond what the retrieved context says.',
                lowScore:
                  'The model is hallucinating. It is making claims not supported by the retrieved documents. This is the most dangerous failure mode in production RAG.',
                highScore:
                  'Every statement in the answer is traceable to the retrieved context. The retrieval strategy is doing its job.',
              },
              {
                name: 'Context Precision',
                definition:
                  'Measures how much of the retrieved context was actually useful for generating the correct answer. If you retrieved 5 chunks but only 1 was relevant, context precision is low. If all 5 were relevant, it is high.',
                lowScore:
                  'The retriever is returning a lot of noisy, irrelevant content alongside the useful material. The LLM has to read more to find the signal.',
                highScore:
                  'The retriever is precise. Almost everything returned was needed to answer the question.',
              },
              {
                name: 'Answer Relevancy',
                definition:
                  'Measures whether the answer addresses the question that was actually asked. RAGAS generates several questions from the answer and checks whether they resemble the original question. An answer that is factually correct but off-topic scores low.',
                lowScore:
                  'The answer contains accurate information but does not directly address the question. The model may have retrieved good context but misread the intent.',
                highScore:
                  'The answer is on-topic and directly responds to what was asked.',
              },
            ].map(m => (
              <div key={m.name} className="mb-8">
                <SubHeading>{m.name}</SubHeading>
                <Prose>{m.definition}</Prose>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div
                    className="rounded-lg p-4 text-xs"
                    style={{ background: 'rgba(255,107,107,0.06)', border: '1px solid rgba(255,107,107,0.15)' }}
                  >
                    <p className="font-semibold mb-1.5" style={{ color: '#FF6B6B' }}>Low score means</p>
                    <p style={{ color: 'var(--color-text-secondary)' }}>{m.lowScore}</p>
                  </div>
                  <div
                    className="rounded-lg p-4 text-xs"
                    style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)' }}
                  >
                    <p className="font-semibold mb-1.5" style={{ color: '#4ADE80' }}>High score means</p>
                    <p style={{ color: 'var(--color-text-secondary)' }}>{m.highScore}</p>
                  </div>
                </div>
              </div>
            ))}
          </section>

          {/* ---- Section: Tiers ---- */}
          <section className="mb-16" aria-labelledby="tiers">
            <SectionHeading id="tiers">Access tiers</SectionHeading>
            <Prose>
              RAGScope has three access levels. All tiers can run benchmarks and compare
              results. The tiers differ in how many runs you can make and where the LLM
              calls come from.
            </Prose>

            {[
              {
                label: 'Tier 1 -- Guest',
                active: true,
                items: [
                  '3 benchmark runs per day, reset at midnight UTC',
                  '3 chat questions per benchmark session',
                  '10 MB combined corpus upload limit',
                  'Uses the RAGScope shared OpenAI API key',
                  'No account or API key required',
                ],
                note: 'The daily limit protects the shared API key quota. It resets every midnight UTC regardless of your local timezone.',
              },
              {
                label: 'Tier 2 -- BYOK',
                active: false,
                items: [
                  'Unlimited benchmark runs',
                  'Unlimited chat questions',
                  'Full corpus size (limited only by the embedding model context window)',
                  'LangSmith trace export enabled',
                  'Your API key stays in browser localStorage and is never sent to RAGScope servers',
                  'Compatible with OpenAI and Anthropic keys',
                ],
                note: 'To activate BYOK, click the settings icon in the top navigation bar and paste your API key. You can remove it at any time.',
              },
              {
                label: 'Tier 0 -- Developer',
                active: false,
                items: [
                  'Unlimited runs with no rate limiting',
                  'Uses a hashed token in the X-Dev-Token request header',
                  'Bypasses all daily limits at the backend level',
                  'Intended for contributors and the project maintainer',
                ],
                note: 'Developer access is by invitation. Contact ImtiazX on LinkedIn to request a token.',
              },
            ].map(tier => (
              <div key={tier.label} className="mb-6">
                <SubHeading>{tier.label}</SubHeading>
                <ul className="flex flex-col gap-1.5 mb-3">
                  {tier.items.map(item => (
                    <li key={item} className="flex items-start gap-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                      <span className="mt-0.5 text-[8px]" style={{ color: 'var(--color-accent)' }} aria-hidden="true">●</span>
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="text-xs italic" style={{ color: 'var(--color-text-secondary)' }}>
                  {tier.note}
                </p>
              </div>
            ))}
          </section>

          {/* ---- Section: FAQ ---- */}
          <section className="mb-16" aria-labelledby="faq">
            <SectionHeading id="faq">FAQ</SectionHeading>
            <div className="flex flex-col gap-6">
              {FAQ.map(({ q, a }) => (
                <div key={q}>
                  <p className="text-sm font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>
                    {q}
                  </p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    {a}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Footer links */}
          <div
            className="flex flex-wrap gap-6 pt-8 mt-8 text-sm"
            style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <a href="https://github.com/imtiazx/ragscope" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-accent transition-colors">
              <ExternalLink size={13} aria-hidden="true" /> GitHub repo
            </a>
            <a href="https://hashnode.com/@imtiazx" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-accent transition-colors">
              <ExternalLink size={13} aria-hidden="true" /> Hashnode blog
            </a>
            <Link href="/app" className="flex items-center gap-1.5 hover:text-accent transition-colors">
              Open app
            </Link>
          </div>

        </main>
      </div>
    </div>
  )
}
