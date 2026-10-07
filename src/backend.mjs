// Backend adapter: turns typed questions into probability distributions
// using any OpenAI-compatible chat endpoint.
//
// Three modes:
//   verbalized — one call asks the model to emit JSON probabilities (cheap, ~1 call/question)
//   sampling   — N votes at temperature>0, empirical distribution (more honest, N calls/question)
//   logprobs   — one call reads the endpoint's first-token probabilities for option codes

import { optionsOf, normalizeDistribution } from './contract.mjs';

const stateText = (state) =>
  typeof state === 'string' ? state : JSON.stringify(state, null, 2);

function questionPrompt(id, q) {
  const lines = [`Question "${id}": ${q.instructions || 'answer about the state'}`];
  if (q.type === 'noul') {
    const t = q.criteria?.true ? ` (true means: ${q.criteria.true})` : '';
    const f = q.criteria?.false ? ` (false means: ${q.criteria.false})` : '';
    lines.push(`Type: yes/no.${t}${f}`);
  } else if (q.type === 'choice') {
    lines.push('Type: pick exactly one option.');
    for (const [k, d] of Object.entries(q.criteria)) lines.push(`  - "${k}": ${d}`);
  } else {
    lines.push('Type: ordered scale. Pick the level index that best fits.');
    q.criteria.forEach((d, i) => lines.push(`  - ${i}: ${d}`));
  }
  if (q.conditions) lines.push(...conditionPolicyPrompt(q.conditions));
  return lines.join('\n');
}

function conditionPolicyPrompt(conditions) {
  const lines = [
    `Condition policy v${conditions.version}: extract each fact from STATE, then apply rules in order. All conditions in a rule must match, and the first matching rule wins.`,
    'Do not invent facts. If a fact is unclear or no rule matches, use the explicit default outcome.',
    'Fact definitions:',
  ];
  for (const [id, fact] of Object.entries(conditions.facts)) {
    lines.push(...questionPrompt(id, fact).split('\n').map((line) => `  ${line}`));
  }
  lines.push('Rules:');
  conditions.rules.forEach((rule, index) => {
    const when = rule.when.map(({ fact, op, value }) => `${fact} ${op} ${JSON.stringify(value)}`).join(' AND ');
    lines.push(`  ${rule.id}. IF ${when} THEN ${JSON.stringify(rule.then)}`);
  });
  lines.push(`Default outcome: ${JSON.stringify(conditions.default)}`);
  return lines;
}

function buildVerbalizedPrompt(state, questions) {
  const qs = Object.entries(questions).map(([id, q]) => questionPrompt(id, q)).join('\n\n');
  const spec = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const opts = optionsOf(q);
    return [id, `{ "answer": "<one of ${opts.join('|')}>", "probabilities": { "${opts.join('": p, "')}": p } }`];
  }));
  return [
    'You are a decision layer. Evaluate the STATE and answer each typed question.',
    'Respond with STRICT JSON only: {"answers": {<id>: {"answer": ..., "probabilities": {...}}}}',
    'Rules: probabilities must cover every listed option, be numbers 0..1, and sum to ~1.',
    'Be epistemically honest: spread probability mass when uncertain; do not default to one option.',
    `Expected shape: ${JSON.stringify(spec)}`,
    '',
    'STATE:',
    stateText(state),
    '',
    'QUESTIONS:',
    qs,
  ].join('\n');
}

function buildVotePrompt(state, id, q) {
  const opts = optionsOf(q);
  return [
    'Answer the question about the STATE with exactly one of these tokens, nothing else:',
    opts.map(o => `"${o}"`).join(', '),
    '',
    'STATE:',
    stateText(state),
    '',
    questionPrompt(id, q),
  ].join('\n');
}

function buildLogprobsPrompt(state, id, q, codes) {
  const options = optionsOf(q);
  const codeOptions = options.map((option, i) => {
    const description = q.type === 'choice' ? q.criteria[option]
      : q.type === 'score' ? q.criteria[i]
        : q.criteria?.[option];
    return `${codes[i]}: ${option}${description ? ` — ${description}` : ''}`;
  });
  return [
    'Evaluate the STATE and answer the question.',
    'Choose exactly one uppercase option code. Reply with the code only, no punctuation or explanation.',
    '',
    'STATE:',
    stateText(state),
    '',
    questionPrompt(id, q),
    '',
    'Option codes:',
    ...codeOptions,
  ].join('\n');
}

async function chat(baseUrl, apiKey, model, prompt, {
  temperature = 0, maxTokens = 512, logprobs = false, topLogprobs = 20, reasoningEffort,
} = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...(logprobs ? { logprobs: true, top_logprobs: topLogprobs } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`backend ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage,
    logprobs: data.choices?.[0]?.logprobs,
  };
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('backend returned no JSON object');
  return JSON.parse(m[0]);
}

function tokenVote(text, options) {
  const t = text.trim().toLowerCase().replace(/^["'\s]+|["'\s.,;:!?]+$/g, '');
  // exact match first, then contains
  for (const o of options) if (t === o.toLowerCase()) return o;
  for (const o of options) if (t.includes(o.toLowerCase())) return o;
  return null;
}

function hasOptionProbability(raw, options) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) && options.some((option) => {
    const value = Number(raw[option]);
    return Number.isFinite(value) && value > 0;
  });
}

function responseDistribution(parsed, id, options, { singleQuestion = false } = {}) {
  const answers = parsed?.answers;
  const response = answers?.[id] ?? parsed?.[id] ?? (singleQuestion ? parsed : undefined);
  const probabilityMaps = [
    response?.probabilities,
    ...(singleQuestion ? [answers?.probabilities, answers, parsed?.probabilities] : []),
    response,
  ];
  for (const raw of probabilityMaps) {
    if (hasOptionProbability(raw, options)) return normalizeDistribution(raw, options);
  }
  const answer = typeof response === 'string' || typeof response === 'number' || typeof response === 'boolean'
    ? String(response)
    : response?.answer;
  return options.includes(answer) ? normalizeDistribution({ [answer]: 1 }, options) : null;
}

export class DecisionBackend {
  constructor({ baseUrl, apiKey, model, mode = 'verbalized', samples = 7, temperature = 0.8, reasoningEffort }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.mode = mode;
    this.samples = samples;
    this.temperature = temperature;
    this.reasoningEffort = reasoningEffort ?? (/^qwen3(?:[.:/-]|$)/i.test(model) ? 'none' : undefined);
  }

  async _sampleQuestion(state, id, q) {
    const options = optionsOf(q);
    const prompt = buildVotePrompt(state, id, q);
    const votes = Object.fromEntries(options.map(o => [o, 0]));
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let invalid = 0;
    const calls = Array.from({ length: this.samples }, () =>
      chat(this.baseUrl, this.apiKey, this.model, prompt, {
        temperature: this.temperature, maxTokens: 8, reasoningEffort: this.reasoningEffort,
      }));
    for (const r of await Promise.all(calls)) {
      const v = tokenVote(r.text, options);
      if (v) votes[v] += 1; else invalid++;
      if (r.usage) {
        usage.prompt_tokens += r.usage.prompt_tokens || 0;
        usage.completion_tokens += r.usage.completion_tokens || 0;
      }
    }
    return {
      dist: normalizeDistribution(votes, options),
      usage,
      sampleStats: { requested: this.samples, valid: this.samples - invalid, invalid },
    };
  }

  async _samplingFallback(state, id, q, reason, priorUsage) {
    const sampled = await this._sampleQuestion(state, id, q);
    return {
      ...sampled,
      usage: {
        prompt_tokens: (priorUsage?.prompt_tokens || 0) + sampled.usage.prompt_tokens,
        completion_tokens: (priorUsage?.completion_tokens || 0) + sampled.usage.completion_tokens,
      },
      meta: { distribution: 'sampling_fallback', reason },
    };
  }

  // returns { dist: {option: p}, usage, sampleStats?, meta? }
  async evalQuestion(state, id, q) {
    const options = optionsOf(q);
    if (this.mode === 'sampling') return this._sampleQuestion(state, id, q);
    if (this.mode === 'logprobs') {
      if (options.length > 20) {
        return this._samplingFallback(state, id, q, 'logprobs supports at most 20 option codes');
      }
      const codes = options.map((_, i) => String.fromCharCode(65 + i));
      const prompt = buildLogprobsPrompt(state, id, q, codes);
      const r = await chat(this.baseUrl, this.apiKey, this.model, prompt, {
        temperature: 0, maxTokens: 1, logprobs: true, topLogprobs: 20,
        reasoningEffort: this.reasoningEffort,
      });
      const alternatives = r.logprobs?.content?.[0]?.top_logprobs;
      const probabilities = Object.fromEntries(codes.map(code => [code, 0]));
      for (const alternative of alternatives ?? []) {
        if (typeof alternative.token !== 'string' || !Number.isFinite(alternative.logprob)) continue;
        const code = alternative.token.trim();
        if (Object.hasOwn(probabilities, code)) probabilities[code] += Math.exp(alternative.logprob);
      }
      if (codes.every(code => probabilities[code] > 0)) {
        const raw = Object.fromEntries(options.map((option, i) => [option, probabilities[codes[i]]]));
        return { dist: normalizeDistribution(raw, options), usage: r.usage, meta: { distribution: 'token_logprobs' } };
      }
      return this._samplingFallback(
        state, id, q, 'endpoint did not return logprobs for every option code', r.usage,
      );
    }
    // verbalized single-question call (also used as per-question path inside batch failure)
    const prompt = buildVerbalizedPrompt(state, { [id]: q });
    const r = await chat(this.baseUrl, this.apiKey, this.model, prompt, {
      temperature: 0, maxTokens: 256, reasoningEffort: this.reasoningEffort,
    });
    const parsed = extractJson(r.text);
    const dist = responseDistribution(parsed, id, options, { singleQuestion: true });
    if (!dist) throw new Error(`backend returned no valid answer/probabilities for question "${id}"`);
    return { dist, usage: r.usage };
  }

  async _evaluateVerbalizedFallback(state, questions, usage) {
    const dists = {};
    for (const [id, q] of Object.entries(questions)) {
      const r = await this.evalQuestion(state, id, q);
      dists[id] = r.dist;
      if (r.usage) {
        usage.prompt_tokens = (usage.prompt_tokens || 0) + (r.usage.prompt_tokens || 0);
        usage.completion_tokens = (usage.completion_tokens || 0) + (r.usage.completion_tokens || 0);
        if (usage.total_tokens != null || r.usage.total_tokens != null) {
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
      }
    }
    return { dists, usage };
  }

  // batch verbalized questions once; logprobs and sampling run per question
  async evaluate(state, questions) {
    const out = {};
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    if (this.mode === 'verbalized') {
      let parsed;
      try {
        const prompt = buildVerbalizedPrompt(state, questions);
        const r = await chat(this.baseUrl, this.apiKey, this.model, prompt, {
          temperature: 0, maxTokens: 1024, reasoningEffort: this.reasoningEffort,
        });
        if (r.usage) usage = { ...r.usage };
        parsed = extractJson(r.text);
      } catch {
        return this._evaluateVerbalizedFallback(state, questions, usage);
      }
      const missing = {};
      const singleQuestion = Object.keys(questions).length === 1;
      for (const [id, q] of Object.entries(questions)) {
        const dist = responseDistribution(parsed, id, optionsOf(q), { singleQuestion });
        if (dist) out[id] = dist;
        else missing[id] = q;
      }
      if (Object.keys(missing).length > 0) {
        const fallback = await this._evaluateVerbalizedFallback(state, missing, usage);
        return { dists: { ...out, ...fallback.dists }, usage: fallback.usage };
      }
      return { dists: out, usage };
    }
    const meta = {};
    for (const [id, q] of Object.entries(questions)) {
      const r = await this.evalQuestion(state, id, q);
      out[id] = r.dist;
      if (r.meta || r.sampleStats) meta[id] = { ...r.sampleStats, ...r.meta };
      if (r.usage) {
        usage.prompt_tokens += r.usage.prompt_tokens || 0;
        usage.completion_tokens += r.usage.completion_tokens || 0;
      }
    }
    return { dists: out, usage, meta };
  }
}
