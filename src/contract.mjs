// Jev-compatible contract: validates questions, shapes answers.
// Response format mirrors typesafe/jev:
//   noul:   { type:'noul', noul:P(yes) }
//   choice: { type:'choice', choice:key, confidence, probabilities:{k:p} }
//   score:  { type:'score', score:E[level], confidence, legend:{i:label}, probabilities:{i:p} }

export const MAX_CONDITION_COMBINATIONS = 4096;

export function validateQuestions(questions) {
  if (!isRecord(questions)) throw new Error('questions must be an object keyed by question id');
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error('questions must not be empty');
  for (const [id, question] of Object.entries(questions)) validateQuestion(id, question);
  return questions;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateQuestion(id, question, allowConditions = true) {
  if (!isRecord(question)) throw new Error(`question "${id}" must be an object`);
  if (!['noul', 'choice', 'score'].includes(question.type)) {
    throw new Error(`question "${id}" has invalid type "${question.type}" (noul|choice|score)`);
  }
  if (question.type === 'choice' && (!isRecord(question.criteria) || Object.keys(question.criteria).length < 2)) {
    throw new Error(`choice question "${id}" needs criteria = {option: description} with >=2 options`);
  }
  if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2)) {
    throw new Error(`score question "${id}" needs criteria = ordered array of >=2 level descriptions`);
  }
  if (question.type === 'noul' && question.criteria !== undefined && !isRecord(question.criteria)) {
    throw new Error(`noul question "${id}" criteria must be {true:..., false:...} if present`);
  }
  if (question.conditions !== undefined) {
    if (!allowConditions) throw new Error(`condition fact "${id}" cannot have nested conditions`);
    validateConditions(id, question, question.conditions);
  }
}

function validateConditions(id, question, conditions) {
  if (!isRecord(conditions)) throw new Error(`question "${id}" conditions must be an object`);
  if (conditions.version !== 1) throw new Error(`question "${id}" conditions version must be 1`);
  if (!isRecord(conditions.facts) || Object.keys(conditions.facts).length === 0) {
    throw new Error(`question "${id}" conditions needs a non-empty facts object`);
  }
  for (const [factId, fact] of Object.entries(conditions.facts)) {
    validateQuestion(`${id}.${factId}`, fact, false);
  }
  const combinations = Object.values(conditions.facts).reduce((count, fact) => count * optionsOf(fact).length, 1);
  if (combinations > MAX_CONDITION_COMBINATIONS) {
    throw new Error(`question "${id}" conditions exceed the ${MAX_CONDITION_COMBINATIONS} fact-combination limit`);
  }
  if (!Array.isArray(conditions.rules) || conditions.rules.length === 0) {
    throw new Error(`question "${id}" conditions needs an ordered rules array`);
  }

  const outcomes = optionsOf(question);
  const ruleIds = new Set();
  for (const [index, rule] of conditions.rules.entries()) {
    if (!isRecord(rule) || typeof rule.id !== 'string' || !rule.id.trim() || ruleIds.has(rule.id)) {
      throw new Error(`condition rule ${index} for "${id}" needs a unique non-empty id`);
    }
    ruleIds.add(rule.id);
    if (!Array.isArray(rule.when) || rule.when.length === 0) {
      throw new Error(`condition rule ${index} for "${id}" needs a non-empty when array`);
    }
    if (typeof rule.then !== 'string' || !outcomes.includes(rule.then)) {
      throw new Error(`condition rule ${index} for "${id}" then value must be a valid outcome option`);
    }
    for (const clause of rule.when) {
      if (!isRecord(clause) || typeof clause.fact !== 'string' || !Object.hasOwn(conditions.facts, clause.fact)) {
        throw new Error(`condition rule ${index} for "${id}" references an unknown fact`);
      }
      validateConditionClause(id, clause, conditions.facts[clause.fact]);
    }
  }
  if (typeof conditions.default !== 'string' || !outcomes.includes(conditions.default)) {
    throw new Error(`question "${id}" conditions default outcome must be a valid option`);
  }
}

function validateConditionClause(questionId, clause, fact) {
  const options = optionsOf(fact);
  const validOps = ['eq', 'neq', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte'];
  if (!validOps.includes(clause.op)) throw new Error(`condition for "${questionId}" has invalid operator "${clause.op}"`);
  if (['lt', 'lte', 'gt', 'gte'].includes(clause.op)) {
    const value = clause.value;
    const numeric = (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
    if (fact.type !== 'score' || !numeric) {
      throw new Error(`condition for "${questionId}" uses a numeric operator on a non-score fact`);
    }
    return;
  }
  const listOperator = ['in', 'not_in'].includes(clause.op);
  const values = listOperator ? clause.value : [clause.value];
  if (!Array.isArray(values) || values.length === 0 || values.some((value) =>
    !['string', 'number', 'boolean'].includes(typeof value) || !options.includes(String(value)))) {
    throw new Error(`condition for "${questionId}" has a value that is not a valid value for fact "${clause.fact}"`);
  }
}

// Normalize a raw probability map so it covers all options and sums to 1.
export function normalizeDistribution(raw, options) {
  const dist = {};
  let sum = 0;
  for (const opt of options) {
    const v = Number(raw?.[opt]);
    const p = Number.isFinite(v) && v > 0 ? v : 0;
    dist[opt] = p;
    sum += p;
  }
  if (sum <= 0) {
    // uniform fallback — honestly uncertain
    const u = 1 / options.length;
    for (const opt of options) dist[opt] = u;
    return dist;
  }
  for (const opt of options) dist[opt] = round3(dist[opt] / sum);
  // fix rounding drift on the argmax
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) {
    const top = options.reduce((a, b) => (dist[a] >= dist[b] ? a : b));
    dist[top] = round3(dist[top] + (1 - total));
  }
  return dist;
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// Jev-style confidence = margin, not probability-of-correctness.
// noul: |p - 0.5| * 2   (0 = coin flip, 1 = certain)
// choice/score: top1 - top2 spread   (0 = tie, 1 = dominant)
export function marginConfidence(dist) {
  const vals = Object.values(dist).sort((a, b) => b - a);
  if (vals.length === 1) return 1;
  return round3(Math.max(0, Math.min(1, vals[0] - vals[1])));
}

export function shapeAnswer(q, dist) {
  const conf = marginConfidence(dist);
  if (q.type === 'noul') {
    const p = dist['true'] ?? 0.5;
    return {
      type: 'noul',
      noul: round3(p),
      confidence: round3(Math.abs(p - 0.5) * 2),
      probabilities: { true: round3(p), false: round3(1 - p) },
    };
  }
  if (q.type === 'choice') {
    const options = Object.keys(q.criteria);
    const top = options.reduce((a, b) => (dist[a] >= dist[b] ? a : b));
    return { type: 'choice', choice: top, confidence: conf, probabilities: dist };
  }
  // score
  const levels = q.criteria.map((_, i) => String(i));
  const expected = levels.reduce((acc, k) => acc + Number(k) * (dist[k] ?? 0), 0);
  const legend = {};
  q.criteria.forEach((label, i) => { legend[String(i)] = label; });
  return { type: 'score', score: round3(expected), confidence: conf, legend, probabilities: dist };
}

export function optionsOf(q) {
  if (q.type === 'noul') return ['true', 'false'];
  if (q.type === 'choice') return Object.keys(q.criteria);
  return q.criteria.map((_, i) => String(i));
}
