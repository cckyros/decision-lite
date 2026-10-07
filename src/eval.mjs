// Labeled evaluation harness: run a dataset through the runtime, emit a
// deterministic report, and optionally gate on a baseline (`--compare`).
//
// Dataset format (JSON file):
//   {
//     "questions": { qid: <jev question> },           // shared by every example
//     "examples": [
//       { "state": "...", "expected": { qid: expected } , "tags": [...]?, "questions"?: {...} }
//     ]
//   }
// An example may carry its own "questions" which shallow-merges over the shared map.
// Expected values: noul -> boolean, choice -> option key, score -> level index.
//
// Report identity borrows laya's approach (evals.py): `schema`, `dataset_sha256`
// and `questions_sha256` are what decide whether two reports are the same
// measurement, and `compare` refuses to diff runs that are not.
//
// Metric definitions: correctness for score questions compares the expected
// level index to Math.round(answer.score) — the expectation over level indices,
// matching the Jev contract — not the argmax level. "Confidence" is the max
// probability in the answer's distribution (a uniform quantity across backends,
// not the Jev `confidence` field: margin for OpenAI, head score for needle,
// answer_confidence for laya).
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EVAL_SCHEMA = 'decision-lite-eval/1';
const IDENTITY_KEYS = ['schema', 'dataset_sha256', 'questions_sha256'];

export class EvalError extends Error {}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function loadDataset(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new EvalError(`dataset ${path}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new EvalError(`dataset ${path}: top level must be an object`);
  const shared = doc.questions;
  if (!shared || typeof shared !== 'object' || !Object.keys(shared).length) {
    throw new EvalError(`dataset ${path}: "questions" must be a non-empty object`);
  }
  if (!Array.isArray(doc.examples) || !doc.examples.length) {
    throw new EvalError(`dataset ${path}: "examples" must be a non-empty array`);
  }
  const examples = doc.examples.map((row, i) => {
    const where = `examples[${i}]`;
    if (!row || typeof row !== 'object') throw new EvalError(`${where} must be an object`);
    if (row.state === undefined) throw new EvalError(`${where} is missing "state"`);
    if (!row.expected || typeof row.expected !== 'object') {
      throw new EvalError(`${where} "expected" must be an object`);
    }
    const questions = row.questions ? { ...shared, ...row.questions } : shared;
    for (const qid of Object.keys(row.expected)) {
      if (!questions[qid]) throw new EvalError(`${where} expected ${JSON.stringify(qid)} but no such question`);
      const bad = badExpected(questions[qid], row.expected[qid]);
      if (bad) throw new EvalError(`${where} expected.${qid}: ${bad}`);
    }
    return { state: row.state, questions, expected: row.expected, tags: row.tags ?? [] };
  });
  return {
    name: doc.name ?? path,
    questions: shared,
    examples,
    dataset_sha256: sha256(readFileSync(path)),
    questions_sha256: sha256(canonicalize(shared)),
  };
}

// Gold labels must match the question type — a mistyped value (e.g. "false"
// for a noul) would otherwise silently score as a different label.
function badExpected(question, value) {
  if (question.type === 'noul') {
    return typeof value === 'boolean' ? null : 'noul expects a boolean';
  }
  if (question.type === 'choice') {
    return typeof value === 'string' && Object.hasOwn(question.criteria ?? {}, value)
      ? null : 'choice expects an option key in criteria';
  }
  if (question.type === 'score') {
    const n = Array.isArray(question.criteria) ? question.criteria.length : 0;
    return Number.isInteger(value) && value >= 0 && value < n
      ? null : `score expects an integer level in [0, ${n})`;
  }
  return null;
}

function answerConfidence(answer) {
  const probs = answer?.probabilities;
  if (probs && typeof probs === 'object') {
    const values = Object.values(probs).filter((v) => Number.isFinite(v));
    if (values.length) return Math.max(...values);
  }
  if (Number.isFinite(answer?.noul)) return Math.max(answer.noul, 1 - answer.noul);
  return 0;
}

function isCorrect(question, answer, expected) {
  if (!answer) return false;
  if (question.type === 'noul') return (Number(answer.noul) >= 0.5) === Boolean(expected);
  if (question.type === 'choice') return answer.choice === String(expected);
  if (question.type === 'score') return Math.round(Number(answer.score)) === Number(expected);
  return false;
}

// Expected Calibration Error over 10 confidence bins: sum_b frac_b * |conf_b - acc_b|.
function ece(pairs, bins = 10) {
  if (!pairs.length) return null;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const sel = pairs.filter(([c]) => (b === 0 ? c >= lo : c > lo) && c <= hi);
    if (!sel.length) continue;
    const conf = sel.reduce((s, [c]) => s + c, 0) / sel.length;
    const acc = sel.reduce((s, [, ok]) => s + ok, 0) / sel.length;
    total += (sel.length / pairs.length) * Math.abs(conf - acc);
  }
  return total;
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export async function runEval(runtime, dataset, { limit, onProgress } = {}) {
  const rows = limit ? dataset.examples.slice(0, limit) : dataset.examples;
  const perQuestion = {};
  const perType = {};
  const confPairs = [];
  const latencies = [];
  const scoredExamples = [];
  let meta;

  for (let i = 0; i < rows.length; i++) {
    const ex = rows[i];
    const t0 = performance.now();
    let result;
    try {
      result = await runtime.callTool('evaluate', { state: ex.state, questions: ex.questions });
    } catch (e) {
      // A backend failure on one example is recorded, not fatal: a comparison
      // report over the remaining rows still has value (and shows the gap).
      const row = { index: i, error: true, message: e instanceof Error ? e.message : String(e) };
      scoredExamples.push(row);
      onProgress?.(i, rows.length, row);
      continue;
    }
    const ms = performance.now() - t0;
    latencies.push(ms);
    meta ??= { backend: result.backend, model: result.model, mode: result.mode };

    let correct = 0;
    let scored = 0;
    for (const [qid, expected] of Object.entries(ex.expected)) {
      const q = ex.questions[qid];
      const answer = result.answers?.[qid];
      const ok = isCorrect(q, answer, expected) ? 1 : 0;
      const conf = answerConfidence(answer);
      confPairs.push([conf, ok]);
      scored++;
      correct += ok;
      perQuestion[qid] ??= { type: q.type, n: 0, correct: 0 };
      perQuestion[qid].n++;
      perQuestion[qid].correct += ok;
      perType[q.type] ??= { n: 0, correct: 0 };
      perType[q.type].n++;
      perType[q.type].correct += ok;
    }
    const row = { index: i, scored, correct, ms: Math.round(ms * 10) / 10 };
    scoredExamples.push(row);
    onProgress?.(i, rows.length, row);
  }

  const nAnswers = confPairs.length;
  const errorCount = scoredExamples.filter((e) => e.error).length;
  const accuracy = nAnswers ? confPairs.reduce((s, [, ok]) => s + ok, 0) / nAnswers : null;
  const meanConf = nAnswers ? confPairs.reduce((s, [c]) => s + c, 0) / nAnswers : null;
  const round4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

  const report = {
    schema: EVAL_SCHEMA,
    config: {
      ...meta,
      version: runtime.version,
      dataset_sha256: dataset.dataset_sha256,
      questions_sha256: dataset.questions_sha256,
      examples: rows.length,
    },
    overall: {
      answers: nAnswers,
      errors: errorCount,
      accuracy: round4(accuracy),
      mean_answer_confidence: round4(meanConf),
      ece: round4(ece(confPairs)),
      latency_ms: {
        mean: round4(latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1)),
        p50: round4(pct(latencies, 50)),
        p95: round4(pct(latencies, 95)),
      },
    },
    by_question: Object.fromEntries(Object.entries(perQuestion).map(([qid, s]) => [
      qid, { type: s.type, n: s.n, accuracy: round4(s.correct / s.n) },
    ])),
    by_type: Object.fromEntries(Object.entries(perType).map(([t, s]) => [
      t, { n: s.n, accuracy: round4(s.correct / s.n) },
    ])),
    examples: scoredExamples,
  };
  return report;
}

function identityOf(report) {
  return Object.fromEntries(IDENTITY_KEYS.map((k) => [k, report?.config?.[k] ?? report?.[k]]));
}

export function compareReports(baseline, current, { tolerance = 0 } = {}) {
  const baseId = identityOf(baseline);
  const curId = identityOf(current);
  const conflicts = IDENTITY_KEYS.filter((k) => baseId[k] != null && curId[k] != null && baseId[k] !== curId[k]);
  // Fail closed in both directions: a baseline that carries no identity at all
  // is not a report, and shared keys that disagree mean different measurements.
  if (!IDENTITY_KEYS.some((k) => baseId[k] != null)) {
    return { comparable: false, pass: null, reason: 'baseline carries no report identity (schema/dataset_sha256/questions_sha256)' };
  }
  if (conflicts.length) {
    return { comparable: false, pass: null, reason: `identity mismatch on: ${conflicts.join(', ')}` };
  }
  const metrics = ['accuracy', 'mean_answer_confidence', 'ece'];
  const deltas = {};
  for (const m of metrics) {
    const b = baseline.overall?.[m], c = current.overall?.[m];
    if (Number.isFinite(b) && Number.isFinite(c)) {
      deltas[m] = { baseline: b, current: c, delta: Math.round((c - b) * 10000) / 10000 };
    }
  }
  const accDelta = deltas.accuracy?.delta ?? 0;
  const pass = accDelta >= -tolerance;
  return {
    comparable: true,
    pass,
    tolerance,
    accuracy_delta: accDelta,
    deltas,
    ...(pass ? {} : { reason: `accuracy regressed by ${-accDelta} beyond tolerance ${tolerance}` }),
  };
}

export function formatReport(report) {
  const o = report.overall;
  const lines = [
    `eval ${report.config.dataset_sha256.slice(0, 12)}  backend=${report.config.backend} model=${report.config.model} mode=${report.config.mode}`,
    `  examples=${report.config.examples} answers=${o.answers}${o.errors ? ` errors=${o.errors}` : ''} accuracy=${o.accuracy} ece=${o.ece} meanConf=${o.mean_answer_confidence}`,
    `  latency mean=${o.latency_ms.mean}ms p50=${o.latency_ms.p50}ms p95=${o.latency_ms.p95}ms`,
  ];
  for (const e of report.examples.filter((x) => x.error)) {
    lines.push(`  ! example ${e.index}: ${e.message}`);
  }
  for (const [qid, s] of Object.entries(report.by_question)) {
    lines.push(`  ${qid} (${s.type}): ${s.accuracy} over ${s.n}`);
  }
  return lines.join('\n');
}

export function formatComparison(cmp) {
  if (!cmp.comparable) return `compare: NOT COMPARABLE — ${cmp.reason}`;
  const lines = [`compare: ${cmp.pass ? 'PASS' : 'FAIL'} (accuracy Δ ${cmp.accuracy_delta >= 0 ? '+' : ''}${cmp.accuracy_delta}, tolerance ${cmp.tolerance})`];
  for (const [m, d] of Object.entries(cmp.deltas)) {
    lines.push(`  ${m}: ${d.baseline} -> ${d.current} (${d.delta >= 0 ? '+' : ''}${d.delta})`);
  }
  return lines.join('\n');
}

export async function runEvalCommand(args, { env = process.env, options } = {}) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const datasetPath = flag('--dataset');
  if (!datasetPath) {
    process.stderr.write('decision-lite eval: --dataset <path.json> is required\n');
    return 2;
  }
  const limit = flag('--limit') === undefined ? undefined : Number(flag('--limit'));
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    process.stderr.write('decision-lite eval: --limit must be a positive integer\n');
    return 2;
  }
  const tolerance = flag('--tolerance') === undefined ? 0 : Number(flag('--tolerance'));
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    process.stderr.write('decision-lite eval: --tolerance must be a non-negative number\n');
    return 2;
  }
  const { createDecisionRuntime } = await import('./runtime.mjs');
  // Eval runs are not production decisions: keep them out of the decision log
  // so fixture traffic does not inflate decision_stats totals.
  const logPath = join(tmpdir(), `decision-lite-eval-${process.pid}-${Date.now()}.jsonl`);
  const runtime = createDecisionRuntime({ env, options: { logPath, ...options } });
  try {
    const dataset = loadDataset(datasetPath);
    const quiet = args.includes('--quiet');
    const report = await runEval(runtime, dataset, {
      limit,
      onProgress: quiet ? undefined : (i, total, row) => {
        process.stderr.write(row.error
          ? `\r  ${i + 1}/${total}  last: ERROR ${String(row.message).slice(0, 80)}   `
          : `\r  ${i + 1}/${total}  last: ${row.correct}/${row.scored} correct, ${row.ms}ms   `);
      },
    });
    if (!quiet) process.stderr.write('\n');
    const out = flag('--out');
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatReport(report)}\n`);
    const baselinePath = flag('--compare');
    if (baselinePath) {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      const cmp = compareReports(baseline, report, { tolerance });
      process.stdout.write(`${formatComparison(cmp)}\n`);
      // A gate must fail closed: incomparable baselines and regressions both
      // exit non-zero — only an explicit pass exits 0.
      if (!cmp.comparable || cmp.pass === false) return 1;
    }
    return 0;
  } finally {
    await runtime.close?.();
    rmSync(logPath, { force: true });
  }
}
