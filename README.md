# decision-lite

[中文文档](README.zh-CN.md)

A Jev-compatible decision layer, as an MCP server — backed by a pluggable model instead of TypeSafe's proprietary one.

TypeSafe's Jev is a "System One" model: it answers typed questions (`noul` / `choice` / `score`) with probability distributions and confidence, in ~100ms, for routing / escalation / gating. It is closed-source, waitlist-only, and priced per call. **decision-lite reproduces the public contract and the workflow — not the model.**

## Backends

| `DECISION_BACKEND` | engine | cost | confidence source |
|---|---|---|---|
| `needle` **(default)** | [cactus-needle](https://github.com/cactus-compute/needle) — Needle 3, 121M local model, ~30MB engine, fully offline after first download | **free** | learned calibrated head (real score, not margin) |
| `laya` | [Laya](https://github.com/convaiinnovations/laya) — non-autoregressive decision model; one forward pass scores all options, multilingual checkpoint reads CJK | **free** (local; ~643MB multilingual checkpoint, torch CPU) | real per-option distribution + temperature-scaled `answer_confidence` |
| `openai` | any OpenAI-compatible chat endpoint — GLM-5.3-Flash (~¥0.5/M), DeepSeek, Ollama | provider-priced | verbalized opinion, vote frequency, or token logprobs |

## What it does / does not do

| | |
|---|---|
| ✅ Same request/response contract as Jev | `state` + typed `questions` → `answers` with probabilities + confidence |
| ✅ Pluggable backends | local Needle 3 by default; any OpenAI-compatible endpoint via `DECISION_BACKEND=openai` |
| ✅ Three OpenAI modes | `verbalized` (stated distribution) / `sampling` (empirical votes) / `logprobs` (first-token option probabilities when supported) |
| ✅ Calibration tracking | every decision is logged; attach ground truth later; `decision_stats` reports confidence vs observed accuracy |
| ❌ Not a reproduction of Jev's internals | Jev's architecture is unpublished. No public paper, weights, or training details exist. decision-lite does not claim otherwise. |
| ❌ Not calibrated out of the box | Needle's confidence is a learned head (English-calibrated; measured unreliable on non-English). OpenAI-mode probabilities are the model's *opinion*. Calibration is earned through logged outcomes — same as Jev, except Jev's refit is inside their black box. |

## Contract

```jsonc
// request
{
  "state": "customer email text or a JSON object",
  "questions": {
    "is_urgent":  { "type": "noul",   "instructions": "needs reply within 1h?",
                    "criteria": { "true": "yes", "false": "no" } },
    "department": { "type": "choice", "instructions": "route to which team",
                    "criteria": { "billing": "invoices/refunds", "technical": "bugs/how-to" } },
    "risk_level": { "type": "score",  "instructions": "customer anger level",
                    "criteria": ["calm", "frustrated", "very angry"] }
  }
}
```

```jsonc
// response
{
  "model": "glm-5.3-flash",
  "mode": "verbalized",
  "decision_id": "…uuid…",
  "answers": {
    "is_urgent":  { "type": "noul", "noul": 0.95,
                    "confidence": 0.9, "probabilities": { "true": 0.95, "false": 0.05 } },
    "department": { "type": "choice", "choice": "billing", "confidence": 0.74,
                    "probabilities": { "billing": 0.87, "technical": 0.13 } },
    "risk_level": { "type": "score", "score": 1.04, "confidence": 0.92,
                    "legend": { "0": "calm", "1": "frustrated", "2": "very angry" },
                    "probabilities": { "0": 0, "1": 0.96, "2": 0.04 } }
  },
  "usage": { "prompt_tokens": 412, "completion_tokens": 68 }
}
```

**Confidence is a margin, not a correctness probability** — same semantics as Jev:
`noul` → `|p − 0.5| × 2`; `choice`/`score` → top-1 minus top-2 probability. A confident wrong answer is still wrong; that's why `record_outcome` exists.

## Modes

### needle backend (default) — free, local, calibrated head
Each question is posed to a persistent [cactus-needle](https://github.com/cactus-compute/needle) bridge process as a single-tool call; Needle's byte-level grammar constrains the `answer` argument to the enum, and its learned head returns `confidence`. One ~121M model in ~30MB RAM, zero API cost.

Caveats discovered by probing (worth knowing):
- **Judgment calls land in `suppressed_calls`**: Needle's grounding gate withholds calls whose arguments aren't literal text spans — i.e. nearly every noul/choice/score judgment. decision-lite still uses the suppressed answer (flagged `meta.suppressed: true`); the reported confidence is the real head score.
- **Distribution is synthesized**: Needle returns top-answer + scalar confidence, not a distribution. decision-lite sets `P(chosen) = max(c, 1/n)` and spreads the rest — enough for ranking and gating, not a true posterior.
- **Non-English input**: Cactus measured correct non-English calls at confidence 0.0. For any non-ASCII state or question, Needle answers include `meta.confidence_unreliable: true`; the confidence is still returned but should not be trusted. For Chinese states prefer `DECISION_BACKEND=openai`.
- First run downloads the engine from Hugging Face (~30MB). Set `HF_ENDPOINT=https://hf-mirror.com` if huggingface.co is unreachable. `DECISION_NEEDLE_GENERATION=2` selects the older 45M model.

### laya backend — trained decision model, multilingual
`DECISION_BACKEND=laya` spawns `python/laya_bridge.py` (same JSONL pattern as the needle bridge) wrapping [`laya`](https://pypi.org/project/laya/)'s `Router`. Unlike every other backend, laya returns a **real per-option probability distribution** — a ModernBERT encoder places a `[MASK]` per option and scores them all in one forward pass — plus `answer_confidence` (max-p, the temperature-scaled quantity laya calibrates against) alongside an entropy-based confidence. The `multilingual` checkpoint is selected automatically for non-Latin script (e.g. Chinese states), so unlike needle there is no `confidence_unreliable` caveat for CJK. Requires `pip install laya` (pulls torch; ~2.5GB) and a ~643MB checkpoint download on first use. `DECISION_LAYA_MODEL=english|multilingual` pins a checkpoint instead of script-based routing.

When the runtime selects the laya backend it asks the bridge to preload checkpoints in the background — `Router.preload()` on every registered checkpoint, or just the pinned one — so the first `evaluate` does not pay a cold ~10s-per-checkpoint build. This spawns the python bridge at server start even if `evaluate` is never called; set `DECISION_LAYA_WARMUP=0` to keep lazy loading. Warmup failure is non-fatal (a stderr note, then lazy loading as before).

### openai backend — `verbalized` / `sampling` / `logprobs`
- `verbalized` (default): one call per `evaluate` — model emits JSON probabilities for all questions. Probabilities are **the model's verbalized opinion** — systematically overconfident on weak models.
- `sampling`: `DECISION_SAMPLES` (default 7) independent votes per question at `DECISION_TEMPERATURE` (default 0.8); distribution = observed vote frequency. Invalid samples dropped and reported (`samples.requested/valid/invalid`). Less biased than verbalized, still not calibrated — a confidently-wrong model votes wrong every time.
- `logprobs`: one low-temperature call per question requests `logprobs=true` and `top_logprobs=20`. Choices are mapped to one-token codes (`A`–`T`); returned token log-probabilities are exponentiated and normalized over the valid options, avoiding multi-token option-label bias. This is a genuine next-token distribution over the codes, **not** calibrated correctness probability. It requires an endpoint that returns chat-completion logprobs; Ollama 0.32.9 was verified to do so. If there are more than 20 options or the endpoint omits any option code from its top candidates, decision-lite falls back to sampling and reports `meta.distribution: "sampling_fallback"`. HTTP errors (including unsupported request fields) are surfaced rather than hidden. Qwen3 model names automatically send `reasoning_effort: "none"` so thinking tokens do not consume the short answer budget.

## Setup

```bash
pip install cactus-needle   # default backend (Python >=3.9)
npm install
npm start                   # stdio MCP server
```

### 中文：使用 Ollama 本地 Qwen3

```powershell
ollama pull qwen3:0.6b
$env:DECISION_BACKEND = "openai"
$env:DECISION_BASE_URL = "http://127.0.0.1:11434/v1"
$env:DECISION_MODEL = "qwen3:0.6b"
$env:DECISION_MODE = "logprobs"  # also supports verbalized or sampling
npm start
```

Needle 的非英文 confidence 不可靠；中文输入建议使用上面的 OpenAI-compatible 后端。`logprobs` 一般比多次 sampling 省调用，并避免让小模型自报概率，但只适用于确实返回 `top_logprobs` 的本地服务；需要兼容时可改用 `verbalized`，或用 `sampling` 观察多次回答的一致性。

## Multi-platform MCP and plugin install

Build the portable package, inspect its target catalog, then install only the clients you want:

```powershell
npm run build
node src/cli.mjs list-targets
node src/cli.mjs install --target claude,cursor --scope project --dry-run
node src/cli.mjs install --target claude --scope project
node src/cli.mjs uninstall --target claude --scope project
```

The installer exposes 22 targets: native MCP configs (Claude Code, Codex, OpenCode, Qwen Code, Reasonix, Kilo, WorkBuddy, Devin); skill targets (Trae, pi, OMP, DSH); and Agent Plugin targets (Copilot, Cursor, Kiro, OpenClaw, Hermes, VS Code, ChatGPT/Codex, Grok, NanoClaw, and other compatible clients). Use `--target all --dry-run` to preview every adapter. JSON/TOML configuration edits are key-level merges with backups; unparseable or conflicting user entries are left untouched and reported as manual.

OpenClaw and DSH also have native plugin exports, built from the same runtime as the stdio MCP server. Some GUI/closed clients only support manual registration; the adapter reports that rather than guessing. The package is not yet published on npm (registry lookup currently returns 404): local installs point at the built runtime under `.decision-lite/plugin`; generated `mcp.json` uses `npx -y decision-lite mcp` for use after publication. The installer never stores `DECISION_API_KEY`; add it directly to the host's MCP environment when needed. `uninstall --purge-config` requires `--target all` and removes only decision-lite-marked package files if all adapters report clean removal.

Config is env vars:

| var | default | meaning |
|---|---|---|
| `DECISION_BACKEND` | `needle` | `needle` \| `laya` \| `openai` |
| `DECISION_PYTHON` | `python` | python executable for the needle/laya bridge |
| `DECISION_NEEDLE_GENERATION` | `3` | needle model generation (3=121M, 2=45M) |
| `DECISION_LAYA_MODEL` | auto | pin `english` or `multilingual` laya checkpoint |
| `DECISION_LAYA_WARMUP` | `1` | preload laya checkpoints at server start (`0`/`off` disables) |
| `DECISION_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint (openai backend) |
| `DECISION_API_KEY` | empty | bearer key (omit for local) |
| `DECISION_MODEL` | `qwen3.5-4b` | model name (openai backend) |
| `DECISION_MODE` | `verbalized` | `verbalized` \| `sampling` \| `logprobs` (openai backend) |
| `DECISION_SAMPLES` | `7` | votes per question in sampling mode |
| `DECISION_TEMPERATURE` | `0.8` | sampling temperature |
| `DECISION_LOG` | `./decisions.jsonl` | append-only decision log |

### MCP client config

Any stdio-capable MCP client registers the same way:

```jsonc
// once published on npm
"decision-lite": {
  "command": "npx",
  "args": ["-y", "decision-lite", "mcp"]
}

// from a source checkout — and to pick a backend/model:
"decision-lite": {
  "command": "node",
  "args": ["<path-to-repo>/src/index.mjs"],
  "env": {
    "DECISION_BACKEND": "openai",
    "DECISION_BASE_URL": "https://open.bigmodel.cn/api/paas/v4",
    "DECISION_API_KEY": "your-key",
    "DECISION_MODEL": "glm-5.3-flash",
    "DECISION_MODE": "verbalized"
  }
}
```

### Condition-driven question inputs

An optional `conditions` v1 block makes the policy explicit while preserving the existing Jev answer shape:

```json
{
  "type": "noul",
  "instructions": "Should this be prioritized?",
  "criteria": { "true": "priority required", "false": "normal queue" },
  "conditions": {
    "version": 1,
    "facts": {
      "deadline": {
        "type": "choice",
        "instructions": "Classify the explicitly stated deadline.",
        "criteria": { "within_hour": "within one hour", "later": "later or unstated" }
      }
    },
    "rules": [
      { "id": "near-deadline", "when": [{ "fact": "deadline", "op": "eq", "value": "within_hour" }], "then": "true" }
    ],
    "default": "false"
  }
}
```

Facts reuse `noul`, `choice`, and `score`. Rules are OR by list, AND within each `when` array, and first-match wins. Supported operators are `eq`, `neq`, `in`, `not_in`; numeric comparisons apply to score facts. The default is mandatory and must be a valid output option. This version standardizes the policy sent to the model; it does not locally execute rules or change how confidence/probabilities are produced. No urgency or risk thresholds are built in.

### MCP tools

| tool | input | output |
|---|---|---|
| `evaluate` | `{state, questions}` | Jev-shaped `{answers, usage, decision_id}` |
| `record_outcome` | `{decision_id, outcome, note?}` | `outcome`: `true/false` for all answers, or `{qid: bool}` per answer |
| `decision_stats` | `{}` | confidence buckets vs observed accuracy |

### Condition input v1

To express which facts should lead to an outcome, add an optional `conditions` table to a question. It reuses Jev question types to define facts, then maps fact combinations to one of that question's existing output options:

```json
{
  "type": "noul",
  "instructions": "Should this be prioritized?",
  "criteria": { "true": "priority required", "false": "normal queue" },
  "conditions": {
    "version": 1,
    "facts": {
      "deadline": {
        "type": "choice",
        "instructions": "Classify the explicitly stated deadline.",
        "criteria": { "within_hour": "explicitly within one hour", "later": "later or no deadline" }
      },
      "active_harm": {
        "type": "noul",
        "instructions": "Is financial, account-security, health, or physical harm happening now?",
        "criteria": { "true": "active harm", "false": "no active harm" }
      }
    },
    "rules": [
      { "id": "near-deadline", "when": [{ "fact": "deadline", "op": "eq", "value": "within_hour" }], "then": "true" },
      { "id": "active-harm", "when": [{ "fact": "active_harm", "op": "eq", "value": "true" }], "then": "true" }
    ],
    "default": "false"
  }
}
```

Rules are evaluated in array order; every clause in a rule must match, and the first matching rule wins. Multiple rules express OR. Supported operators are `eq`, `neq`, `in`, `not_in`, and `lt/lte/gt/gte` for score facts. `default` must be one of the question's output options. The configured backend extracts the typed facts, then Decision Lite applies the rules locally. Output probabilities are composed from fact distributions assuming independence; `meta.conditions` records the fact distributions, rule masses, and default mass. If a fact is missing, uniform, or marked confidence-unreliable, the declared default is used. Fact-option combinations are capped at 4096. This makes policy application explicit, but does not calibrate the model's fact extraction or the resulting probabilities. No business thresholds are built in, define them per domain.

Calibration loop: call `evaluate` → get `decision_id` → when ground truth is known, `record_outcome` → `decision_stats` shows whether "confidence 0.9" answers are actually right ~90% of the time. If the gap is large, raise thresholds or switch backend/mode.

### eval harness

`node src/cli.mjs eval --dataset fixtures/eval_zh_triage.json` runs a labeled fixture through the configured backend and reports accuracy, expected calibration error, mean confidence, and latency (mean/p50/p95), plus per-question accuracy. The report carries a dataset hash so two runs are comparable. Baseline on the 10-example Chinese triage fixture with `qwen3:0.6b` + `logprobs`: accuracy 0.43, ECE 0.50, mean confidence 0.94 — a small hand-built set, not a benchmark; use it to compare backends/prompts, not to claim production accuracy.

## Known limits

- **Confidence ≠ correctness.** No backend here is guaranteed calibrated; only logged outcomes tell the truth.
- **Needle's confidence is English-calibrated** — Cactus measured correct non-English calls at 0.0. For Chinese states use the openai backend or ignore the score.
- **Needle is a judgment tool, not a judge of prose** — it picks options reliably but won't explain why. 121M models don't reason; don't ask it multi-factor tradeoffs.
- **Synthesized distribution**: needle mode reports one answer + scalar confidence; the probability spread is constructed, not measured.
- **Sampling mode still isn't calibrated** — it reflects model self-consistency, not real-world accuracy.
- Small/local models may emit garbage that fails parsing; invalid samples are counted and dropped (sampling) or trigger per-question fallback (verbalized).

## Repo layout

```
src/contract.mjs        question validation, distribution normalization, Jev-shaped answers, margin confidence
src/backend.mjs         OpenAI-compatible client; verbalized, sampling, and logprobs modes
src/needle-backend.mjs  Needle 3 backend — spawns python bridge, JSONL protocol
src/laya-backend.mjs    Laya backend — trained decision model, real distributions
src/eval.mjs            eval harness: accuracy/ECE/latency over a JSON fixture
src/runtime.mjs         shared handlers used by MCP, OpenClaw, and DSH
src/installer.mjs       CLI dispatch for 22 target adapters
src/targets.mjs         native MCP, skill, and Agent Plugin installers
python/needle_bridge.py cactus-needle wrapper (one agent per question)
python/laya_bridge.py   laya Router wrapper (auto-routes checkpoints by script)
src/log.mjs             append-only JSONL decision log + calibration stats
src/index.mjs           MCP stdio server
build.mjs               bundles CLI/native plugins and generates identity files
```

`npm test` runs the offline `node:test` suite, including fake-home installer dry-runs and config round trips. It builds the portable plugin package before testing. `node fixtures/e2e_needle.mjs` — real end-to-end with Needle 3 (downloads engine on first run).

## Honest references

- TypeSafe Jev announcement: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev request/response contract: https://developers.cloudflare.com/ai/models/typesafe/jev/ , https://docs.typesafe.ai
- No official Jev paper or reproducible architecture is public as of writing. Third-party RLCD analyses exist but are reverse engineering, not spec.
