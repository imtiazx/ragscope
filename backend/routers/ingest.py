"""
Ingest router for RAGScope.

Handles POST /ingest: accepts one or more uploaded files, extracts text,
chunks, embeds, and stores the resulting corpus in the database. Returns a
corpus_hash that the client passes to POST /benchmark to run evaluations.

Design decisions:
- Files are hashed before any processing so duplicate uploads are detected
  cheaply without re-running the entire pipeline.
- Embeddings for all chunks are computed concurrently via asyncio.gather so
  the wall-clock cost scales with the slowest single embed call rather than
  with the total number of chunks.
- The chunker strategy and its parameters are accepted as Form fields
  alongside the file uploads so a single multipart request carries
  everything needed to build the corpus.
"""

import asyncio
import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from backend.chunkers.registry import registry as chunker_registry
from backend.core.config import settings
from backend.core.database import corpus_exists, get_chunk_count, store_chunks
from backend.ingest.registry import registry as ingest_registry
from backend.llm.openai_provider import OpenAIProvider

router = APIRouter()

# Map lowercase file extensions to ingest registry keys.
# The ingest registry uses short names ("pdf", "txt"); file extensions
# include the dot and may arrive in any case from the browser.
_EXT_TO_INGESTOR: dict[str, str] = {
    ".pdf": "pdf",
    ".txt": "txt",
}


@router.post("/ingest")
async def ingest_files(
    files: list[UploadFile] = File(...),
    chunker_strategy: str = Form(default="fixed_size"),
    chunker_params: str = Form(default="{}"),
) -> JSONResponse:
    """
    Ingest one or more files, chunk and embed the text, store the corpus.

    Accepts a multipart form with one or more file uploads and optional
    chunker configuration. Files are processed in filename-sorted order so
    the corpus_hash is deterministic regardless of upload order.

    Parameters
    ----------
    files : list[UploadFile]
        One or more .pdf or .txt files to ingest.
    chunker_strategy : str
        Registry key of the chunker to use (default: "fixed_size").
    chunker_params : str
        JSON-encoded dict of parameters forwarded to the chunker constructor.
        Must match the keys in the chunker's param_schema. Default: "{}".

    Returns
    -------
    JSONResponse
        201 with {"corpus_hash": str, "chunk_count": int} on new corpus.
        200 with {"corpus_hash": str, "chunk_count": int} on duplicate upload.

    Raises
    ------
    HTTPException 413
        If the combined size of all uploaded files exceeds MAX_FILE_SIZE_BYTES.
    HTTPException 400
        If chunker_strategy is not in the chunker registry.
    HTTPException 422
        If any uploaded file has an unsupported extension, or if
        chunker_params is not valid JSON, or if no text was extracted.
    """
    # --- Step 1: read all file bytes into memory ---
    # Reading everything first lets us check the combined size and compute the
    # hash before doing any expensive processing.
    file_data: list[tuple[str, bytes]] = []
    for upload in files:
        data = await upload.read()
        file_data.append((upload.filename or "", data))

    # --- Step 2: enforce combined size limit ---
    total_bytes = sum(len(data) for _, data in file_data)
    if total_bytes > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Combined upload size {total_bytes:,} bytes exceeds the "
                f"{settings.max_file_size_bytes:,} byte limit."
            ),
        )

    # --- Step 3: compute corpus_hash from sorted file bytes ---
    # Sorting by filename makes the hash independent of upload order:
    # uploading doc1.pdf then doc2.txt gives the same hash as the reverse.
    file_data.sort(key=lambda pair: pair[0])
    combined_bytes = b"".join(data for _, data in file_data)
    corpus_hash = hashlib.sha256(combined_bytes).hexdigest()

    # --- Step 4: early return if this corpus was already ingested ---
    if await corpus_exists(corpus_hash):
        count = await get_chunk_count(corpus_hash)
        return JSONResponse(
            status_code=200,
            content={"corpus_hash": corpus_hash, "chunk_count": count},
        )

    # --- Step 5: validate and parse chunker params ---
    if chunker_strategy not in chunker_registry:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown chunker strategy {chunker_strategy!r}. "
                f"Available: {sorted(chunker_registry.keys())}"
            ),
        )
    try:
        params_dict: dict = json.loads(chunker_params)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=422, detail=f"chunker_params is not valid JSON: {exc}"
        )

    # --- Step 6: extract text from each file with the appropriate ingestor ---
    all_texts: list[str] = []
    for filename, data in file_data:
        ext = Path(filename).suffix.lower()
        ingestor_key = _EXT_TO_INGESTOR.get(ext)
        if ingestor_key is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Unsupported file type {ext!r} for file {filename!r}. "
                    f"Supported extensions: {sorted(_EXT_TO_INGESTOR.keys())}"
                ),
            )
        ingestor = ingest_registry[ingestor_key]()
        texts = await ingestor.ingest(data)
        all_texts.extend(texts)

    # --- Step 7: split text into chunks ---
    # Exclude llm_provider from params_dict since that is an internal
    # dependency-injection key, not a user-facing parameter.
    safe_params = {k: v for k, v in params_dict.items() if k != "llm_provider"}
    chunker = chunker_registry[chunker_strategy](**safe_params)
    all_chunks: list[str] = await chunker.chunk(all_texts)

    if not all_chunks:
        raise HTTPException(
            status_code=422,
            detail="No text could be extracted from the uploaded files.",
        )

    # --- Step 8: embed all chunks concurrently ---
    # asyncio.gather fires all embed() coroutines at the same time. For 200
    # chunks, this is ~200x faster than awaiting them one by one because
    # the HTTP calls to OpenAI happen in parallel rather than in sequence.
    provider = OpenAIProvider()
    embeddings: list[list[float]] = await asyncio.gather(
        *[provider.embed(chunk) for chunk in all_chunks]
    )

    # --- Step 9: persist to database ---
    await store_chunks(corpus_hash, list(zip(all_chunks, embeddings)))

    return JSONResponse(
        status_code=201,
        content={"corpus_hash": corpus_hash, "chunk_count": len(all_chunks)},
    )
