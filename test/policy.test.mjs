import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateConditionPolicy } from '../src/policy.mjs';

const question = {
  type: 'noul',
  criteria: { true: 'priority', false: 'normal' },
  conditions: {
    version: 1,
    facts: {
      deadline: { type: 'choice', criteria: { within_hour: 'within an hour', later: 'later' } },
      active_harm: { type: 'noul', criteria: { true: 'active harm', false: 'no active harm' } },
    },
    rules: [
      { id: 'deadline', when: [{ fact: 'deadline', op: 'eq', value: 'within_hour' }], then: 'true' },
      { id: 'harm', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' },
    ],
    default: 'false',
  },
};

test('condition outcomes combine fact marginals through first-match rules', () => {
  const evaluated = evaluateConditionPolicy(question, {
    deadline: { distribution: { within_hour: 0.8, later: 0.2 } },
    active_harm: { distribution: { true: 0.2, false: 0.8 } },
  });
  assert.deepEqual(evaluated.distribution, { true: 0.84, false: 0.16 });
  assert.equal(evaluated.meta.conditions.distribution, 'independent_fact_marginals');
  assert.equal(evaluated.meta.conditions.rule_probabilities.deadline, 0.8);
  assert.equal(evaluated.meta.conditions.rule_probabilities.harm, 0.04);
  assert.equal(evaluated.meta.conditions.default_probability, 0.16);
  assert.equal(evaluated.meta.conditions.facts.deadline.answer, 'within_hour');
});

test('condition output uses the declared default when a fact is unresolved', () => {
  const evaluated = evaluateConditionPolicy(question, {
    deadline: { distribution: { within_hour: 0.5, later: 0.5 } },
    active_harm: { distribution: { true: 0.2, false: 0.8 } },
  });
  assert.deepEqual(evaluated.distribution, { true: 0, false: 1 });
  assert.equal(evaluated.meta.conditions.distribution, 'declared_default');
  assert.deepEqual(evaluated.meta.conditions.unknown_facts.map(({ id }) => id), ['deadline']);
});

test('rounding-drift uniform fact distributions are still treated as flat', () => {
  const threeOption = {
    ...question,
    conditions: {
      ...question.conditions,
      facts: {
        intent: { type: 'choice', criteria: { a: 'a', b: 'b', c: 'c' } },
      },
      rules: [{ id: 'r', when: [{ fact: 'intent', op: 'eq', value: 'a' }], then: 'true' }],
    },
  };
  const evaluated = evaluateConditionPolicy(threeOption, {
    intent: { distribution: { a: 0.334, b: 0.333, c: 0.333 } },
  });
  assert.equal(evaluated.meta.conditions.distribution, 'declared_default');
  assert.equal(evaluated.meta.conditions.unknown_facts[0].reason, 'flat_distribution');
  assert.equal(evaluated.meta.conditions.facts.intent.probabilities.a, 0.334);
  assert.deepEqual(evaluated.distribution, { true: 0, false: 1 });
});

test('sampling stats with zero valid votes mark the fact unresolved', () => {
  const evaluated = evaluateConditionPolicy(question, {
    deadline: { distribution: { within_hour: 1, later: 0 }, meta: { requested: 7, valid: 0, invalid: 7 } },
    active_harm: { distribution: { true: 0.2, false: 0.8 } },
  });
  assert.deepEqual(evaluated.distribution, { true: 0, false: 1 });
  assert.equal(evaluated.meta.conditions.unknown_facts[0].reason, 'all_samples_invalid');
  assert.equal(evaluated.meta.conditions.default_reason, 'required_fact_unresolved');
});

test('first matching rule wins when multiple rules match the same facts', () => {
  const duplicate = {
    ...question,
    conditions: {
      ...question.conditions,
      rules: [
        { id: 'first', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'false' },
        { id: 'second', when: [{ fact: 'active_harm', op: 'eq', value: 'true' }], then: 'true' },
      ],
    },
  };
  const evaluated = evaluateConditionPolicy(duplicate, {
    deadline: { distribution: { within_hour: 0.8, later: 0.2 } },
    active_harm: { distribution: { true: 0.8, false: 0.2 } },
  });
  assert.equal(evaluated.distribution.false, 1);
  assert.equal(evaluated.distribution.true, 0);
  assert.equal(evaluated.meta.conditions.rule_probabilities.first, 0.8);
  assert.equal(evaluated.meta.conditions.rule_probabilities.second, 0);
  assert.equal(evaluated.meta.conditions.default_probability, 0.2);
});
