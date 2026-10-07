# laya_bridge.py — JSONL bridge between decision-lite (Node) and laya (Python).
#
# Protocol (one JSON object per line on stdin / stdout):
#   in : {"id": 1, "state": "<text>", "questions": {qid: {type, instructions, criteria}},
#         "model": "english"|"multilingual"|null}
#   out: {"id": 1, "answers": {qid: {"answer": opt|null, "confidence": float,
#                                  "probabilities": {opt: p}, "answer_confidence": float}},
#         "routing": {...}, "error": str|null}
#
# Unlike needle, laya returns a real per-option probability distribution (one
# forward pass scores every [MASK] slot), so no distribution synthesis is needed.
# The Router picks checkpoints by script detection; `model` forces one.
# Checkpoints download from HF on first use (~hundreds of MB);
# set HF_ENDPOINT=https://hf-mirror.com if huggingface.co is unreachable.

import json
import sys

# Force UTF-8 on stdio: on Windows the locale default (e.g. GBK/cp936) would
# misdecode the UTF-8 JSONL Node writes, corrupting non-ASCII state/questions.
for _stream in (sys.stdin, sys.stdout):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

_router = None
_load_err = None


def _load():
    global _router, _load_err
    if _router is not None or _load_err is not None:
        return
    try:
        from laya import Router
        _router = Router()
    except Exception as e:  # pragma: no cover
        _load_err = f"{type(e).__name__}: {e} — run: pip install laya"


def handle(req):
    _load()
    if _load_err:
        return {"id": req.get("id"), "error": _load_err, "answers": {}}

    if req.get("warmup"):
        # Preload checkpoints so no real predict pays a cold build (~10s each).
        # `model` pins one checkpoint; absent means every registered checkpoint,
        # mirroring laya's serve.py default. Load one at a time: a checkpoint
        # that cannot download must not stop the others from warming.
        names = [req["model"]] if req.get("model") else [
            n for n, source in _router.models.items() if source is not None]
        warmed, failed = [], {}
        for n in names:
            try:
                key = _router.resolve(n)
                _router.load(key)
                warmed.append(key)
            except Exception as e:
                failed[n] = f"{type(e).__name__}: {e}"
        out = {"id": req.get("id"), "warmed": warmed,
               "error": None if warmed else (next(iter(failed.values()), "no checkpoints to warm"))}
        if failed and warmed:
            out["errors"] = failed
        return out

    questions = req["questions"]
    state = req["state"]
    if not isinstance(state, str):
        state = json.dumps(state, ensure_ascii=False)

    kwargs = {}
    if req.get("model"):
        kwargs["model"] = req["model"]
    result = _router.predict(state, questions, **kwargs)

    out = {"id": req.get("id"), "answers": {}}
    if isinstance(result, dict) and result.get("routing"):
        out["routing"] = result["routing"]
    for qid, answer in (result.get("answers") or {}).items():
        entry = {"answer": None, "confidence": None, "probabilities": None}
        if answer.get("type") == "noul":
            p_true = answer.get("noul")
            if p_true is not None:
                entry["answer"] = "true" if float(p_true) >= 0.5 else "false"
                entry["probabilities"] = {"true": float(p_true), "false": 1.0 - float(p_true)}
        elif answer.get("type") == "choice":
            entry["answer"] = answer.get("choice")
            entry["probabilities"] = answer.get("probabilities")
        elif answer.get("type") == "score":
            probs = answer.get("probabilities")
            entry["probabilities"] = probs
            if probs:
                entry["answer"] = str(max(probs.items(), key=lambda kv: float(kv[1]))[0])
                entry["expected"] = answer.get("score")
        # answer_confidence = max(p): the calibrated, gateable quantity laya fits
        # temperatures against; `confidence` is normalized entropy on a different scale.
        entry["answer_confidence"] = answer.get("answer_confidence")
        entry["entropy_confidence"] = answer.get("confidence")
        out["answers"][qid] = entry
    return out


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id") if isinstance(req, dict) else None
            out = handle(req)
        except Exception as e:
            out = {"id": req_id, "error": f"{type(e).__name__}: {e}", "answers": {}}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
