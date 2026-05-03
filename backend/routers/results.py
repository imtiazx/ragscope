"""
Results router for RAGScope.

Handles GET /results/{run_id}: the polling endpoint the frontend calls
repeatedly after POST /benchmark returns a run_id. Returns the full
benchmark_runs row so the frontend can inspect status and, once status
is 'completed', render the metric scores and retrieved chunks.

The frontend polls this endpoint every few seconds. When status transitions
from 'running' to 'completed' or 'failed', the frontend stops polling and
renders the final state.
"""

from fastapi import APIRouter, HTTPException

from backend.eval.ragas_runner import get_run

router = APIRouter()


@router.get("/results/{run_id}")
async def get_results(run_id: str) -> dict:
    """
    Return the current state of a benchmark run.

    Called by the frontend on each poll cycle. The run progresses through
    status values: pending -> running -> completed (or failed). The frontend
    should keep polling until status is 'completed' or 'failed'.

    Parameters
    ----------
    run_id : str
        UUID string of the benchmark run, as returned by POST /benchmark.

    Returns
    -------
    dict
        Full benchmark_runs row with all columns. While status is 'pending'
        or 'running', metric columns (faithfulness, context_utilization,
        answer_relevancy) will be None. Once 'completed' they carry scores
        between 0.0 and 1.0.

    Raises
    ------
    HTTPException 404
        If no run with the given run_id exists. This can happen if the
        client polls with a stale or invalid run_id.
    """
    run = await get_run(run_id)
    if run is None:
        raise HTTPException(
            status_code=404,
            detail=f"No benchmark run found with id {run_id!r}.",
        )
    return run
