"""
PDF document ingestor for RAGScope.

Handles .pdf uploads by extracting text page by page using the pypdf library.
Returns one string per non-blank page, preserving document order. Blank pages
(those that yield only whitespace after extraction) are silently skipped because
they carry no information for retrieval and would produce empty chunks downstream.

pypdf works with file-like objects, so raw bytes are wrapped in io.BytesIO --
no temporary file is written to disk.
"""

import io

import pypdf

from backend.ingest.base import BaseIngestor, register


@register
class PdfIngestor(BaseIngestor):
    """
    Ingestor for PDF (.pdf) files.

    Uses pypdf.PdfReader to extract text from each page of the document.
    Returns one list element per non-blank page. The chunker layer downstream
    treats each element as an independent text segment to split further.
    """

    name: str = "pdf"
    display_name: str = "PDF"

    async def ingest(self, data: bytes) -> list[str]:
        """
        Extract text from a PDF and return one string per non-blank page.

        Wraps the raw bytes in an in-memory buffer so pypdf never touches
        the filesystem. Pages that produce only whitespace after extraction
        are dropped -- they add no signal for retrieval and would generate
        empty or near-empty chunks.

        Parameters
        ----------
        data : bytes
            Raw binary content of the uploaded .pdf file.

        Returns
        -------
        list[str]
            Extracted text, one element per non-blank page, in document order.
            May be empty if the PDF contains no extractable text (e.g. a
            fully scanned document with no embedded text layer).

        Raises
        ------
        pypdf.errors.PdfReadError
            If the bytes are not a valid PDF or the file is encrypted without
            a password. The caller (ingest router) is responsible for catching
            this and returning a 400 response.
        """
        # io.BytesIO wraps raw bytes in an object that behaves like an open
        # file. pypdf expects a file-like object with .read() and .seek()
        # methods -- BytesIO provides both without writing anything to disk.
        buffer = io.BytesIO(data)
        reader = pypdf.PdfReader(buffer)

        pages = []
        for page in reader.pages:
            # extract_text() returns a str with the text content of the page,
            # or an empty string if the page has no extractable text layer.
            text = page.extract_text()

            # strip() removes leading and trailing whitespace. If the result
            # is an empty string, the page was blank or image-only -- skip it.
            if text and text.strip():
                pages.append(text)

        return pages
