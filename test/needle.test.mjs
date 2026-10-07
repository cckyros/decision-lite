// NeedleBackend tests against a fake JSONL bridge (no real model needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NeedleBackend } from '../src/needle-backend.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake_bridge.mjs');
const makeBackend = () => new NeedleBackend({ python: process.execPath, bridgeScript: FAKE });

const questions = {
  urgent: { type: 'noul', instructions: 'is this urgent?' },
  dept: { type: 'choice', instructions: 'pick dept', criteria: { billing: 'money', tech: 'bugs' } },
  risk: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
};

test('needle: valid answers synthesize distribution from confidence', async () => {
  const b = makeBackend();
  try {
    const { dists, confidences } = await b.evaluate('normal state', questions);
    assert.equal(dists.urgent.true, 0.8);
    assert.equal(dists.urgent.false, 0.2);
    assert.equal(dists.dept.billing, 0.8);
    assert.equal(dists.dept.tech, 0.2);
    assert.equal(dists.risk['0'], 0.8);
    assert.equal(confidences.urgent, 0.8);
  } finally { await b.close(); }
});

test('needle: suppressed valid answers are used, floored at uniform', async () => {
  const b = makeBackend();
  try {
    const { dists, confidences, meta } = await b.evaluate('SUPPRESS this', questions);
    // confidence 0.05 < uniform 0.5 → dist floored at 0.5 so model's pick stays argmax
    assert.equal(dists.dept.billing, 0.5);
    assert.equal(dists.dept.tech, 0.5);
    assert.equal(confidences.dept, 0.05); // real (low) needle confidence reported
    assert.equal(meta.dept.suppressed, true);
  } finally { await b.close(); }
});

test('needle: missing calls fall back to uniform', async () => {
  const b = makeBackend();
  try {
    const { dists, confidences } = await b.evaluate('NOCALL state', questions);
    assert.equal(dists.urgent.true, 0.5);
    assert.equal(confidences.urgent, 0);
  } finally { await b.close(); }
});

test('needle: non-ASCII input warns that confidence is unreliable', async () => {
  const b = makeBackend();
  try {
    const { meta } = await b.evaluate('客户要求退款', questions);
    assert.equal(meta.urgent.confidence_unreliable, true);
    assert.match(meta.urgent.warning, /confidence is unreliable/i);

    const ascii = await b.evaluate('Customer asks for a refund', questions);
    assert.equal(ascii.meta.urgent.confidence_unreliable, undefined);

    const nonAsciiQuestion = await b.evaluate('ASCII state', {
      urgent: { type: 'noul', instructions: '客户是否需要紧急回复？' },
    });
    assert.equal(nonAsciiQuestion.meta.urgent.confidence_unreliable, true);
  } finally { await b.close(); }
});

test('needle: bridge error surfaces as exception', async () => {
  const b = makeBackend();
  try {
    await assert.rejects(() => b.evaluate('ERR state', questions), /needle backend.*boom/);
  } finally { await b.close(); }
});

test('needle: unroutable error response (id:null) rejects instead of hanging', async () => {
  const b = makeBackend();
  try {
    await assert.rejects(() => b.evaluate('NULLID state', questions), /lost request id/);
  } finally { await b.close(); }
});
