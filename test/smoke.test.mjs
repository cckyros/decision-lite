// Smoke test: contract validation, backend adapters (mocked fetch), decision log.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateQuestions, normalizeDistribution, shapeAnswer, marginConfidence } from '../src/contract.mjs';
import { DecisionBackend } from '../src/backend.mjs';
import { DecisionLog } from '../src/log.mjs';
import { createDecisionRuntime, toolDefinitions } from '../src/runtime.mjs';

// ---------- contract ----------

test('MCP evaluate schema describes versioned condition policies', () => {
  const evaluate = toolDefinitions.find((tool) => tool.name === 'evaluate');
  const questionSchema = evaluate.inputSchema.properties.questions.additionalProperties;
  const conditions = questionSchema.properties.conditions;
  assert.equal(conditions.properties.version.const, 1);
  assert.ok(conditions.properties.facts.additionalProperties);
  assert.deepEqual(conditions.properties.rules.items.required, ['id', 'when', 'then']);
  assert.ok(conditions.properties.rules.items.properties.when.items.properties.op.enum.includes('in'));
});

test('validateQuestions accepts all three types', () => {
  const qs = validateQuestions({
    urgent: { type: 'noul', instructions: 'is this urgent?', criteria: { true: 'yes', false: 'no' } },
    dept: { type: 'choice', instructions: 'pick dept', criteria: { billing: 'money', tech: 'bugs' } },
    risk: { type: 'score', instructions: 'rate risk', criteria: ['low', 'med', 'high'] },
  });
  assert.equal(Object.keys(qs).length, 3);
});

test('validateQuestions rejects bad definitions', () => {
  assert.throws(() => validateQuestions({}), /empty/);
  assert.throws(() => validateQuestions(null), /object/);
  assert.throws(() => validateQuestions({ a: { type: 'nope' } }), /invalid type/);
  assert.throws(() => validateQuestions({ c: { type: 'choice', criteria: { only: 'one' } } }), />=2/);
  assert.throws(() => validateQuestions({ s: { type: 'score', criteria: 'flat' } }), /ordered array/);
  assert.throws(() => validateQuestions({ n: { type: 'noul', criteria: [1, 2] } }), /criteria/);
});

test('validateQuestions accepts ordered condition rules and rejects invalid references', () => {
  const question = {
    type: 'noul',
    instructions: 'Should this be prioritized?',
    criteria: { true: 'priority required', false: 'normal queue' },
    conditions: {
      version: 1,
      facts: {
        deadline: { type: 'choice', instructions: 'Classify the deadline.', criteria: { within_hour: 'within one hour', later: 'later or unspecified' } },
        active_harm: { type: 'noul', instructions: 'Is harm currently occurring?', criteria: { true: 'active harm', false: 'no active harm' } },
      },
      rules: [
        { id: 'deadline', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' },
        { id: 'harm', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' },
      ],
      default: 'false',
    },
  };
  assert.equal(validateQuestions({ urgent: question }).urgent, question);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, rules: [{ id: 'bad-fact', when: [{ fact: 'missing', op: 'eq', value: 'x' }], then: 'true' }] } } }), /unknown fact/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, rules: [{ id: 'bad-value', when: [{ fact: 'deadline', op: 'eq', value: 'missing' }], then: 'true' }] } } }), /not a valid value/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, version: 2 } } }), /version must be 1/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, rules: [{ id: 'bad-op', when: [{ fact: 'deadline', op: 'contains', value: 'within_hour' }], then: 'true' }] } } }), /invalid operator/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, rules: [{ id: 'bad-number', when: [{ fact: 'deadline', op: 'lte', value: 1 }], then: 'true' }] } } }), /numeric operator/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, rules: [{ id: 'duplicate', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' }, { id: 'duplicate', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' }] } } }), /unique non-empty id/);
  assert.throws(() => validateQuestions({ urgent: { ...question, conditions: { ...question.conditions, default: 'unknown' } } }), /default outcome/);
});

test('normalizeDistribution covers options and sums to 1', () => {
  const d = normalizeDistribution({ a: 0.8, b: 0.1 }, ['a', 'b', 'c']);
  assert.equal(d.c, 0);
  const sum = Object.values(d).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('normalizeDistribution falls back to uniform on garbage', () => {
  const d = normalizeDistribution({ a: 'x', b: -1 }, ['a', 'b']);
  assert.deepEqual(d, { a: 0.5, b: 0.5 });
});

test('shapeAnswer produces Jev-shaped responses', () => {
  const noul = shapeAnswer({ type: 'noul' }, { true: 0.95, false: 0.05 });
  assert.equal(noul.noul, 0.95);
  assert.equal(noul.confidence, 0.9); // |0.95-0.5|*2

  const choice = shapeAnswer(
    { type: 'choice', criteria: { billing: 'b', tech: 't' } },
    { billing: 0.87, tech: 0.13 });
  assert.equal(choice.choice, 'billing');
  assert.equal(choice.confidence, 0.74); // 0.87-0.13

  const score = shapeAnswer(
    { type: 'score', criteria: ['calm', 'mad', 'rage'] },
    { 0: 0, 1: 0.96, 2: 0.04 });
  assert.equal(score.score, 1.04); // 0*0 + 1*.96 + 2*.04
  assert.deepEqual(score.legend, { 0: 'calm', 1: 'mad', 2: 'rage' });
});

test('marginConfidence is a margin, not correctness', () => {
  assert.equal(marginConfidence({ a: 0.5, b: 0.5 }), 0);
  assert.equal(marginConfidence({ a: 1, b: 0, c: 0 }), 1);
});

// ---------- backend (mocked fetch) ----------

const questions = {
  urgent: { type: 'noul', instructions: 'is this urgent?' },
  dept: { type: 'choice', instructions: 'pick dept', criteria: { billing: 'money', tech: 'bugs' } },
};

function mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

const okResponse = (text, choice = {}) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({
    choices: [{ message: { content: text }, ...choice }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
});

test('verbalized mode: batch call returns normalized dists', async () => {
  const restore = mockFetch(async (url, init) => {
    assert.match(url, /\/chat\/completions$/);
    return okResponse(JSON.stringify({
      answers: {
        urgent: { answer: 'true', probabilities: { true: 0.9, false: 0.1 } },
        dept: { answer: 'billing', probabilities: { billing: 0.8, tech: 0.2 } },
      },
    }));
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const { dists, usage } = await b.evaluate('customer is angry', questions);
    assert.equal(dists.urgent.true, 0.9);
    assert.equal(dists.dept.billing, 0.8);
    assert.ok(usage.prompt_tokens > 0);
  } finally { restore(); }
});

test('condition rules are included in the model prompt without changing Jev outputs', async () => {
  let prompt;
  const restore = mockFetch(async (url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return okResponse(JSON.stringify({ answers: { urgent: { answer: 'true', probabilities: { true: 0.8, false: 0.2 } } } }));
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const question = {
      type: 'noul',
      instructions: 'Should this be prioritized?',
      criteria: { true: 'priority required', false: 'normal queue' },
      conditions: {
        version: 1,
        facts: { deadline: { type: 'choice', instructions: 'Classify the deadline.', criteria: { within_hour: 'within one hour', later: 'later or unspecified' } } },
        rules: [{ id: 'deadline', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' }],
        default: 'false',
      },
    };
    const { dists } = await b.evaluate('report due in 30 minutes', { urgent: question });
    assert.equal(dists.urgent.true, 0.8);
    assert.match(prompt, /extract each fact from STATE/i);
    assert.match(prompt, /first matching rule wins/i);
    assert.match(prompt, /deadline eq "within_hour"/);
    assert.match(prompt, /Default outcome: "false"/);
  } finally { restore(); }
});

test('runtime composes fact distributions through the condition rules and preserves Jev outputs', async () => {
  let calls = 0;
  const restore = mockFetch(async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.match(request.messages[0].content, /__decision_policy_fact_0/);
    return okResponse(JSON.stringify({ answers: {
      __decision_policy_fact_0: { answer: 'within_hour', probabilities: { within_hour: 0.8, later: 0.2 } },
      __decision_policy_fact_1: { answer: 'false', probabilities: { true: 0.2, false: 0.8 } },
    } }));
  });
  const runtime = createDecisionRuntime({ options: {
    backend: 'openai', baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized',
    logPath: join(mkdtempSync(join(tmpdir(), 'jev-policy-')), 'decisions.jsonl'),
  } });
  try {
    const question = {
      type: 'noul',
      instructions: 'Should this be prioritized?',
      criteria: { true: 'priority', false: 'normal' },
      conditions: {
        version: 1,
        facts: {
          deadline: { type: 'choice', instructions: 'Classify the deadline.', criteria: { within_hour: 'within one hour', later: 'later' } },
          active_harm: { type: 'noul', instructions: 'Is harm occurring?', criteria: { true: 'active harm', false: 'no active harm' } },
        },
        rules: [
          { id: 'deadline', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' },
          { id: 'harm', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' },
        ],
        default: 'false',
      },
    };
    const response = await runtime.callTool('evaluate', { state: 'report due in 30 minutes', questions: { urgent: question } });
    assert.equal(calls, 1);
    assert.equal(response.answers.urgent.type, 'noul');
    assert.equal(response.answers.urgent.probabilities.true, 0.84);
    assert.equal(response.answers.urgent.probabilities.false, 0.16);
    assert.equal(response.answers.urgent.meta.conditions.distribution, 'independent_fact_marginals');
    assert.equal(response.answers.urgent.meta.conditions.facts.deadline.answer, 'within_hour');
    assert.equal(response.answers.urgent.meta.conditions.rule_probabilities.deadline, 0.8);
    assert.equal(response.answers.urgent.meta.conditions.default_probability, 0.16);
  } finally {
    await runtime.close();
    restore();
  }
});

test('declared default fallback reports zero confidence instead of a one-hot margin', async () => {
  const restore = mockFetch(async () => okResponse(JSON.stringify({ answers: {
    __decision_policy_fact_0: { answer: 'within_hour', probabilities: { within_hour: 0.5, later: 0.5 } },
    __decision_policy_fact_1: { answer: 'false', probabilities: { true: 0.2, false: 0.8 } },
  } })));
  const runtime = createDecisionRuntime({ options: {
    backend: 'openai', baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized',
    logPath: join(mkdtempSync(join(tmpdir(), 'jev-policy-default-')), 'decisions.jsonl'),
  } });
  try {
    const question = {
      type: 'noul',
      instructions: 'Should this be prioritized?',
      criteria: { true: 'priority', false: 'normal' },
      conditions: {
        version: 1,
        facts: {
          deadline: { type: 'choice', instructions: 'Classify the deadline.', criteria: { within_hour: 'within one hour', later: 'later' } },
          active_harm: { type: 'noul', instructions: 'Is harm occurring?', criteria: { true: 'active harm', false: 'no active harm' } },
        },
        rules: [
          { id: 'deadline', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' },
          { id: 'harm', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' },
        ],
        default: 'false',
      },
    };
    const response = await runtime.callTool('evaluate', { state: 'vague', questions: { urgent: question } });
    assert.equal(response.answers.urgent.meta.conditions.distribution, 'declared_default');
    assert.equal(response.answers.urgent.confidence, 0);
    assert.equal(response.answers.urgent.noul, 0);
  } finally {
    await runtime.close();
    restore();
  }
});

test('verbalized mode: accepts responses keyed by question id at the root', async () => {
  const restore = mockFetch(async () => okResponse(JSON.stringify({
    urgent: { answer: 'false', probabilities: { true: 0.1, false: 0.9 } },
    dept: { answer: 'tech', probabilities: { billing: 0.2, tech: 0.8 } },
  })));
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const { dists } = await b.evaluate('state', questions);
    assert.equal(dists.urgent.false, 0.9);
    assert.equal(dists.dept.tech, 0.8);
  } finally { restore(); }
});

test('verbalized mode: reads probabilities beside a scalar single-question answer', async () => {
  const restore = mockFetch(async () => okResponse(JSON.stringify({
    answers: { urgent: 'false', probabilities: { true: 0.05, false: 0.95 } },
  })));
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const { dists } = await b.evaluate('state', { urgent: questions.urgent });
    assert.equal(dists.urgent.false, 0.95);
  } finally { restore(); }
});

test('verbalized mode: retries missing batch answers per question', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) return okResponse(JSON.stringify({ answers: {} }));
    return okResponse(JSON.stringify({
      answers: { urgent: 'false', probabilities: { true: 0, false: 1 } },
    }));
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const { dists } = await b.evaluate('state', { urgent: questions.urgent });
    assert.equal(calls, 2);
    assert.equal(dists.urgent.false, 1);
  } finally { restore(); }
});

test('verbalized mode: falls back to per-question on malformed JSON', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) return okResponse('not json at all'); // batch fails
    // per-question calls
    return okResponse(JSON.stringify({
      answers: { urgent: { answer: 'false', probabilities: { true: 0.2, false: 0.8 } },
                 dept: { answer: 'tech', probabilities: { tech: 0.7, billing: 0.3 } } },
    }));
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized' });
    const { dists } = await b.evaluate('state', questions);
    assert.equal(dists.urgent.false, 0.8);
    assert.ok(calls >= 3); // 1 failed batch + 2 per-question
  } finally { restore(); }
});

test('logprobs mode: maps complete option-code token probabilities', async () => {
  let request;
  const restore = mockFetch(async (url, init) => {
    request = JSON.parse(init.body);
    return okResponse('A', {
      logprobs: { content: [{ top_logprobs: [
        { token: 'A', logprob: Math.log(0.8) },
        { token: 'B', logprob: Math.log(0.2) },
      ] }] },
    });
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'qwen3:0.6b', mode: 'logprobs' });
    const { dists, meta } = await b.evaluate('state', { dept: questions.dept });
    assert.equal(request.logprobs, true);
    assert.equal(request.reasoning_effort, 'none');
    assert.equal(request.top_logprobs, 20);
    assert.equal(dists.dept.billing, 0.8);
    assert.equal(dists.dept.tech, 0.2);
    assert.equal(meta.dept.distribution, 'token_logprobs');
  } finally { restore(); }
});

test('logprobs mode: falls back to sampling when an option is missing', async () => {
  let calls = 0;
  const restore = mockFetch(async (url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    if (request.logprobs) {
      return okResponse('A', {
        logprobs: { content: [{ top_logprobs: [{ token: 'A', logprob: 0 }] }] },
      });
    }
    return okResponse('billing');
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'logprobs', samples: 2 });
    const { dists, meta } = await b.evaluate('state', { dept: questions.dept });
    assert.equal(calls, 3);
    assert.equal(dists.dept.billing, 1);
    assert.equal(meta.dept.distribution, 'sampling_fallback');
  } finally { restore(); }
});

test('sampling mode: votes aggregate into empirical distribution', async () => {
  let i = 0;
  // 4 votes "billing", 2 votes "tech", 1 garbage (dropped, denominator = 6 valid)
  const votes = ['billing', 'billing', 'tech', 'billing', 'garbage', 'billing', 'tech'];
  const restore = mockFetch(async (url, init) => {
    assert.equal(JSON.parse(init.body).reasoning_effort, 'none');
    return okResponse(votes[i++ % votes.length]);
  });
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'qwen3:0.6b', mode: 'sampling', samples: 7 });
    const { dists, meta } = await b.evaluate('state', { dept: questions.dept });
    assert.equal(dists.dept.billing, 0.667); // 4/6
    assert.equal(dists.dept.tech, 0.333);    // 2/6
    assert.deepEqual(meta.dept, { requested: 7, valid: 6, invalid: 1 });
  } finally { restore(); }
});

test('sampling mode: all-garbage votes -> uniform fallback', async () => {
  const restore = mockFetch(async () => okResponse('???'));
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'sampling', samples: 3 });
    const { dists } = await b.evaluate('state', { dept: questions.dept });
    assert.equal(dists.dept.billing, 0.5);
    assert.equal(dists.dept.tech, 0.5);
  } finally { restore(); }
});

test('backend surfaces HTTP errors', async () => {
  const restore = mockFetch(async () => ({
    ok: false, status: 401,
    text: () => Promise.resolve('unauthorized'),
  }));
  try {
    const b = new DecisionBackend({ baseUrl: 'http://x/v1', model: 'm', mode: 'sampling', samples: 1 });
    await assert.rejects(() => b.evaluate('s', questions), /401/);
  } finally { restore(); }
});

// ---------- decision log ----------

test('decision log: record decision, attach outcome, compute stats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  const log = new DecisionLog(join(dir, 'd.jsonl'));

  const id1 = log.recordDecision({
    state: 's1', questions: {},
    answers: {
      q: { type: 'noul', noul: 0.9, confidence: 0.8 },
      c: { type: 'choice', choice: 'x', confidence: 0.6 },
    },
    model: 'm', mode: 'verbalized',
  });
  const id2 = log.recordDecision({
    state: 's2', questions: {},
    answers: { q: { type: 'noul', noul: 0.95, confidence: 0.9 } },
    model: 'm', mode: 'verbalized',
  });
  log.recordOutcome(id1, { q: true, c: false });
  log.recordOutcome(id2, true);

  const stats = log.stats();
  assert.equal(stats.totalDecisions, 2);
  assert.equal(stats.judgedAnswers, 3);
  const b9 = stats.buckets.find(b => b.confidenceRange === '0.9-1.0');
  const b8 = stats.buckets.find(b => b.confidenceRange === '0.8-0.9');
  assert.equal(b9.observedAccuracy, 1);   // conf .9 answer was right
  assert.equal(b8.observedAccuracy, 1);   // conf .8 answer was right
  assert.ok(stats.buckets.find(b => b.confidenceRange === '0.6-0.7').observedAccuracy === 0);
});

test('recordOutcome rejects unknown decision id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  const log = new DecisionLog(join(dir, 'd.jsonl'));
  assert.throws(() => log.recordOutcome('nope', true), /not found/);
});
