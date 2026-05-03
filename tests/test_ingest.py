"""
Tests for the document ingestor registry and ingestor behaviour.

These tests verify the registry wiring and the text-extraction logic of
TxtIngestor and PdfIngestor without touching the filesystem. All PDFs used
here are built in memory using a helper function and pypdf.PdfWriter so no
test assets need to be checked in to the repository.
"""

import io

import pypdf
import pytest

# Importing registry triggers the side-effect imports in registry.py, which
# runs @register on both TxtIngestor and PdfIngestor and populates the dict.
from backend.ingest.registry import registry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_pdf(*page_texts: str) -> bytes:
    """
    Create a minimal valid multi-page PDF in memory.

    Each positional argument becomes the drawn text content of one page,
    rendered using the built-in Helvetica Type1 font. The PDF is assembled
    by hand so the test suite has no dependency on a PDF-creation library
    beyond pypdf itself.

    Parameters
    ----------
    *page_texts : str
        Text strings to place on successive pages. Pass an empty string to
        produce a page whose content stream draws nothing (useful for testing
        blank-page skipping).

    Returns
    -------
    bytes
        Raw bytes of a valid PDF-1.4 document.
    """
    n = len(page_texts)
    # Object ID layout:
    #   1 = catalog, 2 = pages node
    #   3 .. 2+n = page dictionary objects
    #   3+n .. 2+2n = content stream objects
    #   3+2n = shared Helvetica font
    page_ids = list(range(3, 3 + n))
    cont_ids = list(range(3 + n, 3 + 2 * n))
    font_id = 3 + 2 * n

    def b(s: str) -> bytes:
        # latin-1 covers all printable ASCII; safe for the PDF keywords and
        # the simple test strings we pass in.
        return s.encode("latin-1")

    obj1 = b(f"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n")
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    obj2 = b(f"2 0 obj\n<</Type/Pages/Kids[{kids}]/Count {n}>>\nendobj\n")

    page_objs = []
    for pid, cid in zip(page_ids, cont_ids):
        page_objs.append(b(
            f"{pid} 0 obj\n"
            f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
            f"/Contents {cid} 0 R/Resources<</Font<</F1 {font_id} 0 R>>>>>>\n"
            f"endobj\n"
        ))

    cont_objs = []
    for cid, txt in zip(cont_ids, page_texts):
        # Escape PDF string delimiters so arbitrary text does not break the
        # content stream syntax.
        safe = txt.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = b(f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET")
        cont_objs.append(
            b(f"{cid} 0 obj\n<</Length {len(stream)}>>\nstream\n")
            + stream
            + b"\nendstream\nendobj\n"
        )

    font_obj = b(
        f"{font_id} 0 obj\n"
        f"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n"
    )

    header = b"%PDF-1.4\n"
    parts = [obj1, obj2] + page_objs + cont_objs + [font_obj]
    body = b"".join(parts)

    # Compute the byte offset of every object for the cross-reference table.
    offsets = []
    pos = len(header)
    for part in parts:
        offsets.append(pos)
        pos += len(part)
    xref_pos = pos

    total = 1 + len(parts)  # +1 for the mandatory null entry (object 0)
    xref = b(f"xref\n0 {total}\n") + b"0000000000 65535 f \n"
    for off in offsets:
        # Each xref entry must be exactly 20 bytes: 10-digit offset, space,
        # 5-digit generation, space, status flag, space, newline.
        xref += b(f"{off:010d} 00000 n \n")

    trailer = b(
        f"trailer\n<</Size {total}/Root 1 0 R>>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    )

    return header + body + xref + trailer


# ---------------------------------------------------------------------------
# TxtIngestor tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_txt_ingestor_returns_single_element_list():
    """
    TxtIngestor must wrap the decoded document in a list with exactly one entry.

    A list is the correct return type even for a single-segment document so
    that the chunker layer can always iterate the result uniformly.
    """
    ingestor = registry["txt"]()
    result = await ingestor.ingest(b"hello world")
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0] == "hello world"


@pytest.mark.asyncio
async def test_txt_ingestor_preserves_full_content():
    """
    TxtIngestor must not truncate, strip, or alter the decoded text.

    Whitespace and newlines are meaningful for downstream chunkers that use
    blank lines as paragraph boundaries.
    """
    content = "line one\nline two\nline three"
    ingestor = registry["txt"]()
    result = await ingestor.ingest(content.encode("utf-8"))
    assert result[0] == content


# ---------------------------------------------------------------------------
# PdfIngestor tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pdf_ingestor_returns_one_string_per_non_blank_page():
    """
    PdfIngestor must return exactly one list entry for each page that has
    extractable text, preserving document order.
    """
    data = _build_pdf("first page content", "second page content")
    ingestor = registry["pdf"]()
    result = await ingestor.ingest(data)

    assert len(result) == 2
    assert all(isinstance(s, str) for s in result)
    # pypdf may add whitespace during extraction, so use substring checks.
    assert "first page content" in result[0]
    assert "second page content" in result[1]


@pytest.mark.asyncio
async def test_pdf_ingestor_skips_blank_pages():
    """
    Pages with no extractable text must be silently omitted from the result.

    The test builds a two-page PDF where page 1 has text and page 2 is a
    truly blank page (added via pypdf.PdfWriter.add_blank_page, which creates
    a page with no content stream at all).
    """
    # Build page 1 with text, then merge with a PdfWriter-generated blank page.
    text_pdf = _build_pdf("only this page has text")
    reader = pypdf.PdfReader(io.BytesIO(text_pdf))

    writer = pypdf.PdfWriter()
    writer.add_page(reader.pages[0])
    # add_blank_page creates a page dict with no /Contents key -- pypdf's
    # extract_text() returns "" for it, triggering our skip logic.
    writer.add_blank_page(width=612, height=792)

    buf = io.BytesIO()
    writer.write(buf)
    data = buf.getvalue()

    ingestor = registry["pdf"]()
    result = await ingestor.ingest(data)
    assert len(result) == 1


# ---------------------------------------------------------------------------
# Registry discovery tests
# ---------------------------------------------------------------------------

def test_txt_ingestor_is_registered():
    """The 'txt' key must be present in the ingest registry after import."""
    assert "txt" in registry


def test_pdf_ingestor_is_registered():
    """The 'pdf' key must be present in the ingest registry after import."""
    assert "pdf" in registry
