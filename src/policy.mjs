import { marginConfidence, normalizeDistribution, optionsOf } from './contract.mjs';

const epsilon = 1e-9;

function conditionMatches(clause, facts) {
  const actual = facts[clause.fact];
  if (clause.op === 'eq') return String(actual) === String(clause.value);
  if (clause.op === 'neq') return String(actual) !== String(clause.value);
  if (clause.op === 'in') return clause.value.some((value) => String(actual) === String(value));
  if (clause.op === 'not_in') return clause.value.every((value) => String(actual) !== String(value));
  const value = Number(actual), threshold = Number(clause.value);
  if (clause.op === 'lt') return value < threshold;
  if (clause.op === 'lte') return value <= threshold;
  if (clause.op === 'gt') return value > threshold;
  return value >= threshold;
}

function normalizedFact(fact, extracted) {
  const meta = extracted?.meta;
  const options = optionsOf(fact);
  const raw = extracted?.distribution;
  const values = options.map((option) => Number(raw?.[option]));
  const invalid = !raw
    || values.some((value) => !Number.isFinite(value) || value < 0)
    || values.reduce((sum, value) => sum + value, 0) <= 0;
  const distribution = invalid ? null : normalizeDistribution(raw, options);
  const flatTolerance = options.length * 0.0005 + epsilon;
  const flat = !invalid && values.every((value) => Math.abs(value - values[0]) <= flatTolerance);

  let reason;
  if (!extracted || !raw) reason = 'missing_or_invalid_fact';
  else if (invalid) reason = 'invalid_distribution';
  else if (meta?.confidence_unreliable) reason = 'confidence_unreliable';
  else if (meta?.valid === 0) reason = 'all_samples_invalid';
  else if (flat) reason = 'flat_distribution';
  if (reason) return { reason, distribution };

  const answer = options.reduce((top, option) => distribution[option] > distribution[top] ? option : top);
  return {
    answer,
    distribution,
    confidence: extracted.confidence ?? marginConfidence(distribution),
    source: meta?.distribution,
  };
}

function oneHot(question, option) {
  return Object.fromEntries(optionsOf(question).map((candidate) => [candidate, candidate === option ? 1 : 0]));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function evaluateConditionPolicy(question, extractedFacts, { extractionError = false } = {}) {
  const conditions = question.conditions;
  const factSummaries = {};
  const factDistributions = {};
  const unknownFacts = [];

  for (const [id, fact] of Object.entries(conditions.facts)) {
    const extracted = normalizedFact(fact, extractedFacts[id]);
    if (extracted.reason) {
      unknownFacts.push({ id, reason: extractionError ? 'fact_extraction_failed' : extracted.reason });
      factSummaries[id] = {
        answer: null,
        probabilities: extracted.distribution ?? null,
        confidence: 0,
      };
    } else {
      factDistributions[id] = extracted.distribution;
      factSummaries[id] = {
        answer: extracted.answer,
        probabilities: extracted.distribution,
        confidence: round3(extracted.confidence),
        ...(extracted.source ? { distribution_source: extracted.source } : {}),
      };
    }
  }

  const outputOptions = optionsOf(question);
  if (extractionError || unknownFacts.length) {
    return {
      distribution: oneHot(question, conditions.default),
      meta: {
        conditions: {
          version: conditions.version,
          distribution: 'declared_default',
          defaulted: true,
          default_probability: 1,
          default_reason: extractionError ? 'fact_extraction_failed' : 'required_fact_unresolved',
          unknown_facts: unknownFacts,
          facts: factSummaries,
        },
      },
    };
  }

  const outputMass = Object.fromEntries(outputOptions.map((option) => [option, 0]));
  const ruleMass = Object.fromEntries(conditions.rules.map((rule) => [rule.id, 0]));
  let defaultMass = 0;
  const factIds = Object.keys(conditions.facts);
  const factValues = {};

  function visit(index, weight) {
    if (index === factIds.length) {
      const matched = conditions.rules.find((rule) => rule.when.every((clause) => conditionMatches(clause, factValues)));
      if (matched) {
        outputMass[matched.then] += weight;
        ruleMass[matched.id] += weight;
      } else {
        outputMass[conditions.default] += weight;
        defaultMass += weight;
      }
      return;
    }
    const id = factIds[index];
    for (const [value, probability] of Object.entries(factDistributions[id])) {
      if (probability <= 0) continue;
      factValues[id] = value;
      visit(index + 1, weight * probability);
    }
    delete factValues[id];
  }

  visit(0, 1);
  return {
    distribution: normalizeDistribution(outputMass, outputOptions),
    meta: {
      conditions: {
        version: conditions.version,
        distribution: 'independent_fact_marginals',
        assumption: 'Fact distributions are treated as independent when composed through rules.',
        defaulted: defaultMass > epsilon,
        default_probability: round3(defaultMass),
        rule_probabilities: Object.fromEntries(Object.entries(ruleMass).map(([id, value]) => [id, round3(value)])),
        facts: factSummaries,
      },
    },
  };
}
