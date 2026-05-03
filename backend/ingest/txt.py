"""
Plain-text document ingestor for RAGScope.

Handles .txt uploads by decoding raw bytes as UTF-8 and returning the entire
document as a single-element list. No parsing library is needed -- plain text
is already the target format. The chunker layer downstream is responsible for
splitting the text into smaller pieces.
"""

from backend.ingest.base import BaseIngestor, register


@register
class TxtIngestor(BaseIngestor):
    """
    Ingestor for plain-text (.txt) files.

    Decodes the uploaded bytes as UTF-8 and returns the full document text
    as a list with one element. Using a list preserves the same interface
    as PdfIngestor, which returns one element per page, so the chunker layer
    never needs to know which ingestor produced its input.
    """

    name: str = "txt"
    display_name: str = "Plain Text"

    async def ingest(self, data: bytes) -> list[str]:
        """
        Decode raw bytes and return the document text as a single-element list.

        Parameters
        ----------
        data : bytes
            Raw binary content of the uploaded .txt file.

        Returns
        -------
        list[str]
            A list containing exactly one string: the full document text.
            Wrapping in a list keeps the return type consistent with other
            ingestors so the chunker layer can iterate the result uniformly.

        Raises
        ------
        UnicodeDecodeError
            If the bytes are not valid UTF-8. The caller (ingest router) is
            responsible for catching this and returning a 400 response.
        """
        # decode() converts bytes to a Python str using the specified encoding.
        # "utf-8" covers the vast majority of plain text files; files in other
        # encodings (latin-1, windows-1252) will raise UnicodeDecodeError here,
        # which is the right behavior -- silent mojibake would corrupt the corpus.
        text = data.decode("utf-8")
        return [text]
