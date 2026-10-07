// Independent review probe — NOT part of the test suite.
// Run: node fixtures/review_check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateConditionPolicy } from '../src/policy.mjs';
import { validateQuestions, shapeAnswer } from '../src/contract.mjs';
import { createDecisionRuntime } from '../src/runtime.mjs';
import { NeedleBackend } from '../src/needle-backend.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}: ${e.message}`); }
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ---------- 1. AND semantics inside a rule ----------
{
  const q = {
    type: 'choice', criteria: { esc: 'escalate', keep: 'keep', drop: 'drop' },
    conditions: {
      version: 1,
      facts: {
        vip: { type: 'noul' },
        angry: { type: 'noul' },
      },
      rules: [
        { id: 'both', when: [{ fact: 'vip', op: 'eq', value: 'true' }, { fact: 'angry', op: 'eq', value: 'true' }], then: 'esc' },
        { id: 'vip-only', when: [{ fact: 'vip', op: 'eq', value: 'true' }], then: 'keep' },
      ],
      default: 'drop',
    },
  };
  const r = evaluateConditionPolicy(q, {
    vip: { distribution: { true: 1, false: 0 } },
    angry: { distribution: { true: 0, false: 1 } },
  });
  check('AND: both-clause rule does not fire when only one fact matches', () => {
    assert.equal(r.distribution.esc, 0);
    assert.equal(r.distribution.keep, 1);
    assert.equal(r.meta.conditions.rule_probabilities.both, 0);
  });
  const r2 = evaluateConditionPolicy(q, {
    vip: { distribution: { true: 0.5, false: 0.5 } }, // flat -> unresolved -> default
    angry: { distribution: { true: 1, false: 0 } },
  });
  check('AND: flat fact -> whole question defaults even if other fact resolved', () => {
    assert.equal(r2.meta.conditions.distribution, 'declared_default');
    assert.equal(r2.distribution.drop, 1);
  });
}

// ---------- 2. in / not_in ----------
{
  const q = {
    type: 'noul',
    conditions: {
      version: 1,
      facts: { lang: { type: 'choice', criteria: { en: 'e', fr: 'f', de: 'd', es: 's' } } },
      rules: [
        { id: 'latin', when: [{ fact: 'lang', op: 'in', value: ['fr', 'es'] }], then: 'true' },
        { id: 'not-en', when: [{ fact: 'lang', op: 'not_in', value: ['en'] }], then: 'true' },
      ],
      default: 'false',
    },
  };
  const r = evaluateConditionPolicy(q, {
    lang: { distribution: { en: 0.4, fr: 0.3, de: 0.2, es: 0.1 } },
  });
  check('in/not_in: masses split correctly', () => {
    // fr(0.3)+es(0.1) -> rule 'latin' 0.4; de(0.2) -> 'not-en' 0.2; en(0.4) -> default
    assert.equal(r.meta.conditions.rule_probabilities.latin, 0.4);
    assert.equal(r.meta.conditions.rule_probabilities['not-en'], 0.2);
    assert.equal(r.meta.conditions.default_probability, 0.4);
    assert.equal(r.distribution.true, 0.6);
    assert.equal(r.distribution.false, 0.4);
    assert.ok(Math.abs(sum(r.meta.conditions.rule_probabilities) + r.meta.conditions.default_probability - 1) < 0.002);
  });
  check('in with non-array value rejected', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'noul' } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'in', value: 'true' }], then: 'true' }], default: 'false' } } }), /not a valid value/);
  });
  check('in with empty array rejected', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'noul' } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'in', value: [] }], then: 'true' }], default: 'false' } } }), /not a valid value/);
  });
}

// ---------- 3. score facts + numeric ops ----------
{
  const q = {
    type: 'choice', criteria: { hi: 'h', lo: 'l' },
    conditions: {
      version: 1,
      facts: { urgency: { type: 'score', criteria: ['l0', 'l1', 'l2', 'l3', 'l4'] } },
      rules: [
        { id: 'hot', when: [{ fact: 'urgency', op: 'gte', value: 3 }], then: 'hi' },
        { id: 'mid', when: [{ fact: 'urgency', op: 'lt', value: '2' }], then: 'lo' },
      ],
      default: 'lo',
    },
  };
  const r = evaluateConditionPolicy(q, {
    urgency: { distribution: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.2, 4: 0.5 } },
  });
  check('score lt/gte: numeric comparison on level index', () => {
    // gte 3 -> levels 3,4 => 0.7 ; lt 2 -> levels 0,1 => 0.2 ; level 2 -> default 0.1
    assert.equal(r.meta.conditions.rule_probabilities.hot, 0.7);
    assert.equal(r.meta.conditions.rule_probabilities.mid, 0.2);
    assert.equal(r.meta.conditions.default_probability, 0.1);
    assert.equal(r.distribution.hi, 0.7);
  });
  check('numeric ops rejected on non-score fact', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'choice', criteria: { a: 'a', b: 'b' } } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'gt', value: 1 }], then: 'true' }], default: 'false' } } }), /numeric operator/);
  });
  check('numeric op with non-numeric value rejected', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'score', criteria: ['a', 'b', 'c'] } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'gt', value: 'abc' }], then: 'true' }], default: 'false' } } }), /numeric operator/);
  });
  check('numeric op with boolean value rejected', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'score', criteria: ['a', 'b', 'c'] } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'gt', value: true }], then: 'true' }], default: 'false' } } }), /numeric operator/);
  });
  check('eq on score fact accepts number value, rejects non-option like 5.0', () => {
    validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'score', criteria: ['a', 'b', 'c'] } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 2 }], then: 'true' }], default: 'false' } } });
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'score', criteria: ['a', 'b', 'c'] } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: '2.0' }], then: 'true' }], default: 'false' } } }), /not a valid value/);
  });
}

// ---------- 4. extra unknown key in extracted distribution ----------
{
  const q = {
    type: 'noul',
    conditions: {
      version: 1,
      facts: { f: { type: 'choice', criteria: { a: 'a', b: 'b' } } },
      rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'a' }], then: 'true' }],
      default: 'false',
    },
  };
  const r = evaluateConditionPolicy(q, { f: { distribution: { a: 0.4, b: 0.1, zzz: 0.5 } } });
  check('extra unknown key in fact distribution: silently dropped & renormalized', () => {
    console.log('   -> distribution:', JSON.stringify(r.distribution), 'reason-facts:', JSON.stringify(r.meta.conditions.facts.f));
    assert.equal(r.meta.conditions.distribution, 'independent_fact_marginals'); // NOT flagged invalid
    assert.equal(r.distribution.true, 0.8); // 0.4/(0.4+0.1)
  });
  const r2 = evaluateConditionPolicy(q, { f: { distribution: { a: 0, b: 0, zzz: 1 } } });
  check('all mass on unknown key -> invalid_distribution -> default', () => {
    assert.equal(r2.meta.conditions.distribution, 'declared_default');
    assert.equal(r2.meta.conditions.unknown_facts[0].reason, 'invalid_distribution');
  });
  const r3 = evaluateConditionPolicy(q, { f: { distribution: { a: 0.6, b: -0.1 } } });
  check('negative probability -> invalid_distribution -> default', () => {
    assert.equal(r3.meta.conditions.unknown_facts[0].reason, 'invalid_distribution');
  });
}

// ---------- 5. extractionError ----------
{
  const q = {
    type: 'noul',
    conditions: {
      version: 1,
      facts: { f: { type: 'noul' } },
      rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'true' }], then: 'true' }],
      default: 'false',
    },
  };
  const r = evaluateConditionPolicy(q, {}, { extractionError: true });
  check('extractionError=true -> declared default + fact_extraction_failed', () => {
    assert.equal(r.meta.conditions.distribution, 'declared_default');
    assert.equal(r.meta.conditions.default_reason, 'fact_extraction_failed');
    assert.equal(r.meta.conditions.unknown_facts[0].reason, 'fact_extraction_failed');
    assert.deepEqual(r.distribution, { true: 0, false: 1 });
  });
  check('declared-default answer reports confidence = 1 (margin of one-hot)', () => {
    const ans = shapeAnswer(q, r.distribution);
    console.log('   -> defaulted answer:', JSON.stringify(ans));
    assert.equal(ans.confidence, 1);
  });
}

// ---------- 6. unresolved-reason coverage ----------
{
  const q = {
    type: 'noul',
    conditions: {
      version: 1,
      facts: {
        f1: { type: 'noul' }, f2: { type: 'noul' }, f3: { type: 'noul' },
      },
      rules: [{ id: 'r', when: [{ fact: 'f1', op: 'eq', value: 'true' }], then: 'true' }],
      default: 'false',
    },
  };
  const r = evaluateConditionPolicy(q, {
    f1: { distribution: { true: 1, false: 0 } },
    f2: { distribution: { true: 0.9, false: 0.1 }, meta: { confidence_unreliable: true } },
    f3: undefined,
  });
  check('confidence_unreliable + missing fact both listed as unknown', () => {
    const reasons = Object.fromEntries(r.meta.conditions.unknown_facts.map((u) => [u.id, u.reason]));
    assert.equal(reasons.f2, 'confidence_unreliable');
    assert.equal(reasons.f3, 'missing_or_invalid_fact');
    assert.equal(r.meta.conditions.default_reason, 'required_fact_unresolved');
  });
  const r4 = evaluateConditionPolicy(q, {
    f1: { distribution: { true: 1, false: 0 } },
    f2: { distribution: { true: 0.9, false: 0.1 }, meta: { valid: 0, requested: 7, invalid: 7 } },
    f3: { distribution: { true: 0.9, false: 0.1 } },
  });
  check('meta.valid===0 beats a non-flat distribution -> all_samples_invalid', () => {
    const reasons = Object.fromEntries(r4.meta.conditions.unknown_facts.map((u) => [u.id, u.reason]));
    assert.equal(reasons.f2, 'all_samples_invalid');
  });
}

// ---------- 7. combination cap boundary ----------
{
  const mkFacts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'noul' }]));
  check('12 binary facts = 4096 combos allowed; 13 -> rejected', () => {
    validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: mkFacts(12), rules: [{ id: 'r', when: [{ fact: 'f0', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } } });
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: mkFacts(13), rules: [{ id: 'r', when: [{ fact: 'f0', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } } }), /4096/);
  });
  check('nested conditions inside a fact rejected', () => {
    assert.throws(() => validateQuestions({ q: { type: 'noul', conditions: { version: 1, facts: { f: { type: 'noul', conditions: { version: 1, facts: { x: { type: 'noul' } }, rules: [{ id: 'r', when: [{ fact: 'x', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } } }), /nested conditions/);
  });
}

// ---------- 8. runtime-level: transport vs parse errors, usage, id collision ----------
const okResponse = (text, usage = { prompt_tokens: 10, completion_tokens: 5 }) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content: text } }], usage }),
});
function mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}
const mkRuntime = () => createDecisionRuntime({ options: {
  backend: 'openai', baseUrl: 'http://x/v1', model: 'm', mode: 'verbalized',
  logPath: join(mkdtempSync(join(tmpdir(), 'jev-review-')), 'decisions.jsonl'),
} });
const condQuestion = {
  type: 'noul',
  conditions: {
    version: 1,
    facts: { f: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
    rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'a' }], then: 'true' }],
    default: 'false',
  },
};

{
  // transport error on fact extraction must propagate
  const restore = mockFetch(async () => ({ ok: false, status: 503, text: () => Promise.resolve('down') }));
  const rt = mkRuntime();
  try {
    let threw = null;
    try { await rt.callTool('evaluate', { state: 's', questions: { q: condQuestion } }); }
    catch (e) { threw = e; }
    check('runtime: transport error on fact extraction propagates', () => {
      assert.ok(threw && /503/.test(threw.message), `expected 503 propagation, got ${threw}`);
    });
  } finally { await rt.close(); restore(); }
}
{
  // persistent garbage -> parse error -> declared default (verbalized batch + per-question fallback all garbage)
  const restore = mockFetch(async () => okResponse('garbage, no json'));
  const rt = mkRuntime();
  try {
    const res = await rt.callTool('evaluate', { state: 's', questions: { q: condQuestion } });
    check('runtime: backend parse error -> declared default', () => {
      assert.equal(res.answers.q.meta.conditions.distribution, 'declared_default');
      assert.equal(res.answers.q.meta.conditions.default_reason, 'fact_extraction_failed');
      assert.equal(res.answers.q.probabilities.false, 1);
      console.log('   -> defaulted answer confidence:', res.answers.q.confidence);
    });
  } finally { await rt.close(); restore(); }
}
{
  // usage combining across direct + fact calls; fact id collision with user id
  let calls = 0;
  const seen = [];
  const restore = mockFetch(async (_u, init) => {
    calls++;
    const prompt = JSON.parse(init.body).messages[0].content;
    seen.push(prompt);
    return okResponse(JSON.stringify({ answers: {
      __decision_policy_fact_0: { answer: 'true', probabilities: { true: 0.9, false: 0.1 } },
      __decision_policy_fact_1: { answer: 'a', probabilities: { a: 0.7, b: 0.3 } },
      direct: { answer: 'true', probabilities: { true: 0.6, false: 0.4 } },
    } }));
  });
  const rt = mkRuntime();
  try {
    const res = await rt.callTool('evaluate', {
      state: 's',
      questions: {
        __decision_policy_fact_0: { type: 'noul', instructions: 'user-owned colliding id' },
        direct: { type: 'noul', instructions: 'd' },
        q: condQuestion,
      },
    });
    check('runtime: user id __decision_policy_fact_0 collision -> fact shifted to _1', () => {
      const factPrompt = seen.find((p) => p.includes('__decision_policy_fact_1'));
      assert.ok(factPrompt, 'fact extraction prompt should reference __decision_policy_fact_1');
      assert.equal(res.answers.__decision_policy_fact_0.noul, 0.9);
      assert.equal(res.answers.q.probabilities.true, 0.7);
    });
    check('runtime: usage tokens combined across direct+fact calls', () => {
      assert.equal(res.usage.prompt_tokens, 20); // 2 calls x 10
    });
  } finally { await rt.close(); restore(); }
}
{
  // mixed: direct question fails transport while condition question fine -> whole call throws
  let n = 0;
  let seen2 = '';
  const restore = mockFetch(async (_u, init) => {
    n++;
    const prompt = JSON.parse(init.body).messages[0].content;
    seen2 += prompt;
    if (prompt.includes('__jev_policy_fact')) {
      return okResponse(JSON.stringify({ answers: { __decision_policy_fact_0: { answer: 'a', probabilities: { a: 0.7, b: 0.3 } } } }));
    }
    return { ok: false, status: 500, text: () => Promise.resolve('oops') };
  });
  const rt = mkRuntime();
  try {
    let threw = null;
    try {
      await rt.callTool('evaluate', { state: 's', questions: { direct: { type: 'noul' }, q: condQuestion } });
    } catch (e) { threw = e; }
    check('runtime: direct-question transport error propagates (order: direct first)', () => {
      assert.ok(threw && /500/.test(threw.message));
      // verbalized retries per-question after batch failure -> 2 calls, both for the
      // direct question; the fact-extraction prompt was never sent.
      assert.equal(n, 2);
      assert.ok(!seen2.includes('__jev_policy_fact'));
    });
  } finally { await rt.close(); restore(); }
}
{
  // needle path: non-ASCII state -> confidence_unreliable -> fact unresolved -> default
  const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake_bridge.mjs');
  const backend = new NeedleBackend({ python: process.execPath, bridgeScript: FAKE });
  try {
    const extracted = await backend.evaluate('中文状态', {
      __decision_policy_fact_0: { type: 'noul', instructions: 'is it urgent' },
    });
    check('needle: non-ASCII state marks confidence_unreliable (drives policy default)', () => {
      assert.equal(extracted.meta.__decision_policy_fact_0.confidence_unreliable, true);
      const r = evaluateConditionPolicy(
        { type: 'noul', conditions: { version: 1, facts: { f: { type: 'noul' } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } },
        { f: { distribution: extracted.dists.__decision_policy_fact_0, confidence: extracted.confidences.__decision_policy_fact_0, meta: extracted.meta.__decision_policy_fact_0 } },
      );
      assert.equal(r.meta.conditions.distribution, 'declared_default');
      assert.equal(r.meta.conditions.unknown_facts[0].reason, 'confidence_unreliable');
    });
    check('needle: low-confidence (<=uniform) valid answer yields flat dist -> unresolved', () => {
      return backend.evaluate('SUPPRESS this', { f: { type: 'noul' } }).then((r2) => {
        // suppressed c=0.05 -> dist floored at 0.5/0.5 -> flat
        const p = evaluateConditionPolicy(
          { type: 'noul', conditions: { version: 1, facts: { f: { type: 'noul' } }, rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'true' }], then: 'true' }], default: 'false' } },
          { f: { distribution: r2.dists.f, confidence: r2.confidences.f, meta: r2.meta.f } },
        );
        assert.equal(p.meta.conditions.unknown_facts[0].reason, 'flat_distribution');
      });
    });
  } finally { await backend.close(); }
}

// ---------- 9. near-flat boundary ----------
{
  const q = {
    type: 'noul',
    conditions: {
      version: 1,
      facts: { f: { type: 'noul' } },
      rules: [{ id: 'r', when: [{ fact: 'f', op: 'eq', value: 'true' }], then: 'true' }],
      default: 'false',
    },
  };
  const r = evaluateConditionPolicy(q, { f: { distribution: { true: 0.5004, false: 0.4996 } } });
  check('near-flat dist rounds to flat -> unresolved', () => {
    // round3(0.5004)=0.5, round3(0.4996)=0.5 -> exactly flat -> default
    console.log('   -> normalized fact:', JSON.stringify(r.meta.conditions.facts.f), 'dist:', r.meta.conditions.distribution);
    assert.equal(r.meta.conditions.distribution, 'declared_default');
  });
  const r2 = evaluateConditionPolicy(q, { f: { distribution: { true: 0.6, false: 0.4 } } });
  check('resolved fact: fact summary has answer + confidence + no distribution_source for plain meta', () => {
    assert.equal(r2.meta.conditions.facts.f.answer, 'true');
    assert.equal(r2.meta.conditions.facts.f.distribution_source, undefined);
  });
  const r3 = evaluateConditionPolicy(q, { f: { distribution: { true: 0.6, false: 0.4 }, meta: { distribution: 'token_logprobs' } } });
  check('meta.distribution surfaces as distribution_source', () => {
    assert.equal(r3.meta.conditions.facts.f.distribution_source, 'token_logprobs');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
