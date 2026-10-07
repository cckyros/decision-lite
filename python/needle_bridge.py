# needle_bridge.py — JSONL bridge between decision-lite (Node) and cactus-needle (Python).
#
# Protocol (one JSON object per line on stdin / stdout):
#   in : {"id": 1, "state": "<text>", "questions": {qid: {type, instructions, criteria, conditions?}}}
#   out: {"id": 1, "answers": {qid: {"answer": opt|null, "confidence": float|null,
#                                  "suppressed": bool}}, "error": str|null}
#
# The model loads once at first request (~30MB engine, fetched from HF on first run;
# set HF_ENDPOINT=https://hf-mirror.com if huggingface.co is unreachable).

import json
import re
import sys

# Force UTF-8 on stdio: on Windows the locale default (e.g. GBK/cp936) would
# misdecode the UTF-8 JSONL Node writes, corrupting non-ASCII state/questions.
for _stream in (sys.stdin, sys.stdout):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

_agent = None
_load_err = None


def _load():
    global _agent, _load_err
    if _agent is not None or _load_err is not None:
        return
    try:
        import needle  # noqa: F401 — import just to confirm availability
        _agent = "ready"  # placeholder; real agent built per-request toolset
    except Exception as e:  # pragma: no cover
        _load_err = f"{type(e).__name__}: {e} — run: pip install cactus-needle"


def _tool_name(qid):
    return "answer_" + re.sub(r"[^A-Za-z0-9_]", "_", str(qid))


def _options(q):
    if q["type"] == "noul":
        return ["true", "false"]
    if q["type"] == "choice":
        return list(q["criteria"].keys())
    return [str(i) for i in range(len(q["criteria"]))]  # score -> level index


def _condition_prompt(q):
    conditions = q.get("conditions")
    if not conditions:
        return ""
    lines = [
        f"Condition policy v{conditions['version']}: first classify the facts, then apply the rules in order.",
        "All clauses in a rule must match. The first matching rule wins.",
        "Do not invent missing facts. If a fact is unclear or no rule matches, use the declared default.",
        "Facts:",
    ]
    for fact_id, fact in conditions["facts"].items():
        options = _options(fact)
        description = fact.get("instructions") or f"classify {fact_id}"
        if fact["type"] == "choice":
            description += "; options: " + "; ".join(f"{key} = {value}" for key, value in fact["criteria"].items())
        elif fact["type"] == "score":
            description += "; levels: " + "; ".join(f"{i} = {value}" for i, value in enumerate(fact["criteria"]))
        else:
            criteria = fact.get("criteria") or {}
            description += f"; true = {criteria.get('true', 'yes')}; false = {criteria.get('false', 'no')}"
        lines.append(f"  {fact_id}: {description} ({', '.join(options)})")
    lines.append("Rules:")
    for index, rule in enumerate(conditions["rules"], 1):
        clauses = " AND ".join(
            f"{clause['fact']} {clause['op']} {json.dumps(clause['value'], ensure_ascii=False)}"
            for clause in rule["when"]
        )
        lines.append(f"  {index}. {rule['id']}: IF {clauses} THEN {json.dumps(rule['then'], ensure_ascii=False)}")
    lines.append(f"Default outcome: {json.dumps(conditions['default'], ensure_ascii=False)}")
    return "\n".join(lines)


def _tool_schema(qid, q):
    opts = _options(q)
    desc = q.get("instructions") or f"Answer question {qid}"
    if q["type"] == "choice":
        desc += " Options: " + "; ".join(f"{k} = {v}" for k, v in q["criteria"].items())
    elif q["type"] == "score":
        desc += " Ordered levels: " + "; ".join(
            f"{i} = {v}" for i, v in enumerate(q["criteria"]))
    elif q["type"] == "noul" and isinstance(q.get("criteria"), dict):
        c = q["criteria"]
        if c.get("true") or c.get("false"):
            desc += f" (true: {c.get('true', 'yes')}; false: {c.get('false', 'no')})"
    if q.get("conditions"):
        conditions = q["conditions"]
        desc += f" Condition policy v{conditions['version']}: ordered first-match rules; default={conditions['default']}"
    return {
        "name": _tool_name(qid),
        "description": desc,
        "parameters": {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "enum": opts,
                           "description": "the chosen option"},
            },
            "required": ["answer"],
        },
    }


def handle(req):
    _load()
    if _load_err:
        return {"id": req.get("id"), "error": _load_err, "answers": {}}

    import needle

    questions = req["questions"]
    state = req["state"]
    if not isinstance(state, str):
        state = json.dumps(state, ensure_ascii=False)

    answers = {}
    for qid, q in questions.items():
        # one agent per question: Needle is trained for utterance->tool-call,
        # a multi-tool "answer everything" prompt confuses a 121M model
        tool = _tool_schema(qid, q)
        agent = needle.Needle(tools=[tool], system=req.get("system"),
                              generation=req.get("generation", 3))
        prompt = f"{state}\n\n{q.get('instructions') or 'answer the question'}"
        condition_prompt = _condition_prompt(q)
        if condition_prompt:
            prompt += f"\n\n{condition_prompt}"
        resp = agent.complete(prompt)

        entry = {"answer": None, "confidence": None, "suppressed": False}
        for call in resp.get("function_calls") or []:
            if call.get("name") == tool["name"]:
                entry["answer"] = str((call.get("arguments") or {}).get("answer", ""))
                entry["confidence"] = resp.get("confidence")
                break
        for call in resp.get("suppressed_calls") or []:
            if call.get("name") == tool["name"]:
                entry["answer"] = str((call.get("arguments") or {}).get("answer", ""))
                entry["confidence"] = resp.get("confidence")
                entry["suppressed"] = True
                break
        answers[qid] = entry

    return {"id": req.get("id"), "answers": answers}


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
