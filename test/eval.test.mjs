// Eval harness tests: deterministic fixture backend, no real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecisionRuntime } from '../src/runtime.mjs';
import { loadDataset, runEval, compareReports, runEvalCommand, EVAL_SCHEMA } from '../src/eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'jev-eval-'));

// Fixture backend: deterministic by marker in state.
// "RIGHT" -> correct answers; "WRONG" -> inverted/wrong; confidence 0.9 either way.
function fakeBackend() {
  return {
    async evaluate(state, questions) {
      if (String(state).includes('BOOM')) throw new Error('backend exploded');
      const right = !String(state).includes('WRONG');
      const dists = {}, confidences = {}, meta = {};
      for (const [qid, q] of Object.entries(questions)) {
        if (q.type === 'noul') {
          dists[qid] = right ? { true: 0.9, false: 0.1 } : { true: 0.1, false: 0.9 };
        } else if (q.type === 'choice') {
          const keys = Object.keys(q.criteria);
          dists[qid] = Object.fromEntries(keys.map((k, i) => [k, (i === (right ? 0 : 1)) ? 0.9 : 0.1 / (keys.length - 1)]));
        } else {
          const n = q.criteria.length;
          dists[qid] = Object.fromEntries([...Array(n).keys()].map((i) => [i, i === (right ? 0 : n - 1) ? 0.9 : 0.1 / (n - 1)]));
        }
        confidences[qid] = 0.9;
        meta[qid] = { backend: 'fake' };
      }
      return { dists, confidences, meta };
    },
    async close() {},
  };
}

function makeRuntime() {
  return createDecisionRuntime({
    env: {},
    options: { backend: 'fake', backendImpl: fakeBackend(), logPath: join(tmp, `log-${Date.now()}-${Math.random()}.jsonl`) },
  });
}

const datasetPath = join(tmp, 'ds.json');
writeFileSync(datasetPath, JSON.stringify({
  name: 'fixture',
  questions: {
    is_urgent: { type: 'noul', instructions: 'urgent?' },
    dept: { type: 'choice', instructions: 'dept?', criteria: { a: 'A', b: 'B' } },
    level: { type: 'score', instructions: 'rate', criteria: ['low', 'mid', 'high'] },
  },
  examples: [
    { state: 'RIGHT case one', expected: { is_urgent: true, dept: 'a', level: 0 } },
    { state: 'RIGHT case two', expected: { is_urgent: true, dept: 'a', level: 0 } },
    { state: 'WRONG case three', expected: { is_urgent: true, dept: 'a', level: 0 } },
  ],
}));

test('eval: loadDataset validates and hashes', () => {
  const ds = loadDataset(datasetPath);
  assert.equal(ds.examples.length, 3);
  assert.equal(ds.questions.is_urgent.type, 'noul');
  assert.match(ds.dataset_sha256, /^[0-9a-f]{64}$/);
  assert.match(ds.questions_sha256, /^[0-9a-f]{64}$/);
});

test('eval: runEval produces accuracy, ECE, latency and per-question stats', async () => {
  const rt = makeRuntime();
  try {
    const ds = loadDataset(datasetPath);
    const report = await runEval(rt, ds);
    assert.equal(report.schema, EVAL_SCHEMA);
    assert.equal(report.config.dataset_sha256, ds.dataset_sha256);
    // 2 of 3 examples fully right -> 6/9 answers correct
    assert.equal(report.overall.answers, 9);
    assert.equal(report.overall.accuracy, Math.round((6 / 9) * 10000) / 10000);
    assert.equal(report.overall.mean_answer_confidence, 0.9);
    assert.ok(report.overall.ece > 0);
    assert.ok(report.overall.latency_ms.mean >= 0);
    assert.equal(report.by_question.is_urgent.accuracy, Math.round((2 / 3) * 10000) / 10000);
    assert.equal(report.by_type.noul.n, 3);
    assert.equal(report.examples.length, 3);
  } finally { await rt.close(); }
});

test('eval: compareReports gates on accuracy delta and refuses identity mismatch', async () => {
  const rt = makeRuntime();
  try {
    const ds = loadDataset(datasetPath);
    const base = await runEval(rt, ds);
    const same = compareReports(base, base);
    assert.equal(same.comparable, true);
    assert.equal(same.pass, true);

    const worse = structuredClone(base);
    worse.overall.accuracy = base.overall.accuracy - 0.2;
    const regressed = compareReports(base, worse, { tolerance: 0.05 });
    assert.equal(regressed.pass, false);
    assert.match(regressed.reason, /regressed/);

    const foreign = structuredClone(base);
    foreign.config.dataset_sha256 = 'f'.repeat(64);
    const notSame = compareReports(foreign, base);
    assert.equal(notSame.comparable, false);
  } finally { await rt.close(); }
});

test('eval: malformed dataset errors name the path', () => {
  const bad = join(tmp, 'bad.json');
  writeFileSync(bad, JSON.stringify({ questions: { q: { type: 'noul' } }, examples: [{ state: 'x' }] }));
  assert.throws(() => loadDataset(bad), /examples\[0\].*expected/);
});

test('eval: mistyped expected values are rejected, not silently scored', () => {
  const mk = (name, expected) => {
    const p = join(tmp, name);
    writeFileSync(p, JSON.stringify({
      questions: {
        n: { type: 'noul', instructions: 'x' },
        c: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
        s: { type: 'score', instructions: 'x', criteria: ['lo', 'hi'] },
      },
      examples: [{ state: 'x', expected }],
    }));
    return p;
  };
  // "false" the string is truthy — without validation it would invert to gold=true.
  assert.throws(() => loadDataset(mk('e1.json', { n: 'false' })), /expected\.n.*boolean/);
  assert.throws(() => loadDataset(mk('e2.json', { n: 1 })), /expected\.n.*boolean/);
  assert.throws(() => loadDataset(mk('e3.json', { c: 'missing' })), /expected\.c.*option key/);
  assert.throws(() => loadDataset(mk('e4.json', { c: 0 })), /expected\.c.*option key/);
  assert.throws(() => loadDataset(mk('e5.json', { s: 2 })), /expected\.s.*\[0, 2\)/);
  assert.throws(() => loadDataset(mk('e6.json', { s: 0.5 })), /expected\.s.*integer/);
  assert.throws(() => loadDataset(mk('e7.json', { s: 'high' })), /expected\.s.*integer/);
  assert.ok(loadDataset(mk('ok.json', { n: false, c: 'b', s: 1 })));
});

test('eval: a backend error on one example is recorded, not fatal', async () => {
  const p = join(tmp, 'boom.json');
  writeFileSync(p, JSON.stringify({
    questions: { n: { type: 'noul', instructions: 'x' } },
    examples: [
      { state: 'RIGHT one', expected: { n: true } },
      { state: 'BOOM two', expected: { n: true } },
      { state: 'RIGHT three', expected: { n: true } },
    ],
  }));
  const rt = makeRuntime();
  try {
    const report = await runEval(rt, loadDataset(p));
    assert.equal(report.overall.errors, 1);
    assert.equal(report.overall.answers, 2);
    assert.equal(report.overall.accuracy, 1);
    assert.equal(report.examples.length, 3);
    assert.equal(report.examples[1].error, true);
    assert.match(report.examples[1].message, /exploded/);
  } finally { await rt.close(); }
});

test('eval CLI: --compare fails closed on incomparable baselines and regressions', async () => {
  const ds = loadDataset(datasetPath);
  const cliOpts = {
    env: {},
    options: { backend: 'fake', backendImpl: fakeBackend(), logPath: join(tmp, 'cli-log.jsonl') },
  };
  // foreign baseline: no shared identity keys -> NOT COMPARABLE -> exit 1
  const foreign = join(tmp, 'foreign.json');
  writeFileSync(foreign, JSON.stringify({ overall: { accuracy: 0.01 } }));
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--compare', foreign, '--quiet'], cliOpts), 1);
  // identity-matching baseline with higher accuracy -> regression -> exit 1
  const high = join(tmp, 'high.json');
  writeFileSync(high, JSON.stringify({
    schema: EVAL_SCHEMA,
    config: { dataset_sha256: ds.dataset_sha256, questions_sha256: ds.questions_sha256 },
    overall: { accuracy: 0.999 },
  }));
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--compare', high, '--quiet'], cliOpts), 1);
  // same-metric baseline -> pass -> exit 0
  const same = join(tmp, 'same.json');
  writeFileSync(same, JSON.stringify({
    schema: EVAL_SCHEMA,
    config: { dataset_sha256: ds.dataset_sha256, questions_sha256: ds.questions_sha256 },
    overall: { accuracy: 2 / 3 },
  }));
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--compare', same, '--quiet'], cliOpts), 0);
});

test('eval CLI: invalid --limit/--tolerance exit 2 before touching a backend', async () => {
  const cliOpts = { env: {}, options: { backend: 'fake', backendImpl: fakeBackend(), logPath: join(tmp, 'x.jsonl') } };
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--limit', 'abc'], cliOpts), 2);
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--limit', '-1'], cliOpts), 2);
  assert.equal(await runEvalCommand(['--dataset', datasetPath, '--tolerance', 'abc'], cliOpts), 2);
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
