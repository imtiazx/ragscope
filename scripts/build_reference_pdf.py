"""
Builds docs/RAGScope_Reference.pdf - a long-form reference document covering
every part of the project. Designed to teach a new contributor (or an
interviewer's interviewee) the system end to end.

Run:  .venv/bin/python scripts/build_reference_pdf.py

The script is deliberately self-contained: no helper modules, no external
content files. All section copy is inlined so a single command rebuilds
the PDF.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)

# ---------------------------------------------------------------------------
# Output path
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "docs" / "RAGScope_Reference.pdf"

# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------

base_styles = getSampleStyleSheet()

PRIMARY = colors.HexColor("#0F766E")        # teal
DARK = colors.HexColor("#0F172A")           # near-black
MUTED = colors.HexColor("#475569")          # slate
BORDER = colors.HexColor("#CBD5E1")         # light slate
BG_CODE = colors.HexColor("#F1F5F9")        # very light slate
BG_NOTE = colors.HexColor("#ECFEFF")        # cyan-50

styles = {
    "Title": ParagraphStyle(
        "TitleStyle", parent=base_styles["Title"],
        fontName="Helvetica-Bold", fontSize=30, leading=36,
        textColor=DARK, spaceAfter=12, alignment=TA_LEFT,
    ),
    "Subtitle": ParagraphStyle(
        "SubtitleStyle", parent=base_styles["Title"],
        fontName="Helvetica", fontSize=14, leading=18,
        textColor=MUTED, spaceAfter=6, alignment=TA_LEFT,
    ),
    "Meta": ParagraphStyle(
        "MetaStyle", parent=base_styles["BodyText"],
        fontName="Helvetica", fontSize=9, leading=12,
        textColor=MUTED, spaceAfter=0, alignment=TA_LEFT,
    ),
    "H1": ParagraphStyle(
        "H1Style", parent=base_styles["Heading1"],
        fontName="Helvetica-Bold", fontSize=20, leading=24,
        textColor=PRIMARY, spaceBefore=16, spaceAfter=10,
    ),
    "H2": ParagraphStyle(
        "H2Style", parent=base_styles["Heading2"],
        fontName="Helvetica-Bold", fontSize=14, leading=18,
        textColor=DARK, spaceBefore=12, spaceAfter=6,
    ),
    "H3": ParagraphStyle(
        "H3Style", parent=base_styles["Heading3"],
        fontName="Helvetica-Bold", fontSize=11, leading=14,
        textColor=DARK, spaceBefore=8, spaceAfter=4,
    ),
    "Body": ParagraphStyle(
        "BodyStyle", parent=base_styles["BodyText"],
        fontName="Helvetica", fontSize=10, leading=14,
        textColor=DARK, spaceAfter=6, alignment=TA_LEFT,
    ),
    "Bullet": ParagraphStyle(
        "BulletStyle", parent=base_styles["BodyText"],
        fontName="Helvetica", fontSize=10, leading=14,
        textColor=DARK, leftIndent=14, bulletIndent=4, spaceAfter=3,
    ),
    "Code": ParagraphStyle(
        "CodeStyle", parent=base_styles["Code"],
        fontName="Courier", fontSize=8.5, leading=11,
        textColor=DARK, backColor=BG_CODE, borderPadding=6,
        leftIndent=4, rightIndent=4, spaceAfter=10,
    ),
    "Note": ParagraphStyle(
        "NoteStyle", parent=base_styles["BodyText"],
        fontName="Helvetica-Oblique", fontSize=10, leading=14,
        textColor=DARK, backColor=BG_NOTE, borderPadding=8,
        leftIndent=4, rightIndent=4, spaceBefore=4, spaceAfter=10,
    ),
}


# ---------------------------------------------------------------------------
# Page template (header + footer + page numbers)
# ---------------------------------------------------------------------------

class RagscopeDoc(BaseDocTemplate):
    """Document with running header, footer, and automatic page numbers."""

    def __init__(self, filename, **kwargs):
        super().__init__(
            filename,
            pagesize=LETTER,
            leftMargin=0.85 * inch,
            rightMargin=0.85 * inch,
            topMargin=0.85 * inch,
            bottomMargin=0.85 * inch,
            title="RAGScope - Reference",
            author="ImtiazX",
            **kwargs,
        )
        frame = Frame(
            self.leftMargin, self.bottomMargin,
            self.width, self.height,
            id="normal",
        )
        template = PageTemplate(id="main", frames=frame, onPage=self._draw_chrome)
        self.addPageTemplates([template])

    def _draw_chrome(self, canvas, doc):
        """Header bar, divider, footer page number, and footer brand text."""
        canvas.saveState()

        # Header bar
        canvas.setFillColor(PRIMARY)
        canvas.rect(0, LETTER[1] - 0.5 * inch, LETTER[0], 0.5 * inch, fill=1, stroke=0)
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 11)
        canvas.drawString(0.85 * inch, LETTER[1] - 0.32 * inch, "RAGScope")
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(
            LETTER[0] - 0.85 * inch, LETTER[1] - 0.32 * inch,
            "Reference Manual",
        )

        # Footer divider + text
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(
            0.85 * inch, 0.55 * inch,
            LETTER[0] - 0.85 * inch, 0.55 * inch,
        )
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(0.85 * inch, 0.38 * inch, "github.com/ImtiazX/ragscope")
        canvas.drawRightString(
            LETTER[0] - 0.85 * inch, 0.38 * inch,
            f"Page {canvas.getPageNumber()}",
        )

        canvas.restoreState()


# ---------------------------------------------------------------------------
# Helpers - turn lists / blocks of copy into flowables
# ---------------------------------------------------------------------------

def p(text: str, style: str = "Body") -> Paragraph:
    """Build a single Paragraph using one of the registered styles."""
    return Paragraph(text, styles[style])


def h(level: int, text: str) -> Paragraph:
    """Build a heading paragraph at the given level (1, 2, 3)."""
    return Paragraph(text, styles[f"H{level}"])


def bullets(items: list[str]) -> list:
    """Turn a list of strings into bullet paragraphs."""
    out = []
    for item in items:
        out.append(Paragraph(f"&bull;&nbsp; {item}", styles["Bullet"]))
    return out


def code(text: str) -> Preformatted:
    """Render a fixed-pitch code block with a soft background."""
    return Preformatted(text.rstrip("\n"), styles["Code"])


def note(text: str) -> Paragraph:
    """Render a soft callout box used for tips and pitfalls."""
    return Paragraph(text, styles["Note"])


def table_2col(rows: list[tuple[str, str]], col_widths=(1.6 * inch, 4.6 * inch)) -> Table:
    """Build a two-column reference table with header row styling."""
    data = [[Paragraph(f"<b>{r[0]}</b>", styles["Body"]),
             Paragraph(r[1], styles["Body"])] for r in rows]
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (0, -1), BG_CODE),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, BORDER),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def table_3col(header: tuple[str, str, str], rows: list[tuple[str, str, str]],
               col_widths=(1.4 * inch, 2.0 * inch, 2.8 * inch)) -> Table:
    """Build a three-column table with bolded header row."""
    data = [[Paragraph(f"<b>{c}</b>", styles["Body"]) for c in header]]
    for r in rows:
        data.append([Paragraph(c, styles["Body"]) for c in r])
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, BORDER),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


# ---------------------------------------------------------------------------
# Section builders - each returns a list of flowables
# ---------------------------------------------------------------------------

def cover_page() -> list:
    """Title page with project name, tagline, and metadata."""
    return [
        Spacer(1, 1.4 * inch),
        p("RAGScope", "Title"),
        p("A reference manual for the public RAG benchmarking harness", "Subtitle"),
        Spacer(1, 0.4 * inch),
        p(
            "This document is the single source of truth for understanding the "
            "RAGScope codebase. It walks through every layer of the system - "
            "from why the project exists, through the architecture and each "
            "individual file's role, to a free-tier troubleshooting playbook - "
            "in the order a new contributor would need to read it.",
            "Body",
        ),
        Spacer(1, 0.6 * inch),
        p(f"Author: ImtiazX", "Meta"),
        p(f"Generated: {date.today().isoformat()}", "Meta"),
        p("License: MIT", "Meta"),
        p("Repository: github.com/ImtiazX/ragscope", "Meta"),
        p("Live app: ragscope.vercel.app", "Meta"),
        PageBreak(),
    ]


def table_of_contents() -> list:
    """Static table of contents. Section numbering kept in sync with section IDs."""
    items = [
        ("1.", "Introduction", "What the project is and is not"),
        ("2.", "Background", "Why this project exists, problem statement"),
        ("3.", "Core functional features", "What the user can do, end to end"),
        ("4.", "Use cases", "Concrete scenarios the harness is built for"),
        ("5.", "Technical architecture", "High-level diagram and request flow"),
        ("6.", "Components and modules", "Backend and frontend module map"),
        ("7.", "Codebase walkthrough", "File-by-file role and responsibility"),
        ("8.", "Library reference", "Every dependency and why it is needed"),
        ("9.", "How the files connect", "Import graph and runtime call chains"),
        ("10.", "Troubleshooting playbook", "Free-tier failure modes by service"),
        ("11.", "Operational runbook", "Deploys, rotations, common chores"),
        ("12.", "Interview prep capsule", "Talking points and the design decisions"),
    ]
    out = [h(1, "Table of Contents")]
    rows = [(f"{n} {t}", desc) for n, t, desc in items]
    out.append(table_2col(rows, col_widths=(2.0 * inch, 4.2 * inch)))
    out.append(PageBreak())
    return out


def section_1_introduction() -> list:
    """Chapter 1: what the project is."""
    return [
        h(1, "1. Introduction"),

        h(2, "1.1 What RAGScope is"),
        p(
            "RAGScope is a public, web-hosted benchmarking harness for "
            "Retrieval-Augmented Generation (RAG) systems. A user uploads a "
            "document corpus (PDF or plain text), asks a question, and the "
            "harness runs the same question through up to four different "
            "retrieval strategies in parallel - then scores each result with "
            "RAGAS using <i>gpt-4o-mini</i> as the judge. The user sees "
            "exactly which strategy wins on faithfulness, context "
            "utilization, answer relevancy, and end-to-end latency for "
            "<i>their</i> data."
        ),

        h(2, "1.2 What RAGScope is not"),
        p(
            "RAGScope is not a RAG product, not a chatbot framework, not an "
            "agent system, and not a vector-database wrapper. Everything it "
            "does serves one purpose: produce trustworthy comparative "
            "measurements between retrieval strategies on a real corpus. "
            "There is no agent loop, no tool use, no streaming dialogue. The "
            "live-chat surface in Step 4 exists only so the winning strategy "
            "translates into a felt experience."
        ),

        h(2, "1.3 Audience for this manual"),
        p(
            "Written for two readers:"
        ),
        *bullets([
            "<b>A new contributor</b> who has just cloned the repository and "
            "needs to understand the codebase before opening their first PR.",
            "<b>An interviewee</b> (the original author of the project) who "
            "needs to confidently answer architecture, design-decision, and "
            "trade-off questions about every component.",
        ]),
        p(
            "Every section therefore explains <i>both</i> what something does "
            "and <i>why</i> it was built that way."
        ),

        h(2, "1.4 How to read this document"),
        *bullets([
            "Sections 1-4 are conceptual. Read once.",
            "Sections 5-9 are architectural. Skim once, then refer back as you "
            "navigate the source.",
            "Section 10 is a troubleshooting playbook. Read once before a deploy, "
            "and again whenever a free-tier service misbehaves.",
            "Section 12 is an interview-prep capsule that distils the rest into "
            "talking points.",
        ]),
        PageBreak(),
    ]


def section_2_background() -> list:
    """Chapter 2: why this exists."""
    return [
        h(1, "2. Background"),

        h(2, "2.1 The problem RAGScope solves"),
        p(
            "RAG is now the default pattern for grounding LLM answers in "
            "external knowledge. The decision every team faces is: <i>which "
            "retrieval strategy works best on our corpus?</i> Naive cosine "
            "similarity, HyDE, multi-query, hybrid BM25 + dense, contextual "
            "compression - every blog post claims its favourite is the best, "
            "but the right answer depends on the documents and questions in "
            "front of you. Picking blind is expensive: the wrong choice means "
            "either hallucinations in production or paying for unnecessary "
            "LLM calls during retrieval."
        ),
        p(
            "RAGScope makes the decision empirical. Upload the actual "
            "documents, ask the actual questions, and read the actual "
            "scores. The harness is the measuring tape that the rest of the "
            "RAG ecosystem treats as a given."
        ),

        h(2, "2.2 Design tenets"),
        *bullets([
            "<b>Measurement first.</b> Every architectural decision is judged "
            "against whether it preserves the integrity of the measurement.",
            "<b>Deterministic pipeline.</b> No agents, no tool use, no LLM "
            "loops. The eval path is a fixed sequence of steps so two runs on "
            "the same input produce comparable scores.",
            "<b>Auto-discoverable strategies.</b> A retriever, chunker, "
            "ingestor, or LLM provider plugs in by extending a base class and "
            "using a single decorator. No hardcoded strategy lists exist "
            "anywhere - the API and UI populate dynamically.",
            "<b>Honest free tier.</b> Twelve strategy runs and five chat "
            "questions per day per browser fingerprint, no signup, no email. "
            "Heavier use is unlocked by pasting your own key (which stays in "
            "the browser).",
            "<b>Public source of truth.</b> The repository, the live app, the "
            "API documentation, and this manual are all public. Nothing is "
            "hidden behind a CONFIDENTIAL.md.",
        ]),

        h(2, "2.3 Why these four retrieval strategies"),
        p(
            "The four selected strategies are not exhaustive - they are the "
            "four most-cited <i>different shapes</i> of retrieval in the RAG "
            "literature. Picking one of each shape, instead of three "
            "variations on cosine similarity, means the benchmark answers a "
            "useful question for the user: which <i>style</i> of retrieval "
            "fits my data?"
        ),
        table_3col(
            ("Shape", "Strategy", "What kind of question it answers"),
            [
                ("Baseline dense", "Naive RAG",
                 "How does pure cosine similarity do on this corpus?"),
                ("Query rewriting", "HyDE",
                 "Do my questions and my documents share vocabulary?"),
                ("Query expansion", "Multi-query",
                 "Does a single phrasing miss relevant passages?"),
                ("Sparse + dense fusion", "Hybrid BM25 + dense",
                 "Do exact keywords or names matter beyond semantics?"),
            ],
            col_widths=(1.4 * inch, 1.6 * inch, 3.2 * inch),
        ),

        h(2, "2.4 Why contextual compression is a separate axis"),
        p(
            "Compression is not a fifth retrieval strategy. It is a "
            "post-retrieval LLM filter that removes irrelevant sentences from "
            "each chunk before they reach the answerer. Architecturally it "
            "sits <i>after</i> any of the four retrievers and is "
            "combinable with all of them. Surfacing it as a separate toggle "
            "(rather than inflating the strategy count to five) keeps the "
            "experiment design clean: a user can compare HyDE vs. HyDE + "
            "compression on equal footing, which would be invisible if it "
            "were a different row in the strategy list."
        ),
        PageBreak(),
    ]


def section_3_features() -> list:
    """Chapter 3: features the user can use."""
    return [
        h(1, "3. Core functional features"),

        h(2, "3.1 Step 1 - Upload"),
        *bullets([
            "Drag-and-drop or file-picker upload of one or more PDF / TXT "
            "files (10 MB combined limit, enforced at FastAPI request and "
            "application level).",
            "Per-corpus content hash (SHA-256) so a repeat upload of the same "
            "files is detected as a duplicate and short-circuits with HTTP "
            "200 instead of re-running the pipeline.",
            "Configurable chunker (fixed-size, semantic, or hierarchical) with "
            "tunable parameters rendered dynamically from the backend "
            "<code>param_schema</code>.",
        ]),

        h(2, "3.2 Step 2 - Configure benchmark"),
        *bullets([
            "Select one or more of the four retrieval strategies. Selecting N "
            "strategies costs N runs against the daily quota.",
            "Tune retrieval parameters (top_k, num_variants for multi-query, "
            "bm25_weight for hybrid, hypothetical_doc_length for HyDE, etc.) "
            "via the dynamic parameter form.",
            "Toggle contextual compression independently of the strategy "
            "choice. Enabling it does not consume an additional run.",
            "Enter the benchmark question and submit. The browser receives "
            "N <code>run_ids</code> immediately and starts polling.",
        ]),

        h(2, "3.3 Step 3 - Results dashboard"),
        *bullets([
            "Live, streaming dashboard: results appear strategy by strategy "
            "as each background task completes, instead of waiting for the "
            "slowest one.",
            "Radar chart with three axes (faithfulness, context utilization, "
            "answer relevancy) overlaid for every completed run.",
            "Latency bar chart sorted fastest to slowest, with plain-English "
            "interpretation per bar.",
            "Sortable comparison table, color-coded best/worst per metric, "
            "click-to-select per row.",
            "Score cards with count-up animation and plain-English "
            "interpretation under each metric.",
            "Animated 'Winner' badge for the highest weighted-average run, "
            "with a one-line explanation of why it won.",
            "Session-scoped history persisted in <code>localStorage</code> so "
            "the comparison view accumulates across submissions until the "
            "user clears it.",
        ]),

        h(2, "3.4 Step 4 - Live chat"),
        *bullets([
            "Conversational interface against the same corpus, defaulting to "
            "the winning strategy.",
            "Collapsible config panel to switch strategy or change "
            "parameters mid-conversation.",
            "Tier 1 counter (5 questions / day) shown next to the input. The "
            "backend is authoritative; the frontend counter is for display.",
            "Per-message metadata: strategy used, number of chunks retrieved, "
            "expanding to show the chunks themselves.",
        ]),

        h(2, "3.5 Global features"),
        *bullets([
            "Dark / light / system theme with no-flash injection script in "
            "the root <code>layout.tsx</code>.",
            "Optional ambient audio (off by default, persisted in "
            "<code>localStorage</code>).",
            "Soft click sound effects on interactive elements.",
            "BYOK settings drawer slide-in from the right.",
            "Toast notification system for async events (upload success, "
            "rate-limit hit, network error).",
            "Skeleton loading states on all API calls.",
            "Plain-English tooltips on every parameter control.",
            "Tier 0 dev bypass via <code>?dev=&lt;token&gt;</code> URL param.",
        ]),
        PageBreak(),
    ]


def section_4_usecases() -> list:
    return [
        h(1, "4. Use cases"),

        h(2, "4.1 Choosing a retrieval strategy for a new RAG project"),
        p(
            "A team starting a RAG project loads a representative sample of "
            "the production corpus (say 20-50 pages) and runs five or six "
            "questions an end user might ask. The benchmark reveals whether "
            "HyDE provides any lift on this corpus, whether BM25 picks up "
            "identifiers that dense similarity smooths over, and whether "
            "compression is worth the extra LLM cost. The decision is "
            "data-driven instead of folklore-driven."
        ),

        h(2, "4.2 Auditing an existing pipeline"),
        p(
            "A team already in production suspects retrieval is the bottleneck "
            "(low faithfulness scores, frequent hallucinations). They paste "
            "the same questions the LLM has been seeing in production and "
            "compare the production strategy (likely naive) against HyDE and "
            "hybrid on the production corpus. If faithfulness jumps from 0.6 "
            "to 0.9 with hybrid, the experiment is the business case for "
            "swapping retrievers."
        ),

        h(2, "4.3 Teaching RAG fundamentals"),
        p(
            "Instructors and bootcamps point students at RAGScope to see the "
            "<i>shape</i> of each strategy without building it. The docs page "
            "explains the math behind each metric (with LaTeX formulae). "
            "Students upload a paper, run the benchmark, see the difference "
            "between BM25 and cosine in the chart, and internalise the "
            "trade-off before writing a line of code."
        ),

        h(2, "4.4 Interview portfolio piece"),
        p(
            "The original author uses RAGScope as a portfolio project that "
            "demonstrates: production-grade FastAPI with async background "
            "tasks, vector search with pgvector, RAGAS evaluation pipelines, "
            "Next.js 14 App Router, polished UX with dynamic forms, secure "
            "BYOK that never touches the server, sane rate limiting with "
            "fingerprint hashing, three-platform deployment (Railway, "
            "Vercel, Supabase), and an extensible plugin architecture that "
            "earns its keep when new retrievers are added."
        ),

        h(2, "4.5 Reproducible research baseline"),
        p(
            "Researchers comparing new retrieval techniques against existing "
            "ones need a baseline. RAGScope ships the four most-cited "
            "strategies behind one unified eval pipeline so the only variable "
            "is the new technique. The auto-discovery pattern means a new "
            "strategy plugs in with one decorator - no surgery on the rest "
            "of the codebase."
        ),
        PageBreak(),
    ]


def section_5_architecture() -> list:
    return [
        h(1, "5. Technical architecture"),

        h(2, "5.1 System diagram"),
        code(
"""+---------------------+         +--------------------------+         +-----------------+
|  Next.js frontend   | --HTTP->|  FastAPI backend         | --SQL-->|  Supabase       |
|  (Vercel)           |         |  (Railway, Docker)       |         |  Postgres +     |
|                     |<-poll---|  /ingest /benchmark      |         |  pgvector       |
|  - 4-step UI        |         |  /results /chat          |         +-----------------+
|  - localStorage     |         |  /strategies /health     |
|    history          |         |                          |         +-----------------+
|  - BYOK direct LLM  |         |  Background eval tasks   | --HTTP->|  OpenAI API     |
|    calls (Tier 2)   |         |  (psycopg2, own loop)    |         |  embeddings +   |
+---------------------+         +--------------------------+         |  RAGAS judge    |
                                                                      +-----------------+
"""
        ),

        h(2, "5.2 Three layers, three runtimes"),
        *bullets([
            "<b>Frontend (Next.js on Vercel).</b> Renders the UI, owns "
            "browser-only state (theme, history, BYOK key), polls the "
            "backend for results, and on BYOK calls the LLM provider "
            "<i>directly</i> from the browser so the user's key never "
            "transits the backend.",
            "<b>Backend (FastAPI on Railway).</b> Stateless request handler. "
            "Talks to Postgres + pgvector for storage and to the OpenAI API "
            "for embeddings, retrieval LLM, and RAGAS judging. Schedules "
            "background tasks for the long-running RAGAS eval.",
            "<b>Database (Supabase Postgres + pgvector).</b> Single source of "
            "truth for the corpus, the benchmark runs, and the rate-limit "
            "counters. The backend creates all tables on first startup via "
            "<code>create_tables()</code>; no manual migrations.",
        ]),

        h(2, "5.3 The benchmark request flow"),
        *bullets([
            "<b>POST /ingest.</b> Multipart upload. Backend hashes the bytes "
            "(SHA-256), checks if that corpus already exists, otherwise "
            "extracts text via the ingestor registry, chunks via the chunker "
            "registry, embeds every chunk concurrently via "
            "<code>asyncio.gather</code>, and bulk-inserts into "
            "<code>corpus_chunks</code> via asyncpg <code>executemany</code>.",
            "<b>POST /benchmark.</b> Validates the corpus, validates every "
            "strategy in the request, checks the daily-run quota against the "
            "fingerprint hash, then opens one <code>benchmark_runs</code> row "
            "and schedules one background task per strategy. Returns "
            "<code>{run_ids: [...]}</code> with HTTP 202.",
            "<b>Background task.</b> Runs on a dedicated event loop in a "
            "worker thread (see Section 5.4). Loads the corpus, runs "
            "retrieval and optional compression, generates an answer with "
            "<code>gpt-4o-mini</code>, scores three RAGAS metrics one at a "
            "time, and writes the result row with status='completed'.",
            "<b>GET /results/{run_id}.</b> Polled by the frontend every ~1s. "
            "Returns the full row including status. Frontend stops polling "
            "when status is 'completed' or 'failed'.",
            "<b>POST /chat.</b> Same retrieval / compression / answer "
            "generation but without scoring. Used by Step 4 for the live "
            "conversational surface. Counts against the chat quota (5/day "
            "guest), not the run quota.",
        ]),

        h(2, "5.4 The background-task event loop pattern"),
        p(
            "The single most subtle piece of the backend. RAGAS evaluation is "
            "long-running (sometimes 30-90 seconds) so it must not block the "
            "request thread. FastAPI's BackgroundTasks dispatches non-async "
            "callables on a worker thread via anyio. That worker thread has "
            "no asyncio event loop. The sync wrapper "
            "<code>run_evaluation</code> creates a fresh event loop with "
            "<code>asyncio.DefaultEventLoopPolicy().new_event_loop()</code>, "
            "sets it as the current loop for the thread, wraps the async "
            "implementation in a Task via <code>loop.create_task()</code>, "
            "and drives it with <code>loop.run_until_complete(task)</code>."
        ),
        note(
            "<b>Why the Task wrapper matters.</b> asyncpg's connect / release "
            "code calls <code>asyncio.timeout()</code> internally. On Python "
            "3.11+, <code>asyncio.timeout()</code> calls "
            "<code>asyncio.current_task()</code> and raises "
            "<code>RuntimeError(\"Timeout should be used inside a task\")</code> "
            "if it returns None. <code>loop.run_until_complete(bare_coroutine)</code> "
            "drives the coroutine without a Task wrapper, so current_task() is "
            "None. Creating a Task first solves the problem."
        ),
        p(
            "The async implementation uses synchronous <b>psycopg2</b> for "
            "all DB calls inside the task - not asyncpg. Why: on the previous "
            "Render host (Python 3.14), asyncpg's connect path called "
            "<code>asyncio.timeout()</code> in a way that raised <i>even with "
            "the Task wrapper</i>, under any non-trivial concurrent load. "
            "psycopg2 is fully synchronous and never touches asyncio, so it "
            "cannot trip the failure mode by construction. The brief blocking "
            "of the dedicated task loop is acceptable because no other "
            "coroutine is competing for it. The current Railway deployment "
            "pins Python 3.11.9 (Dockerfile), so the original bug is dormant; "
            "psycopg2 stays as a safety net."
        ),

        h(2, "5.5 RAGAS per-metric isolation"),
        p(
            "RAGAS 0.1.21 evaluates all metrics in a single "
            "<code>evaluate()</code> call by default. Its internal worker "
            "coroutines also call <code>asyncio.timeout()</code>. If "
            "current_task() returns None at the wrong moment in a worker, "
            "the whole call raises and the entire benchmark run dies, even "
            "though two of three metrics succeeded. "
            "<code>_run_ragas</code> in <code>backend/eval/ragas_runner.py</code> "
            "fixes this by running each of the three metrics in its own "
            "<code>evaluate(dataset, metrics=[one_metric])</code> call, each "
            "wrapped in <code>try / except BaseException</code>. A failure in "
            "one metric records <code>float('nan')</code> for that metric and "
            "proceeds. The result row carries NaN for the broken metric and "
            "real numbers for the rest."
        ),

        h(2, "5.6 Rate limiting and identity"),
        p(
            "Guest tier identity is a SHA-256 hash of "
            "<code>(client_ip + ':' + x_fingerprint_header)</code>. Browser "
            "fingerprint alone is defeated by clearing site data; IP alone is "
            "defeated by switching networks; the composite hash requires the "
            "evader to do both at once. The hash is irreversible so no "
            "plaintext PII is stored. Counters live in "
            "<code>rate_limit_counters</code> with composite primary key "
            "<code>(fingerprint_hash, date)</code> so the limit resets at "
            "midnight UTC and old rows are leftover for analytics."
        ),
        PageBreak(),
    ]


def section_6_components() -> list:
    return [
        h(1, "6. Components and modules"),

        h(2, "6.1 Backend package map"),
        table_2col([
            ("backend/main.py",
             "FastAPI app factory, CORS, lifespan, /health and /strategies. "
             "Intentionally thin - only wiring and configuration."),
            ("backend/core/",
             "Config (env vars), auth (dev token), rate_limiter (fingerprint "
             "hashing and daily counters), database (asyncpg pool + schema)."),
            ("backend/ingest/",
             "File loaders behind a registry. One module per file format "
             "(pdf, txt). Each extends BaseIngestor and uses @register."),
            ("backend/chunkers/",
             "Text splitters behind a registry. Three strategies: fixed_size, "
             "semantic (embedding-similarity boundaries), hierarchical "
             "(parent/child two-level)."),
            ("backend/retrieval/",
             "Retrieval strategies behind a registry. Four strategies "
             "(naive, hyde, multiquery, hybrid) plus contextual_compression "
             "which is a post-retrieval processor outside the registry."),
            ("backend/llm/",
             "LLM provider abstraction. OpenAI provider used by the backend; "
             "Anthropic provider available for BYOK. Each exposes async + "
             "sync variants of complete() and embed()."),
            ("backend/eval/",
             "ragas_runner - the background-task implementation. The most "
             "subtle file in the codebase. See Section 5.4."),
            ("backend/routers/",
             "FastAPI routers, one per domain: ingest, benchmark, results, "
             "chat. Each owns its own request validation and response shape."),
        ]),

        h(2, "6.2 Frontend package map"),
        table_2col([
            ("frontend/app/layout.tsx",
             "Root layout. No-flash theme inject, font load, ThemeProvider + "
             "AudioManagerProvider + UIContextProvider, mounts BYOKDrawer "
             "and ToastDisplay at root for global access."),
            ("frontend/app/page.tsx",
             "Landing page. Hero, Why, Features, CTA, Footer. Renders "
             "SnowflakeBackground particles and the TierSelectionModal."),
            ("frontend/app/app/page.tsx",
             "App shell. Wraps the four steps in AppContextProvider. Manages "
             "step navigation and shows the first-visit tier modal."),
            ("frontend/app/app/steps/",
             "Step1Upload, Step2Configure, Step3Results, Step4Chat. Each "
             "step reads and writes shared state via useAppContext()."),
            ("frontend/app/docs/page.tsx",
             "Public docs page. How it works (three phases), metric "
             "explanations with KaTeX formulae, retrieval strategy "
             "descriptions, FAQ."),
            ("frontend/components/",
             "Nav, StepIndicator, ParamForm (dynamic form from "
             "param_schema), BYOKDrawer, TierModal, TierSelectionModal, "
             "ErrorBoundary, ThemeProvider, AudioManager, ToastDisplay, "
             "and decorative backgrounds (Snowflake, RAGFlow, Particle)."),
            ("frontend/context/",
             "AppContext (corpus, runs, history, byok), UIContext (toasts, "
             "drawer state, theme accessor)."),
            ("frontend/lib/api.ts",
             "Typed fetch client for every backend endpoint. Attaches "
             "X-Dev-Token and X-Fingerprint headers automatically."),
            ("frontend/lib/utils.ts",
             "Misc helpers (className join, format utilities)."),
        ]),
        PageBreak(),
    ]


def file_table(rows: list[tuple[str, str]]) -> Table:
    """Two-column table sized for code-path entries."""
    return table_2col(rows, col_widths=(2.4 * inch, 3.8 * inch))


def section_7_walkthrough() -> list:
    return [
        h(1, "7. Codebase walkthrough"),
        p(
            "Every non-trivial source file in the repository, in import order. "
            "Generated assets (<code>.next/</code>, "
            "<code>node_modules/</code>, <code>.pytest_cache/</code>) are "
            "omitted."
        ),

        h(2, "7.1 Backend - bootstrapping and config"),
        file_table([
            ("backend/main.py",
             "FastAPI app entry. Wires CORS, lifespan (create_tables on "
             "startup, close_pool on shutdown), all routers, and the "
             "/health and /strategies utility endpoints."),
            ("backend/core/config.py",
             "The only file that reads environment variables. Defines the "
             "Settings pydantic-settings class and the module-level "
             "<code>settings</code> singleton imported everywhere else."),
            ("backend/core/auth.py",
             "Dev token validation. SHA-256 hash on both sides; "
             "<code>hmac.compare_digest</code> for timing safety. Exposes "
             "the <code>get_dev_access</code> FastAPI dependency."),
            ("backend/core/rate_limiter.py",
             "Daily run and chat limit constants. "
             "<code>get_fingerprint_hash</code> dependency turns "
             "(IP + X-Fingerprint) into a SHA-256 identity."),
            ("backend/core/database.py",
             "asyncpg pool singleton (<code>get_pool</code>), psycopg2 sync "
             "connection helper (<code>make_sync_connection</code>), DDL via "
             "<code>create_tables</code>, and CRUD helpers for the three "
             "tables (corpus_chunks, benchmark_runs, rate_limit_counters)."),
        ]),

        h(2, "7.2 Backend - ingest pipeline"),
        file_table([
            ("backend/ingest/base.py",
             "BaseIngestor abstract class and the @register decorator. "
             "Module-level <code>registry</code> dict populated at import."),
            ("backend/ingest/pdf.py",
             "PdfIngestor. Wraps bytes in <code>io.BytesIO</code>, uses "
             "<code>pypdf.PdfReader</code>, returns one string per non-blank "
             "page."),
            ("backend/ingest/txt.py",
             "TxtIngestor. UTF-8 decode, returns single-element list to "
             "match the multi-page interface of PdfIngestor."),
            ("backend/ingest/registry.py",
             "Side-effect import module. Imports pdf and txt so their "
             "@register decorators run."),
        ]),

        h(2, "7.3 Backend - chunkers"),
        file_table([
            ("backend/chunkers/base.py",
             "BaseChunker abstract class, RetrievalResult, @register. "
             "Enforces <code>param_schema</code> at registration time."),
            ("backend/chunkers/fixed_size.py",
             "FixedSizeChunker. Whitespace tokenization, fixed-size windows "
             "with overlap. Baseline chunker."),
            ("backend/chunkers/semantic.py",
             "SemanticChunker. Embeds each sentence, splits where adjacent "
             "similarity drops below threshold. Calls the embeddings API."),
            ("backend/chunkers/hierarchical.py",
             "HierarchicalChunker. Two levels: parent (1024 tokens default) "
             "for context, child (256 tokens default) for retrieval precision."),
            ("backend/chunkers/registry.py",
             "Side-effect import module."),
        ]),

        h(2, "7.4 Backend - retrieval strategies"),
        file_table([
            ("backend/retrieval/base.py",
             "BaseRetriever abstract class, RetrievalResult dataclass, "
             "@register decorator. Same registry pattern as ingestors and "
             "chunkers."),
            ("backend/retrieval/naive.py",
             "NaiveRetriever. Embeds query, cosine similarity vs every "
             "stored chunk, returns top-k. Baseline."),
            ("backend/retrieval/hyde.py",
             "HydeRetriever. LLM call to generate hypothetical answer, embed "
             "that, retrieve against it. hypothetical_doc_length parameter "
             "(short / medium / long)."),
            ("backend/retrieval/multiquery.py",
             "MultiQueryRetriever. One LLM call to generate num_variants "
             "rewordings, parallel embed via gather, merge by best score."),
            ("backend/retrieval/hybrid.py",
             "HybridRetriever. BM25 (rank-bm25) and dense run in parallel, "
             "fused with Reciprocal Rank Fusion. bm25_weight and rrf_k "
             "parameters."),
            ("backend/retrieval/contextual_compression.py",
             "ContextualCompressor. <b>NOT</b> a BaseRetriever. Post-retrieval "
             "filter: per-chunk LLM call extracts only query-relevant "
             "sentences. Dropped chunks fall below min_relevance_length."),
            ("backend/retrieval/registry.py",
             "Side-effect import module."),
        ]),

        h(2, "7.5 Backend - LLM providers"),
        file_table([
            ("backend/llm/base.py",
             "BaseLLMProvider abstract class and @register decorator."),
            ("backend/llm/openai_provider.py",
             "OpenAIProvider. async + sync variants of complete() and "
             "embed(). Uses httpx.AsyncClient or httpx.Client per call. The "
             "sync variants are required by the background task path."),
            ("backend/llm/anthropic_provider.py",
             "AnthropicProvider. Async + sync complete() only - Anthropic "
             "has no public embeddings API, so embed() raises "
             "NotImplementedError. Used by Tier 2 BYOK."),
            ("backend/llm/registry.py",
             "Side-effect import module."),
        ]),

        h(2, "7.6 Backend - evaluation"),
        file_table([
            ("backend/eval/ragas_runner.py",
             "The background task. <code>run_evaluation</code> is the sync "
             "entry point registered with BackgroundTasks; "
             "<code>_run_evaluation_async</code> is the async implementation. "
             "<code>_run_ragas</code> runs each metric in isolation. "
             "<code>get_run</code> is the helper used by the results router."),
        ]),

        h(2, "7.7 Backend - routers"),
        file_table([
            ("backend/routers/ingest.py",
             "POST /ingest. Read all files, enforce 10MB cap, hash, "
             "deduplicate, ingest via registry, chunk, embed via "
             "asyncio.gather, bulk-insert via asyncpg executemany."),
            ("backend/routers/benchmark.py",
             "POST /benchmark. Validate corpus + strategies, check guest "
             "quota for N strategies, open N rows, schedule N background "
             "tasks, increment counter by N, return all run_ids with 202."),
            ("backend/routers/results.py",
             "GET /results/{run_id}. Reads the full benchmark_runs row. "
             "Frontend polls this endpoint until status is terminal."),
            ("backend/routers/chat.py",
             "POST /chat. Same retrieval + compression + answer generation "
             "as the benchmark, but no RAGAS scoring and no benchmark_runs "
             "row. Counts against the 5/day chat quota."),
        ]),

        h(2, "7.8 Frontend - shell"),
        file_table([
            ("frontend/app/layout.tsx",
             "Root layout. No-flash theme inject script, Inter font, "
             "Provider stack (Theme, Audio, UI), mounts BYOKDrawer + Toast."),
            ("frontend/app/page.tsx",
             "Landing page (/) with Snowflake particles and tier modal."),
            ("frontend/app/app/page.tsx",
             "App shell (/app). Wraps the four steps in AppContextProvider, "
             "manages forward/backward step navigation, shows first-visit "
             "TierModal."),
            ("frontend/app/docs/page.tsx",
             "Public docs (/docs). Explains how it works, metric formulae "
             "with KaTeX, retrieval strategies, FAQ."),
        ]),

        h(2, "7.9 Frontend - step components"),
        file_table([
            ("steps/Step1Upload.tsx",
             "Upload + chunker config. Calls POST /ingest, stores "
             "corpus_hash in AppContext, advances to Step 2."),
            ("steps/Step2Configure.tsx",
             "Strategy multi-select + per-strategy param form + compression "
             "toggle + question input. Calls POST /benchmark, stores "
             "<code>run_ids</code>, advances to Step 3."),
            ("steps/Step3Results.tsx",
             "Polls every run_id in parallel, populates radar / latency / "
             "table / score-card / winner widgets as each run completes. "
             "Persists history to localStorage."),
            ("steps/Step4Chat.tsx",
             "Live chat. Posts to /chat, displays answer with metadata "
             "(strategy used, retrieved chunks). Counter and upgrade prompt."),
        ]),

        h(2, "7.10 Frontend - reusable components"),
        file_table([
            ("Nav.tsx",
             "Global nav with theme toggle, audio toggle, GitHub link, Docs "
             "link, Settings (opens BYOKDrawer)."),
            ("StepIndicator.tsx",
             "Numbered step pills with click-to-go-back."),
            ("ParamForm.tsx",
             "Dynamic form built from a param_schema array. Renders sliders "
             "for int/float, dropdowns for enum, tooltips from description."),
            ("BYOKDrawer.tsx",
             "Slide-in drawer for BYOK key + model. Stores in localStorage. "
             "Dispatches a DOM event so AppContext picks up the change "
             "without prop drilling."),
            ("TierModal.tsx",
             "First-visit modal explaining all three tiers. Stored "
             "dismissal in localStorage."),
            ("TierSelectionModal.tsx",
             "Landing-page modal for tier selection / sign-up flows."),
            ("ErrorBoundary.tsx",
             "React error boundary that wraps each step so a render crash "
             "in one step does not unmount the whole app."),
            ("ThemeProvider.tsx",
             "Dark / light / system theme management. Persists to "
             "localStorage."),
            ("AudioManager.tsx",
             "Ambient audio playback + click SFX. Persisted volume / off "
             "state in localStorage."),
            ("ToastDisplay.tsx",
             "Toast notification renderer. Reads queue from UIContext."),
            ("Formula.tsx",
             "KaTeX wrapper for inline and block formulae in the docs page."),
            ("SnowflakeBackground.tsx / ParticleBackground.tsx / RAGFlowBackground.tsx",
             "Three decorative canvas backgrounds used on the landing, "
             "particles, and docs / chat pages respectively."),
        ]),

        h(2, "7.11 Frontend - state and API"),
        file_table([
            ("context/AppContext.tsx",
             "useReducer-based store for all per-session benchmark state: "
             "corpus_hash, chunk count, selected strategies and params, "
             "run_ids, run history (also mirrored to localStorage)."),
            ("context/UIContext.tsx",
             "Toast queue, drawer open/close, theme accessor, dev mode "
             "flag."),
            ("lib/api.ts",
             "Typed fetch client. Every backend endpoint typed end-to-end. "
             "Auto-attaches X-Dev-Token (from sessionStorage) and "
             "X-Fingerprint (from a stable browser hash) headers."),
            ("lib/utils.ts",
             "Class-name join and minor formatting helpers."),
        ]),

        h(2, "7.12 Tests, deploy, and supporting files"),
        file_table([
            ("tests/test_retrieval.py",
             "Unit tests for the four retrieval strategies with mocked LLM."),
            ("tests/test_retrieval_strategies.py",
             "Integration-style tests for retrieval that exercise the "
             "registry and param filter logic."),
            ("tests/test_chunkers.py",
             "Tests for fixed_size, semantic, hierarchical chunkers."),
            ("tests/test_ingest.py",
             "Tests for the ingest router including duplicate detection "
             "and size limit enforcement."),
            ("tests/test_eval.py",
             "Tests for the eval pipeline. Mocks <code>_run_ragas</code> at "
             "module level to avoid needing a real OpenAI key."),
            ("tests/test_compression.py",
             "Tests for ContextualCompressor."),
            ("tests/test_auth.py",
             "Tests for the dev token validation flow."),
            ("tests/test_routers.py",
             "Tests for router-level behaviour (rate limits, 404 on "
             "missing corpus, 422 on bad input)."),
            ("tests/parallel_probe.py",
             "Manual stress probe for parallel run handling. Not part of "
             "pytest discovery."),
            ("scripts/smoke_test.py",
             "End-to-end smoke test against a running local backend and "
             "real database. No mocks."),
            ("scripts/build_reference_pdf.py",
             "This script. Builds docs/RAGScope_Reference.pdf."),
            ("Dockerfile",
             "Railway production image. python:3.11.9-slim base. Installs "
             "libpq-dev + gcc for psycopg2-binary. Runs uvicorn on port "
             "8000."),
            ("railway.toml",
             "Railway build / deploy / health-check configuration. Pins "
             "build to the Dockerfile and binds startCommand to the "
             "Railway-injected $PORT."),
            ("docker-compose.yml",
             "Local-dev Postgres + pgvector container on port 5433. "
             "Persists data in a named volume."),
            ("requirements.txt",
             "Pinned Python dependencies. See Section 8."),
            ("frontend/package.json",
             "Pinned Node dependencies and npm scripts."),
            (".env.example",
             "Template for the .env file. Lists every variable the backend "
             "reads."),
            ("CLAUDE.md",
             "Internal project rules and architectural decisions. The "
             "authoritative source for code-style and design constraints."),
            ("README.md",
             "Public-facing GitHub README. Quickstart, tier table, stack, "
             "deployment, extension pattern."),
            ("devlog.md",
             "Append-only narrative log of the sessions that built the "
             "project. Useful background for interview prep."),
        ]),
        PageBreak(),
    ]


def section_8_libraries() -> list:
    return [
        h(1, "8. Library reference"),

        h(2, "8.1 Backend - production dependencies"),
        table_3col(
            ("Package", "Pinned version", "Why it is needed"),
            [
                ("fastapi", "0.115.12",
                 "Async web framework. Native pydantic validation, "
                 "BackgroundTasks, auto OpenAPI docs at /docs."),
                ("uvicorn[standard]", "0.34.2",
                 "ASGI server with uvloop and httptools. Production WSGI "
                 "replacement for FastAPI."),
                ("asyncpg", "0.30.0",
                 "Async Postgres driver. Used by the request path; binds to "
                 "the FastAPI main event loop."),
                ("psycopg2-binary", "2.9.12",
                 "Synchronous Postgres driver. Used by the background-task "
                 "path because it never touches asyncio (see Section 5.4)."),
                ("pgvector", "0.4.0",
                 "Postgres vector type bindings for asyncpg and psycopg2. "
                 "Used for the embedding column on corpus_chunks."),
                ("rank-bm25", "0.2.2",
                 "Pure-Python BM25Okapi implementation. Used by hybrid "
                 "retrieval. Chosen over Elasticsearch so the project has "
                 "no extra infra dependency."),
                ("openai", "1.78.1",
                 "Official OpenAI SDK. Currently used indirectly by RAGAS; "
                 "RAGScope's own provider uses httpx directly."),
                ("anthropic", "0.52.0",
                 "Official Anthropic SDK. Same indirect-via-RAGAS role; "
                 "BYOK provider uses httpx directly."),
                ("httpx", "0.28.1",
                 "Async + sync HTTP client. The only HTTP library in the "
                 "backend (no requests, no aiohttp)."),
                ("ragas", "0.1.21",
                 "RAG evaluation framework. Pinned to 0.1.21 because the "
                 "API broke in later versions and the per-metric isolation "
                 "pattern is keyed to this version's behaviour."),
                ("langsmith", "0.1.147",
                 "Trace export to LangSmith. Used without "
                 "langchain-core to avoid the langchain monorepo dep."),
                ("pydantic-settings", "2.9.1",
                 "Env-var aware settings class. Powers backend/core/config.py."),
                ("python-dotenv", "1.1.0",
                 ".env file loading in dev. Production reads real env vars; "
                 "this is a dev convenience."),
                ("python-multipart", "0.0.27",
                 "Required by FastAPI for multipart/form-data parsing on "
                 "POST /ingest."),
                ("pypdf", "5.1.0",
                 "PDF text extraction. Pure-Python, no system libraries."),
                ("datasets", "4.8.5",
                 "HuggingFace Datasets. Required by RAGAS to wrap the "
                 "question/answer/contexts triple."),
                ("pytest", "8.3.5",
                 "Test runner."),
                ("pytest-asyncio", "0.26.0",
                 "Adds @pytest.mark.asyncio so async tests run on a "
                 "managed event loop."),
            ],
            col_widths=(1.4 * inch, 1.0 * inch, 3.8 * inch),
        ),

        h(2, "8.2 Frontend - production dependencies"),
        table_3col(
            ("Package", "Pinned version", "Why it is needed"),
            [
                ("next", "^14.2.29",
                 "React framework. App Router, static pre-rendering, route "
                 "rewrites to the backend, image optimisation."),
                ("react / react-dom", "^18",
                 "The UI library."),
                ("framer-motion", "^11",
                 "Animations and AnimatePresence for step transitions, "
                 "modal slide-ins, and the winner-badge glow."),
                ("recharts", "^2",
                 "Radar chart, bar chart, and the comparison table tooltip "
                 "rendering. SVG-based, no canvas."),
                ("lucide-react", "^0.400.0",
                 "Icon set. Tree-shakeable, paired with Tailwind."),
                ("katex / @types/katex", "^0.16.45 / ^0.16.8",
                 "Math typesetting for the metric formulae on the docs "
                 "page."),
            ],
            col_widths=(1.6 * inch, 1.4 * inch, 3.2 * inch),
        ),

        h(2, "8.3 Frontend - dev dependencies"),
        table_3col(
            ("Package", "Pinned version", "Why it is needed"),
            [
                ("typescript", "^5", "TypeScript compiler."),
                ("@types/*", "^18-^20", "Type definitions for Node and React."),
                ("eslint", "^8", "Lint runner."),
                ("eslint-config-next", "14.2.21",
                 "Next.js's official eslint rules."),
                ("tailwindcss", "^3", "Utility-first CSS."),
                ("postcss / autoprefixer", "^8 / ^10",
                 "CSS pipeline used by Tailwind."),
            ],
            col_widths=(1.6 * inch, 1.4 * inch, 3.2 * inch),
        ),
        PageBreak(),
    ]


def section_9_connections() -> list:
    return [
        h(1, "9. How the files connect"),

        h(2, "9.1 Backend import graph"),
        code(
"""backend.main
  +-- backend.chunkers.registry      ->  imports each chunker module
  |     +-- backend.chunkers.fixed_size       (@register)
  |     +-- backend.chunkers.semantic         (@register)
  |     +-- backend.chunkers.hierarchical     (@register)
  +-- backend.retrieval.registry     ->  imports each retriever module
  |     +-- backend.retrieval.naive           (@register)
  |     +-- backend.retrieval.hyde            (@register)
  |     +-- backend.retrieval.multiquery      (@register)
  |     +-- backend.retrieval.hybrid          (@register)
  |     +-- backend.retrieval.contextual_compression  (NOT registered)
  +-- backend.retrieval.contextual_compression
  +-- backend.core.database          ->  get_pool, create_tables, close_pool
  +-- backend.routers.ingest         ->  POST /ingest
  +-- backend.routers.benchmark      ->  POST /benchmark
  +-- backend.routers.results        ->  GET /results/{run_id}
  +-- backend.routers.chat           ->  POST /chat

backend.eval.ragas_runner            (imported by routers.benchmark)
  +-- backend.core.config            ->  settings (OPENAI_API_KEY)
  +-- backend.core.database          ->  make_sync_connection, get_pool
  +-- backend.llm.openai_provider    ->  OpenAIProvider
  +-- backend.retrieval.registry     ->  retrieval registry
  +-- backend.retrieval.contextual_compression
"""
        ),

        h(2, "9.2 Why the registries exist"),
        p(
            "Every retriever, chunker, ingestor, and LLM provider extends a "
            "base class and uses the <code>@register</code> decorator. The "
            "decorator inserts the class into a module-level dict keyed by "
            "<code>cls.name</code>. The <code>registry.py</code> file in each "
            "package <i>imports</i> all concrete modules so the decorators "
            "run at startup. After that, no other code needs to know the "
            "list of strategies - everything reads from the populated dict."
        ),
        p(
            "This is what makes the API <code>/strategies</code> response and "
            "the entire frontend dynamic. Adding a fifth retrieval strategy "
            "is a one-file change (see Section 12)."
        ),

        h(2, "9.3 The benchmark call chain"),
        code(
"""HTTP POST /benchmark  ->  routers/benchmark.create_benchmark()
  validate corpus       ->  core/database.corpus_exists()
  validate strategies   ->  retrieval/registry.registry
  check rate limit      ->  core/database.get_run_count()
  for strategy in N:
    insert row          ->  pool.fetchrow(INSERT)
    schedule task       ->  BackgroundTasks.add_task(eval.run_evaluation, ...)
  increment counter     ->  core/database.increment_run_count(delta=N)
  return [run_ids]      ->  HTTP 202

(later, on the worker thread, for each scheduled task:)
eval.run_evaluation()  ->  creates loop, wraps in Task, drives:
  eval._run_evaluation_async()
    make_sync_connection()                           (psycopg2)
    UPDATE benchmark_runs SET status='running'
    SELECT ... FROM corpus_chunks                    (load corpus)
    retriever = registry[strategy](corpus, **params)
    results   = await retriever.retrieve(question, top_k)
    if compression_enabled:
      results = await ContextualCompressor.compress(results, question)
    answer    = _generate_answer(question, contexts, OpenAIProvider())
    scores    = _run_ragas(question, answer, contexts)   (per-metric)
    UPDATE benchmark_runs SET status='completed', scores=..., chunks=...
"""
        ),

        h(2, "9.4 The frontend call chain"),
        code(
"""User opens /app
  AppContextProvider mounts
  TierModal shown if not previously dismissed
  fetch GET /strategies                            (registries -> form schemas)

User clicks "Proceed" on Step 1 with files + chunker config
  POST /ingest multipart                            (file_data, chunker)
    -> response: { corpus_hash, chunk_count }
  AppContext: corpusHash = ...

User clicks "Run" on Step 2 with N strategies + question
  POST /benchmark JSON                              (corpus_hash, strategies)
    -> response: { run_ids: [...] }
  AppContext: runIds = ...
  Step 3 mounted

Step 3 polls each run_id in parallel
  for run_id in runIds:
    setInterval -> GET /results/{run_id} until status terminal
  As each completes, push into runHistory, update charts

User types in Step 4 chat
  POST /chat JSON                                   (corpus_hash, q, strategy)
    -> response: { answer, retrieved_chunks, strategy_used }
  decrement local chat counter, render message
"""
        ),

        h(2, "9.5 Where state lives"),
        *bullets([
            "<b>Server-side, persistent.</b> Postgres: corpus_chunks (with "
            "embeddings), benchmark_runs (with results), "
            "rate_limit_counters (per day).",
            "<b>Server-side, in-memory.</b> Nothing. The backend is "
            "stateless across requests; every piece of context is reloaded "
            "from Postgres.",
            "<b>Client-side, persistent.</b> localStorage: theme, audio "
            "settings, BYOK key + model, run history, tier modal dismissal.",
            "<b>Client-side, session-only.</b> sessionStorage: dev token "
            "(set from URL param on first visit, cleared on tab close).",
            "<b>Client-side, in-memory.</b> AppContext (corpus_hash, "
            "run_ids, currently-displayed runs), UIContext (toast queue, "
            "drawer state).",
        ]),
        PageBreak(),
    ]


def section_10_troubleshooting() -> list:
    return [
        h(1, "10. Troubleshooting playbook"),
        p(
            "This is the section to read when something breaks. Each entry "
            "lists a symptom, the most likely cause given the free-tier "
            "topology, and the fix. References to provider behaviour are "
            "taken from the official Railway, Supabase, Vercel, and OpenAI "
            "documentation."
        ),

        h(2, "10.1 Supabase - free-tier database paused"),
        p(
            "<b>Symptom.</b> Every backend request hangs for ~30 seconds and "
            "then fails. Railway logs show "
            "<code>asyncpg.exceptions.PostgresConnectionError</code> or "
            "<code>OSError: [Errno 111] Connection refused</code>."
        ),
        p(
            "<b>Cause.</b> Supabase auto-pauses a free-tier project that "
            "has had no activity for 7 days. The official Supabase docs "
            "(<i>Database -> Pausing inactive projects</i>) state the database "
            "is taken offline; the pooler accepts connections but the "
            "downstream Postgres is unreachable."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Open the Supabase dashboard for the project.",
            "Click <i>Restore project</i> (free-tier projects restore in 1-2 "
            "minutes).",
            "Hit <code>/health</code> on the backend to warm the pool.",
            "<b>Prevention.</b> A small scheduled GET to <code>/health</code> "
            "every few days keeps the pool warm enough that Supabase counts "
            "the project as active. Upgrading to the paid tier removes the "
            "auto-pause entirely.",
        ]),

        h(2, "10.2 Supabase - 'too many clients already' or connection limits"),
        p(
            "<b>Symptom.</b> Intermittent backend failures during heavy "
            "benchmarking. Errors mention <i>connection limit exceeded</i> "
            "or <i>FATAL: sorry, too many clients already</i>."
        ),
        p(
            "<b>Cause.</b> Supabase free tier caps direct connections at "
            "60 (see Supabase docs <i>Pricing -> Database</i>). The asyncpg "
            "default pool is 10 per process; a few cold-boots or stuck "
            "background tasks can push you over."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Use the <b>transaction pooler</b> URL (port 6543), not the "
            "direct connection (port 5432). The pooler multiplexes many "
            "client connections over a smaller pool.",
            "Verify <code>SUPABASE_URL</code> in Railway uses port 6543.",
            "Reduce <code>make_task_pool()</code> max_size (already 3) if "
            "concurrency is exceptional.",
        ]),

        h(2, "10.3 Railway - service spun down on free tier"),
        p(
            "<b>Symptom.</b> First request after a quiet period takes 15-30 "
            "seconds. Subsequent requests are fast."
        ),
        p(
            "<b>Cause.</b> Railway's free 'Hobby' allowance allows the "
            "service to be evicted from a warm slot when idle. Cold boot "
            "needs to pull the image, start uvicorn, and run "
            "<code>create_tables()</code>."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "The 300-second healthcheck timeout in <code>railway.toml</code> "
            "already accommodates the cold boot.",
            "If a 5xx is returned during a smoke test, simply retry after "
            "30 seconds.",
            "<b>Prevention.</b> A scheduled <code>/health</code> ping every "
            "5-10 minutes from an external monitor (UptimeRobot, "
            "BetterStack) keeps the service warm. Upgrading to the paid "
            "Hobby plan removes the eviction behaviour.",
        ]),

        h(2, "10.4 Railway - deploy fails with 'no main.py' or import error"),
        p(
            "<b>Symptom.</b> Railway deploy logs show "
            "<code>ModuleNotFoundError: No module named 'backend'</code> or "
            "a similar import failure at uvicorn startup."
        ),
        p(
            "<b>Cause.</b> Railway is building from the wrong directory or "
            "the Dockerfile <code>WORKDIR</code> is wrong."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Confirm the project root in Railway settings is the repo root "
            "(not <code>backend/</code>).",
            "Confirm the Dockerfile sets <code>WORKDIR /app</code> and uses "
            "<code>COPY . .</code> so the <code>backend</code> package "
            "lands at <code>/app/backend/</code>.",
            "Run <code>docker build</code> locally and confirm "
            "<code>docker run</code> serves <code>/health</code> before "
            "redeploying.",
        ]),

        h(2, "10.5 Vercel - frontend build fails on type error"),
        p(
            "<b>Symptom.</b> Vercel build output shows <i>Type error</i> "
            "with a path inside <code>frontend/</code>."
        ),
        p(
            "<b>Cause.</b> <code>npm run build</code> runs strict TypeScript "
            "checks that <code>npm run dev</code> does not. A change that "
            "passes locally with <code>dev</code> can break the build."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Run <code>cd frontend && npm run build</code> locally before "
            "every push. CLAUDE.md mandates this.",
            "Fix the type error at its source. Do not add "
            "<code>// @ts-ignore</code> or relax tsconfig.",
        ]),

        h(2, "10.6 Vercel - frontend cannot reach backend"),
        p(
            "<b>Symptom.</b> The deployed app loads but every API call "
            "fails with CORS or network error."
        ),
        p(
            "<b>Cause.</b> Two possibilities. (a) "
            "<code>NEXT_PUBLIC_API_URL</code> is unset in Vercel "
            "settings, so the rewrite in <code>next.config.js</code> falls "
            "back to <code>http://localhost:8000</code>. (b) The Vercel "
            "origin is not in the backend CORS allow-list."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Set <code>NEXT_PUBLIC_API_URL=https://&lt;your-railway-url&gt;</code> "
            "in Vercel project settings and redeploy.",
            "Confirm <code>backend/main.py</code> CORS allow_origins "
            "contains your Vercel origin (default includes "
            "<code>https://ragscope.vercel.app</code> and "
            "<code>http://localhost:3000</code>).",
        ]),

        h(2, "10.7 OpenAI - invalid_api_key or 401"),
        p(
            "<b>Symptom.</b> Backend logs show "
            "<code>openai.AuthenticationError</code> or RAGAS scores "
            "return NaN for every run."
        ),
        p(
            "<b>Cause.</b> Per the OpenAI docs (<i>API reference -> "
            "Authentication</i>), 401 means the key is missing, malformed, "
            "or revoked."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Confirm <code>OPENAI_API_KEY</code> is set in Railway service "
            "variables (not just in local .env).",
            "Confirm the key starts with <code>sk-...</code> and has not "
            "been revoked at platform.openai.com.",
            "Confirm the project tied to the key has model access for "
            "<code>gpt-4o-mini</code> and <code>text-embedding-3-small</code>.",
        ]),

        h(2, "10.8 OpenAI - 429 rate limit"),
        p(
            "<b>Symptom.</b> Some benchmark runs fail with status='failed' "
            "and error_message contains <i>Rate limit reached</i>."
        ),
        p(
            "<b>Cause.</b> OpenAI per-key TPM/RPM limit hit (see official "
            "<i>Rate limits</i> page). The free tier has the strictest "
            "ceiling."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Wait 60 seconds and retry the run.",
            "Reduce per-strategy <code>num_variants</code> on multi-query "
            "or <code>top_k</code> if many concurrent runs are in flight.",
            "Switch to a paid OpenAI tier or BYOK with a different key for "
            "the heavy run.",
        ]),

        h(2, "10.9 RAGAS - all metrics return NaN"),
        p(
            "<b>Symptom.</b> Status='completed' but every metric column is "
            "null. The frontend shows '-' for every score."
        ),
        p(
            "<b>Cause.</b> Inside <code>_run_ragas</code>, every per-metric "
            "<code>evaluate()</code> call raised. Common reasons: missing "
            "OPENAI_API_KEY (RAGAS reads it via langchain), the dataset is "
            "malformed (empty contexts list), or an upstream API outage."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Check Railway logs for the <code>_run_ragas: metric X raised "
            "Y</code> line printed by the logger. The traceback identifies "
            "the cause.",
            "If the cause is auth, see Section 10.7.",
            "If the cause is empty contexts, check the retriever returned "
            "results (chunk count > 0) and the corpus has chunks.",
        ]),

        h(2, "10.10 RAGAS - 'Timeout should be used inside a task'"),
        p(
            "<b>Symptom.</b> Background task crashes with "
            "<code>RuntimeError(\"Timeout should be used inside a task\")</code>."
        ),
        p(
            "<b>Cause.</b> The legacy Python 3.14 bug described in Section "
            "5.4. <i>Should</i> not occur on Railway (Python 3.11.9 pinned "
            "in the Dockerfile)."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Confirm the running container is built from the pinned "
            "Dockerfile and the base image is <code>python:3.11.9-slim</code>.",
            "If the trace is inside the post-commit cleanup, confirm "
            "<code>completed_committed</code> is set in "
            "<code>_run_evaluation_async</code> - the outer except checks "
            "it and swallows post-commit noise.",
        ]),

        h(2, "10.11 LangSmith - traces missing"),
        p(
            "<b>Symptom.</b> LangSmith dashboard shows zero traces for the "
            "ragscope project."
        ),
        p(
            "<b>Cause.</b> Either <code>LANGCHAIN_TRACING_V2</code> is "
            "<code>false</code> in Railway, or "
            "<code>LANGCHAIN_API_KEY</code> is missing, or the project "
            "name in <code>LANGCHAIN_PROJECT</code> does not match the "
            "dashboard."
        ),
        p("<b>Fix.</b> Set all three in Railway variables, redeploy."),

        h(2, "10.12 Local dev - 'No module named pytest' or 'No module named reportlab'"),
        p(
            "<b>Cause.</b> The system python is being used instead of the "
            "project virtualenv at <code>.venv/</code>."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Activate the venv: <code>source .venv/bin/activate</code>.",
            "Or invoke directly: <code>.venv/bin/python -m pytest</code> / "
            "<code>.venv/bin/python scripts/build_reference_pdf.py</code>.",
        ]),

        h(2, "10.13 Local dev - 'connection refused' on port 5433"),
        p(
            "<b>Cause.</b> The Docker Postgres container is not running."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "<code>docker-compose up -d</code> from the repo root.",
            "<code>docker ps</code> to confirm the <code>postgres</code> "
            "container has status <i>healthy</i>.",
            "Confirm <code>SUPABASE_URL</code> in <code>.env</code> points "
            "to <code>postgresql://ragscope:ragscope@localhost:5433/ragscope</code> "
            "for local dev.",
        ]),

        h(2, "10.14 Local dev - 'pgvector extension not found'"),
        p(
            "<b>Cause.</b> The Postgres image is plain Postgres rather than "
            "<code>pgvector/pgvector:pg16</code>."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Confirm <code>docker-compose.yml</code> uses image "
            "<code>pgvector/pgvector:pg16</code>.",
            "<code>docker-compose down -v && docker-compose up -d</code> to "
            "rebuild against the right image (the <code>-v</code> "
            "destroys the volume so the new image initialises a fresh DB).",
        ]),

        h(2, "10.15 Frontend - 'CORS policy: No Access-Control-Allow-Origin'"),
        p(
            "<b>Cause.</b> The frontend origin is not in "
            "<code>backend/main.py</code>'s CORS allow-list, or a stale "
            "service worker is intercepting requests."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Add the new origin to "
            "<code>CORSMiddleware.allow_origins</code> in main.py and "
            "redeploy.",
            "If a stale SW is the cause, open DevTools -> Application -> "
            "Service Workers -> Unregister.",
        ]),

        h(2, "10.16 Browser - BYOK key 'leaked' to the backend"),
        p(
            "<b>Symptom.</b> The user reports that they entered their key "
            "in the BYOK drawer but it appears in a request to the "
            "RAGScope backend in DevTools Network."
        ),
        p(
            "<b>Cause.</b> A regression in <code>BYOKDrawer.tsx</code> or "
            "<code>lib/api.ts</code>. By design, the BYOK key is read in "
            "the browser and used to call OpenAI / Anthropic directly. The "
            "RAGScope backend never sees it."
        ),
        p("<b>Fix.</b>"),
        *bullets([
            "Audit <code>BYOKDrawer.tsx</code>: the key must only be "
            "written to <code>localStorage</code> and never passed as a "
            "fetch body or query parameter to "
            "<code>/api/...</code>.",
            "Audit <code>lib/api.ts</code>: no header named "
            "<code>X-User-Api-Key</code> or similar should be attached.",
            "If a regression is confirmed, treat it as a security incident: "
            "revoke any keys that may have transited the backend, rotate "
            "the deploy, and inspect Railway logs (which may have logged "
            "request headers in error paths).",
        ]),
        PageBreak(),
    ]


def section_11_runbook() -> list:
    return [
        h(1, "11. Operational runbook"),

        h(2, "11.1 Deploy a backend change"),
        *bullets([
            "Run <code>.venv/bin/python -m pytest</code> (must show 106+ "
            "passing).",
            "Confirm no debug print statements were re-introduced.",
            "Commit and push to main. Railway auto-builds from the "
            "Dockerfile.",
            "Watch the Railway deploy logs until the health check passes.",
            "Hit <code>/health</code> from your terminal: expect "
            "<code>{\"status\":\"ok\"}</code>.",
            "Smoke test: open the live frontend, run a single naive RAG "
            "benchmark on a small TXT file.",
        ]),

        h(2, "11.2 Deploy a frontend change"),
        *bullets([
            "Run <code>cd frontend && npm run build</code>.",
            "Commit and push. Vercel auto-builds.",
            "Visit the preview URL Vercel posts on the commit, click "
            "through all four steps, confirm no console errors.",
        ]),

        h(2, "11.3 Rotate the dev token"),
        *bullets([
            "Generate a new token (any string).",
            "Update <code>DEV_TOKEN</code> in Railway service variables.",
            "Redeploy (Railway treats env-var changes as triggering "
            "redeploys).",
            "Visit <code>https://ragscope.vercel.app/app?dev=&lt;new&gt;</code> "
            "to refresh your own access. Old tokens stop working "
            "immediately because the backend hashes against the new value.",
        ]),

        h(2, "11.4 Apply a Postgres schema change"),
        *bullets([
            "Add the change as a new <code>conn.execute(...)</code> in "
            "<code>create_tables()</code> using "
            "<code>CREATE TABLE IF NOT EXISTS</code> or "
            "<code>ADD COLUMN IF NOT EXISTS</code> so the call is idempotent.",
            "Apply the same SQL via the Supabase SQL editor before "
            "redeploying, so the first request after deploy does not race "
            "against the in-app migration.",
        ]),

        h(2, "11.5 Investigate a stuck benchmark run"),
        *bullets([
            "Query Postgres: <code>SELECT id, status, created_at, "
            "error_message FROM benchmark_runs ORDER BY created_at DESC "
            "LIMIT 20;</code>",
            "If <i>pending</i> for over 5 minutes, the background task was "
            "never scheduled (look for an exception in the response path "
            "of <code>/benchmark</code>).",
            "If <i>running</i> for over 10 minutes, the task crashed "
            "between status=running and status=completed without writing "
            "an error. Check Railway logs for the run_id.",
        ]),

        h(2, "11.6 Clear the rate-limit table"),
        p(
            "Run <code>DELETE FROM rate_limit_counters WHERE date &lt; "
            "CURRENT_DATE - INTERVAL '7 days';</code> via the Supabase SQL "
            "editor. Safe to schedule weekly."
        ),
        PageBreak(),
    ]


def section_12_interview() -> list:
    return [
        h(1, "12. Interview prep capsule"),
        p(
            "This is the distilled set of talking points the author keeps "
            "ready for any interview that touches RAG, retrieval, FastAPI, "
            "async Python, or production LLM evaluation."
        ),

        h(2, "12.1 The 60-second pitch"),
        p(
            "<i>\"RAGScope is a public RAG benchmarking harness. You upload "
            "a corpus, ask a question, and it runs the same question through "
            "four retrieval strategies - naive, HyDE, multi-query, and hybrid "
            "BM25 + dense - in parallel, scoring each one with RAGAS on "
            "faithfulness, context utilization, answer relevancy, and "
            "latency. The frontend is Next.js on Vercel, the backend is "
            "FastAPI on Railway, the database is Supabase Postgres with "
            "pgvector. Every strategy is auto-discovered through a "
            "decorator registry, so adding a fifth one is a single file. "
            "The hardest engineering problem was running RAGAS as a "
            "background task without deadlocks; the solution was a "
            "dedicated event loop per task with a Task wrapper and "
            "synchronous psycopg2 for DB access, plus per-metric isolation "
            "so one failing metric doesn't kill the whole run.\"</i>"
        ),

        h(2, "12.2 The five questions you will be asked"),
        h(3, "Q. Why are these four retrieval strategies?"),
        p(
            "Each represents a different <i>shape</i> of retrieval: dense "
            "baseline (naive), query rewriting (HyDE), query expansion "
            "(multi-query), and sparse + dense fusion (hybrid). Picking one "
            "of each shape answers the user's real question - which style "
            "of retrieval fits my data - rather than ranking minor "
            "variations of cosine similarity."
        ),

        h(3, "Q. Why pgvector and not Pinecone or Weaviate?"),
        p(
            "(a) Postgres is already needed for benchmark_runs and "
            "rate_limit_counters; pgvector means one database to operate. "
            "(b) Supabase free tier covers it. (c) For corpora under "
            "~100k chunks, pgvector is fast enough that the difference is "
            "invisible. (d) No client SDK lock-in - any Postgres client works."
        ),

        h(3, "Q. Why RAGAS specifically?"),
        p(
            "It is the de-facto reference-free RAG eval framework. "
            "Reference-free matters because RAGScope cannot ask the user "
            "for ground-truth answers. Faithfulness, context utilization, "
            "and answer relevancy each measure a different failure mode "
            "(hallucination, context waste, off-topic), so the three "
            "together give a complete picture."
        ),

        h(3, "Q. Walk me through the async background task pattern."),
        p(
            "FastAPI BackgroundTasks dispatches non-async callables on a "
            "worker thread via anyio. The worker thread has no event loop. "
            "We create a fresh asyncio loop, wrap the async implementation "
            "in a Task via <code>loop.create_task()</code> (so "
            "<code>current_task()</code> is non-None for libraries like "
            "asyncpg that call <code>asyncio.timeout()</code> internally), "
            "and drive it with <code>loop.run_until_complete()</code>. The "
            "task uses synchronous psycopg2 for DB access because the "
            "previous deploy on Python 3.14 hit an asyncpg + asyncio.timeout "
            "interaction that the Task wrapper alone couldn't fix. Each "
            "RAGAS metric runs in its own evaluate() call wrapped in "
            "try/except BaseException so one failing metric writes NaN "
            "instead of killing the whole run."
        ),

        h(3, "Q. How does BYOK keep keys safe?"),
        p(
            "The key is entered in the BYOK drawer and written to "
            "<code>localStorage</code> only. On a BYOK request, the "
            "<i>frontend</i> calls OpenAI or Anthropic directly via httpx "
            "in the browser - the RAGScope backend never appears in the "
            "request path and so never sees the key. Even server logs of "
            "request headers can't capture what was never sent."
        ),

        h(2, "12.3 Design decisions worth name-checking"),
        *bullets([
            "<b>Auto-discovery via registry.</b> Each retriever, chunker, "
            "ingestor, provider extends a base class and uses "
            "<code>@register</code>. The API and UI dynamically reflect "
            "everything in the registry, so adding a fifth strategy is a "
            "single-file change.",
            "<b>Two DB drivers on purpose.</b> asyncpg for the request path "
            "(non-blocking, anyio-friendly), psycopg2 for the background "
            "task path (no asyncio entanglement). Different runtimes, "
            "different requirements.",
            "<b>Per-metric RAGAS isolation.</b> One <code>evaluate()</code> "
            "call per metric so a single failing metric does not abort the "
            "run. NaN persists as <code>'NaN'::float8</code> in Postgres "
            "and serialises as null over JSON.",
            "<b>Fingerprint + IP composite for rate limiting.</b> "
            "Defeats both evasion patterns (clear site data, switch IP).",
            "<b>Per-day key with composite primary key.</b> Rolling reset "
            "at midnight UTC without a scheduled cleanup job.",
            "<b>Streaming results.</b> Frontend polls each run_id "
            "independently and the dashboard updates as each completes - "
            "no waiting for the slowest one.",
            "<b>Compression as orthogonal axis.</b> Not a fifth strategy. "
            "Toggle independent of strategy choice. Combinable with any of "
            "the four.",
        ]),

        h(2, "12.4 Things to bring up unprompted"),
        *bullets([
            "<b>Cold-boot tolerance.</b> 300s healthcheck on Railway, "
            "<code>IF NOT EXISTS</code> on every DDL so create_tables is "
            "idempotent across cold boots, no in-memory state on the "
            "backend at all.",
            "<b>Security posture.</b> CORS allow-list (no wildcard), "
            "<code>hmac.compare_digest</code> for dev token, BYOK never "
            "touches backend, fingerprint hashed before storage, no "
            "plaintext PII anywhere.",
            "<b>Cost discipline.</b> One LLM call per chunk in compression, "
            "one in HyDE, one for multi-query rewordings; embeddings cached "
            "in Postgres so re-uploads short-circuit on the hash.",
            "<b>Frontend extension story.</b> Every parameter form is "
            "generated from the backend <code>param_schema</code>, so the "
            "frontend has zero hardcoded knowledge of any strategy. New "
            "strategies render automatically.",
        ]),

        h(2, "12.5 Limitations to acknowledge honestly"),
        *bullets([
            "<b>No streaming generation.</b> The chat surface gets a single "
            "response, not token-by-token streaming. Acceptable for a "
            "measurement tool but not for a production assistant.",
            "<b>No multi-modal support.</b> Text only.",
            "<b>Single embedding model.</b> "
            "<code>text-embedding-3-small</code> only. Adding a second "
            "would be straightforward with the registry pattern but is not "
            "implemented.",
            "<b>RAGAS is itself LLM-judged.</b> The judge (gpt-4o-mini) is "
            "an additional source of variance. For research-grade numbers "
            "you would use a deterministic eval and multiple judge passes.",
            "<b>No ground-truth eval.</b> context_precision is replaced by "
            "context_utilization because no reference answers are collected. "
            "A future version could let users upload a Q&amp;A set for "
            "ground-truth scoring.",
        ]),

        h(2, "12.6 If they ask you to extend it on the whiteboard"),
        p(
            "<b>Add a fifth retrieval strategy.</b> One file. Subclass "
            "<code>BaseRetriever</code>, set <code>name</code>, "
            "<code>display_name</code>, <code>description</code>, "
            "<code>param_schema</code>. Implement async "
            "<code>retrieve(query, top_k)</code>. Decorate with "
            "<code>@register</code>. Add an import line to "
            "<code>backend/retrieval/registry.py</code>. The API and the "
            "frontend pick it up automatically. Write one or two tests in "
            "<code>tests/</code>."
        ),
        p(
            "<b>Add a second LLM provider for BYOK.</b> Same pattern in "
            "<code>backend/llm/</code>. Implement both async and sync "
            "variants of <code>complete()</code> and "
            "<code>embed()</code>. The frontend BYOK drawer needs an "
            "entry in <code>MODEL_OPTIONS</code> for the new provider."
        ),
        p(
            "<b>Add a new metric.</b> Add it to <code>metric_defs</code> in "
            "<code>_run_ragas</code>. Add a column to "
            "<code>benchmark_runs</code> via "
            "<code>ALTER TABLE ... ADD COLUMN IF NOT EXISTS</code> in "
            "<code>create_tables()</code>. Update the UPDATE statement in "
            "<code>_run_evaluation_async</code> to include the new column. "
            "Update the radar / score-card components on the frontend."
        ),

        Spacer(1, 0.4 * inch),
        p(
            "<b>End of manual.</b> Re-read Section 5.4 the day before any "
            "deploy. Re-read Section 12 the day before any interview.",
            "Body",
        ),
    ]


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = RagscopeDoc(str(OUTPUT))
    story: list = []
    story += cover_page()
    story += table_of_contents()
    story += section_1_introduction()
    story += section_2_background()
    story += section_3_features()
    story += section_4_usecases()
    story += section_5_architecture()
    story += section_6_components()
    story += section_7_walkthrough()
    story += section_8_libraries()
    story += section_9_connections()
    story += section_10_troubleshooting()
    story += section_11_runbook()
    story += section_12_interview()
    doc.build(story)
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"wrote {OUTPUT} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    build()
