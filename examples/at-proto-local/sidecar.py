"""at-proto-local sidecar: one long-lived Laya judge on stdio.

The Core ML bundle is loaded once here — first initialization can take tens of
seconds — and then one JSON request is read per line from stdin, with one JSON
response written per line to stdout. Tokenization and Core ML stay on this side;
the TypeScript driver owns the stream, the routing and the output.

  {"id":1,"op":"count","state":"...","questions":{...}}  -> {"id":1,"counts":{...},"limit":96}
  {"id":2,"op":"predict","state":"...","questions":{...}} -> {"id":2,"answers":{...},...}
  {"op":"stop"}                                            -> exits 0

The ANE bundles are fixed-shape and reject an over-capacity request, so `predict`
counts tokens first and answers `{"error":"capacity"}` without calling the model
when any question overflows. Nothing is silently truncated.
"""

import argparse
import json
import sys
import time
from typing import Any, Dict, Tuple


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def count_tokens(agent: Any, state: Any, questions: Dict[str, Any]) -> Dict[str, int]:
    """Per-question token counts, using the same path the model enforces."""
    items, _ = agent.prepare(state, questions)
    return {qid: len(item["ids"]) for qid, item in zip(questions, items)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Laya judge on stdio")
    parser.add_argument("--model", required=True, help="local bundle directory or Hub id")
    parser.add_argument("--offline", action="store_true", help="refuse Hub access")
    parser.add_argument("--compute-units", default=None)
    args = parser.parse_args()

    import laya_coreml as laya

    started = time.perf_counter()
    agent = laya.load(
        args.model,
        local_files_only=args.offline,
        compute_units=args.compute_units,
    )
    load_ms = (time.perf_counter() - started) * 1000

    # The first forward pass pays the Core ML graph compile; do it before the
    # driver's first real post so its latency is the model's, not the runtime's.
    warmup_started = time.perf_counter()
    agent.system_one(
        "warmup",
        {"warmup": {"type": "noul", "instructions": "Is this text a warmup?"}},
    )
    warmup_ms = (time.perf_counter() - warmup_started) * 1000

    shape = agent.shape
    emit(
        {
            "ready": True,
            "model": args.model,
            "limit": int(shape["max_length"]),
            "batch_size": int(shape["batch_size"]),
            "load_ms": round(load_ms, 1),
            "warmup_ms": round(warmup_ms, 1),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"op": "error", "error": "bad-json", "message": str(error)[:200]})
            continue

        if request.get("op") == "stop":
            return 0

        request_id = request.get("id")
        state, questions = request.get("state"), request.get("questions")
        try:
            counts = count_tokens(agent, state, questions)
        except Exception as error:  # malformed question: the library decides what is valid
            emit({"id": request_id, "error": "prepare", "message": f"{type(error).__name__}: {error}"[:300]})
            continue

        limit = int(agent.shape["max_length"])
        over_capacity = {qid: n for qid, n in counts.items() if n > limit}
        if over_capacity:
            emit({"id": request_id, "error": "capacity", "counts": counts, "limit": limit})
            continue

        if request.get("op") == "count":
            emit({"id": request_id, "counts": counts, "limit": limit})
            continue

        call_started = time.perf_counter()
        try:
            result = agent.system_one(state, questions)
        except Exception as error:
            emit({"id": request_id, "error": "model", "message": f"{type(error).__name__}: {error}"[:300]})
            continue
        elapsed_ms = (time.perf_counter() - call_started) * 1000

        emit(
            {
                "id": request_id,
                "model": result.get("model"),
                "ms": round(elapsed_ms, 2),
                "counts": counts,
                "answers": result.get("answers", {}),
                "usage": result.get("usage", {}),
            }
        )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
