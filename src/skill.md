<!-- decision-lite:skill -->
# Decision Lite

Use the Decision Lite decision tools to evaluate structured states for routing, urgency, and risk. This is a decision layer, not an open-ended chat tool.

## evaluate

Send `state` plus a `questions` map. Each question uses one of:

- `noul`: yes/no decision; optional criteria `{ "true": "...", "false": "..." }`.
- `choice`: one option from `criteria: { option: description }`.
- `score`: ordered labels in `criteria: ["low", "medium", "high"]`; score is the expected zero-based index.

For conditional decisions, add `conditions: { version: 1, facts, rules, default }` to a question. Each fact is another typed Jev question. Each ordered rule has `when: [{fact, op, value}]` and `then`; clauses inside `when` are AND, the first matching rule wins, and `default` must be one of the question's output options. Use `eq`, `neq`, `in`, `not_in`, or numeric comparisons on score facts. The runtime extracts facts with the configured backend and applies rules locally. If a fact is missing, uniform, or confidence-unreliable, it uses the declared default. Output probabilities combine fact marginals under an independence assumption, and `meta.conditions` contains the fact and rule trace. This does not calibrate fact extraction or correctness. Keep thresholds and default outcomes specific to the business policy.

For example, define a `deadline` fact with values such as `within_hour` and `later`, then map `within_hour` to the `true` urgency option. Keep fact labels mutually exclusive and make each threshold explicit.

## Confidence and calibration

Confidence is a distribution margin, not a probability that the answer is correct. Validate thresholds against recorded ground truth. Call `record_outcome` with the returned `decision_id` when the outcome is known; use `decision_stats` to inspect observed accuracy.

Needle confidence is unreliable for non-ASCII input. For Chinese text, use `DECISION_BACKEND=laya` (multilingual checkpoint reads CJK and returns real per-option distributions) or an OpenAI-compatible backend. OpenAI probabilities and logprobs are model scores, not calibrated accuracy; verify them on domain data.
