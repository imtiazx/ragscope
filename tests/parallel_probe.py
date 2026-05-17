"""
Parallel probe for the Railway production backend.

Drives a single multi-strategy benchmark request against the live RAGScope
backend and verifies that all four retrieval strategies complete with
non-null RAGAS metrics under parallel load. This is the Session I smoke
test that confirms the Railway migration preserved the per-metric
isolation behaviour from the local environment.

Flow:
  1. Ingest a tiny plain text corpus via POST /ingest.
  2. Submit one POST /benchmark request listing all four strategies
     (naive, hyde, multiquery, hybrid) with default params.
  3. Poll GET /results/{run_id} for every returned run_id in parallel
     until each one reaches a terminal status (completed or failed) or
     the overall 10 minute timeout fires.
  4. Print a result table and assert:
       - every run reached completed (not failed)
       - at least two of the three RAGAS metrics are non-null per run
  5. Exit 0 on success, 1 on any assertion failure.

The probe runs as a one-shot script, not a pytest test, because it talks
to a live remote service and is gated by Railway's free-tier rate limits.
"""

from __future__ import annotations

import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import requests


BACKEND_URL = "https://ragscope-backend-production.up.railway.app"
STRATEGIES = ["naive", "hyde", "multiquery", "hybrid"]
POLL_INTERVAL_SECONDS = 5
TOTAL_TIMEOUT_SECONDS = 600

CORPUS_TEXT = (
    "Water is a chemical compound made of two hydrogen atoms and one "
    "oxygen atom. At standard atmospheric pressure water freezes at zero "
    "degrees Celsius and boils at one hundred degrees Celsius. Water "
    "covers about seventy one percent of the surface of the Earth. The "
    "chemical formula for water is H2O.\n"
)
QUESTION = "At what temperature does water boil at standard atmospheric pressure?"


def ingest_corpus() -> str:
    """
    Upload the test corpus and return the corpus_hash.

    Posts a single in-memory .txt file to POST /ingest using the multipart
    format the ingest router expects. Returns the corpus_hash from the
    response, which the benchmark request needs.

    Returns
    -------
    str
        The corpus_hash returned by the backend.

    Raises
    ------
    RuntimeError
        If the backend returns a non 2xx response or the body has no
        corpus_hash field.
    """
    print(f"[probe] POST {BACKEND_URL}/ingest")
    files = {
        "files": ("water.txt", io.BytesIO(CORPUS_TEXT.encode("utf-8")), "text/plain"),
    }
    data = {
        "chunker_strategy": "fixed_size",
        "chunker_params": "{}",
    }
    resp = requests.post(
        f"{BACKEND_URL}/ingest", files=files, data=data, timeout=60
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"ingest failed: HTTP {resp.status_code} body={resp.text[:500]}"
        )
    body = resp.json()
    corpus_hash = body.get("corpus_hash")
    if not corpus_hash:
        raise RuntimeError(f"ingest response missing corpus_hash: {body!r}")
    print(
        f"[probe] ingest ok corpus_hash={corpus_hash[:12]}... "
        f"chunk_count={body.get('chunk_count')}"
    )
    return corpus_hash


def submit_benchmark(corpus_hash: str) -> list[str]:
    """
    Submit a single multi-strategy benchmark request and return the run_ids.

    Sends one POST /benchmark with all four strategies in the strategies
    list so the backend kicks off four parallel background tasks. Uses
    default retrieval params and no compression for every strategy.

    Parameters
    ----------
    corpus_hash : str
        The corpus_hash returned by ingest_corpus.

    Returns
    -------
    list[str]
        Run IDs returned by the backend, one per strategy, in the same
        order as STRATEGIES.

    Raises
    ------
    RuntimeError
        If the backend returns a non 2xx response or the body does not
        contain exactly the expected number of run_ids.
    """
    print(f"[probe] POST {BACKEND_URL}/benchmark strategies={STRATEGIES}")
    payload = {
        "corpus_hash": corpus_hash,
        "question": QUESTION,
        "chunker_strategy": "fixed_size",
        "chunker_params": {},
        "strategies": [
            {
                "strategy": s,
                "retrieval_params": {},
                "compression_enabled": False,
                "compression_params": {},
            }
            for s in STRATEGIES
        ],
    }
    resp = requests.post(f"{BACKEND_URL}/benchmark", json=payload, timeout=60)
    if resp.status_code != 202:
        raise RuntimeError(
            f"benchmark failed: HTTP {resp.status_code} body={resp.text[:500]}"
        )
    body = resp.json()
    run_ids = body.get("run_ids", [])
    if len(run_ids) != len(STRATEGIES):
        raise RuntimeError(
            f"expected {len(STRATEGIES)} run_ids, got {len(run_ids)}: {body!r}"
        )
    print(f"[probe] benchmark accepted run_ids={[r[:8] for r in run_ids]}")
    return run_ids


def poll_single(run_id: str, deadline: float) -> dict[str, Any]:
    """
    Poll GET /results/{run_id} until the run reaches a terminal status.

    Blocks the calling thread, sleeping POLL_INTERVAL_SECONDS between
    requests, until status is 'completed' or 'failed' or the deadline
    passes. Used by the ThreadPoolExecutor to poll all four runs in
    parallel.

    Parameters
    ----------
    run_id : str
        UUID string of the benchmark run to poll.
    deadline : float
        Wall-clock time.monotonic() value past which the poll loop gives
        up and returns whatever the last response was.

    Returns
    -------
    dict[str, Any]
        The final GET /results/{run_id} response body. If the polling
        loop times out, the body will still carry a non-terminal status,
        which the caller treats as a failure.
    """
    last_body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            resp = requests.get(
                f"{BACKEND_URL}/results/{run_id}", timeout=30
            )
            if resp.status_code == 200:
                last_body = resp.json()
                status = last_body.get("status")
                if status in ("completed", "failed"):
                    return last_body
        except requests.RequestException as exc:
            # Transient network errors should not abort the poll loop;
            # log and retry on the next tick. A permanently broken backend
            # will be caught by the overall deadline.
            print(f"[probe] poll {run_id[:8]} transient error: {exc}")
        time.sleep(POLL_INTERVAL_SECONDS)
    # Timed out: caller will see a non-terminal status and treat it as fail.
    return last_body or {"id": run_id, "status": "timeout"}


def poll_all(run_ids: list[str]) -> dict[str, dict[str, Any]]:
    """
    Poll every run_id in parallel and return a {run_id: final_row} dict.

    Uses a ThreadPoolExecutor sized to the number of run_ids so each run
    is polled on its own thread. Returns once every run has reached a
    terminal status or the global deadline has passed.

    Parameters
    ----------
    run_ids : list[str]
        Run IDs returned by submit_benchmark.

    Returns
    -------
    dict[str, dict[str, Any]]
        Mapping of run_id to the final GET /results/{run_id} response.
    """
    print(
        f"[probe] polling {len(run_ids)} runs in parallel, "
        f"timeout {TOTAL_TIMEOUT_SECONDS}s"
    )
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    results: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(run_ids)) as pool:
        future_to_run = {
            pool.submit(poll_single, run_id, deadline): run_id
            for run_id in run_ids
        }
        for future in as_completed(future_to_run):
            run_id = future_to_run[future]
            results[run_id] = future.result()
            status = results[run_id].get("status")
            strategy = results[run_id].get("retrieval_strategy", "?")
            print(f"[probe] run {run_id[:8]} ({strategy}) reached status={status}")
    return results


def fmt(value: Any) -> str:
    """
    Render a metric value as a fixed-width string for the result table.

    Floats are formatted to four decimal places, None is rendered as the
    literal string "null", and any other value is passed through str().

    Parameters
    ----------
    value : Any
        The cell value to render.

    Returns
    -------
    str
        Padded representation suitable for the result table.
    """
    if value is None:
        return "null"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def print_table(results: dict[str, dict[str, Any]]) -> None:
    """
    Print a fixed-width result table to stdout.

    Columns: strategy, status, faithfulness, context_utilization,
    answer_relevancy, latency_ms. One row per benchmark run, sorted by
    the canonical strategy order in STRATEGIES so the output is stable.

    Parameters
    ----------
    results : dict[str, dict[str, Any]]
        Mapping from run_id to the final GET /results/{run_id} body.
    """
    header = (
        f"{'strategy':<12} {'status':<10} {'faithfulness':<14} "
        f"{'ctx_util':<10} {'ans_rel':<10} {'latency_ms':<12}"
    )
    print()
    print(header)
    print("-" * len(header))
    by_strategy = {
        row.get("retrieval_strategy"): row for row in results.values()
    }
    for strategy in STRATEGIES:
        row = by_strategy.get(strategy, {})
        print(
            f"{strategy:<12} {fmt(row.get('status')):<10} "
            f"{fmt(row.get('faithfulness')):<14} "
            f"{fmt(row.get('context_utilization')):<10} "
            f"{fmt(row.get('answer_relevancy')):<10} "
            f"{fmt(row.get('latency_ms')):<12}"
        )
    print()


def assert_results(results: dict[str, dict[str, Any]]) -> bool:
    """
    Apply the Session I pass criteria to the polled results.

    Pass criteria:
      - every run reached status 'completed' (not 'failed' or 'timeout')
      - at least two of the three RAGAS metrics are non-null per run

    Prints a per-strategy PASS/FAIL line for each criterion so the
    transcript captures exactly which case failed.

    Parameters
    ----------
    results : dict[str, dict[str, Any]]
        Mapping from run_id to the final GET /results/{run_id} body.

    Returns
    -------
    bool
        True if every assertion held, False if any failed.
    """
    all_ok = True
    by_strategy = {
        row.get("retrieval_strategy"): row for row in results.values()
    }
    for strategy in STRATEGIES:
        row = by_strategy.get(strategy)
        if row is None:
            print(f"[assert] {strategy}: FAIL - no row returned")
            all_ok = False
            continue
        status = row.get("status")
        if status != "completed":
            print(
                f"[assert] {strategy}: FAIL status={status} "
                f"error_message={row.get('error_message')!r}"
            )
            all_ok = False
            continue
        metrics = [
            row.get("faithfulness"),
            row.get("context_utilization"),
            row.get("answer_relevancy"),
        ]
        non_null = sum(1 for m in metrics if m is not None)
        if non_null < 2:
            print(
                f"[assert] {strategy}: FAIL only {non_null}/3 metrics non-null"
            )
            all_ok = False
        else:
            print(
                f"[assert] {strategy}: PASS status=completed "
                f"non_null_metrics={non_null}/3"
            )
    return all_ok


def main() -> int:
    """
    Drive the full ingest plus benchmark plus poll plus assert flow.

    Returns
    -------
    int
        0 on success, 1 on failure. Used as the process exit code.
    """
    try:
        corpus_hash = ingest_corpus()
        run_ids = submit_benchmark(corpus_hash)
        results = poll_all(run_ids)
    except Exception as exc:
        print(f"[probe] FATAL: {type(exc).__name__}: {exc}")
        return 1

    print_table(results)
    ok = assert_results(results)
    print(f"[probe] OVERALL: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
