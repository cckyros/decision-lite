// LayaBackend tests against a fake JSONL bridge (no real model needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LayaBackend } from '../src/laya-backend.mjs';
import { createDecisionRuntime } from '../src/runtime.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake_laya_bridge.mjs');
const makeBackend = () => new LayaBackend({ python: process.execPath, bridgeScript: FAKE });

const questions = {
  urgent: { type: 'noul', instructions: 'is this urgent?' },
  dept: { type: 'choice', instructions: 'pick dept', criteria: { billing: 'money', tech: 'bugs' } },
  risk: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
};

test('laya: real per-option distributions pass through', async () => {
  const b = makeBackend();
  try {
    const { dists, confidences, meta } = await b.evaluate('normal state', questions);
    assert.equal(dists.urgent.true, 0.7);
    assert.equal(dists.urgent.false, 0.3);
    assert.equal(dists.dept.billing, 0.7);
    assert.equal(dists.dept.tech, 0.3);
    assert.equal(dists.risk['0'], 0.7);
    // confidence prefers answer_confidence (max-p, the calibratable quantity)
    assert.equal(confidences.urgent, 0.7);
    assert.equal(meta.urgent.backend, 'laya');
    assert.equal(meta.urgent.answer_confidence, 0.7);
    assert.equal(meta.urgent.entropy_confidence, 0.55);
    assert.equal(meta.urgent.routing.model, 'laya');
  } finally { await b.close(); }
});

test('laya: non-ASCII input keeps working (no confidence_unreliable flag)', async () => {
  const b = makeBackend();
  try {
    const { dists, meta } = await b.evaluate('客户要求退款', questions);
    assert.equal(dists.urgent.true, 0.7);
    assert.equal(meta.urgent.confidence_unreliable, undefined);
  } finally { await b.close(); }
});

test('laya: missing distribution falls back to uniform, confidence 0', async () => {
  const b = makeBackend();
  try {
    const { dists, confidences, meta } = await b.evaluate('NODIST state', questions);
    assert.equal(dists.urgent.true, 0.5);
    assert.equal(confidences.urgent, 0);
    assert.match(meta.urgent.note, /uniform fallback/);
  } finally { await b.close(); }
});

test('laya: bridge error surfaces as exception', async () => {
  const b = makeBackend();
  try {
    await assert.rejects(() => b.evaluate('ERR state', questions), /laya backend.*boom/);
  } finally { await b.close(); }
});

test('laya: warmup preloads all checkpoints when no model is pinned', async () => {
  const b = makeBackend();
  try {
    const r = await b.warmup();
    assert.deepEqual(r.warmed, ['english', 'multilingual']);
    assert.equal(r.error, null);
  } finally { await b.close(); }
});

test('laya: pinned model warms only that checkpoint', async () => {
  const b = new LayaBackend({ python: process.execPath, bridgeScript: FAKE, model: 'multilingual' });
  try {
    const r = await b.warmup();
    assert.deepEqual(r.warmed, ['multilingual']);
  } finally { await b.close(); }
});

test('runtime: laya backend warms at startup, DECISION_LAYA_WARMUP=0 disables', async () => {
  const calls = [];
  const fake = {
    warmup: () => { calls.push('warmup'); return Promise.resolve({ warmed: ['x'] }); },
    evaluate: async () => ({ dists: {}, confidences: {}, meta: {} }),
    close: async () => {},
  };
  const logPath = join(mkdtempSync(join(tmpdir(), 'dl-warm-')), 'd.jsonl');
  const options = { backend: 'laya', backendImpl: fake, logPath };

  const r1 = createDecisionRuntime({ env: {}, options });
  assert.deepEqual(calls, ['warmup']);
  await r1.close();

  const r2 = createDecisionRuntime({ env: { DECISION_LAYA_WARMUP: '0' }, options });
  assert.deepEqual(calls, ['warmup']);
  await r2.close();
});

test('laya: unroutable error response (id:null) rejects instead of hanging', async () => {
  const b = makeBackend();
  try {
    await assert.rejects(() => b.evaluate('NULLID state', questions), /lost request id/);
  } finally { await b.close(); }
});
