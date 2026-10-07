import { resolve } from 'node:path';
import { DecisionBackend } from './backend.mjs';
import { validateQuestions, shapeAnswer } from './contract.mjs';
import { DecisionLog } from './log.mjs';
import { NeedleBackend } from './needle-backend.mjs';
import { LayaBackend } from './laya-backend.mjs';
import { manifest } from './manifest.mjs';
import { evaluateConditionPolicy } from './policy.mjs';

const factDefinitionSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['noul', 'choice', 'score'] },
    instructions: { type: 'string' },
    criteria: { description: 'noul map, choice option map, or ordered score labels' },
  },
  additionalProperties: true,
};

const conditionClauseSchema = {
  type: 'object',
  required: ['fact', 'op', 'value'],
  properties: {
    fact: { type: 'string' },
    op: { type: 'string', enum: ['eq', 'neq', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte'] },
    value: {},
  },
  additionalProperties: false,
};

const conditionsSchema = {
  type: 'object',
  description: 'Versioned fact and rule table. The runtime extracts facts with the configured backend, evaluates ordered rules locally, and composes output probabilities assuming independent fact marginals.',
  required: ['version', 'facts', 'rules', 'default'],
  properties: {
    version: { const: 1 },
    facts: { type: 'object', minProperties: 1, description: 'Cartesian fact-option combinations are limited to 4096.', additionalProperties: factDefinitionSchema },
    rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'when', 'then'],
        properties: {
          id: { type: 'string' },
          when: { type: 'array', minItems: 1, items: conditionClauseSchema },
          then: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    default: { type: 'string', description: 'A valid output option used if no rule matches or a fact is unknown.' },
  },
  additionalProperties: false,
};

const questionDefinitionSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['noul', 'choice', 'score'] },
    instructions: { type: 'string' },
    criteria: { description: 'noul map, choice option map, or ordered score labels' },
    conditions: conditionsSchema,
  },
  additionalProperties: true,
};

export const toolDefinitions = [
  {
    name: 'evaluate',
    description: 'Jev-compatible decision call. Send a state and typed questions (noul/choice/score); get back answers with probability distributions and confidence. Use for routing, classification, scoring, escalation gating — not for open-ended generation.',
    inputSchema: {
      type: 'object',
      required: ['state', 'questions'],
      properties: {
        state: { description: 'Text or JSON the questions are about' },
        questions: {
          type: 'object',
          minProperties: 1,
          description: 'Map questionId to a Jev question. Optional conditions v1 defines typed fact extractors, ordered local rules, and a default outcome. Output probabilities are composed from fact marginals under an independence assumption.',
          additionalProperties: questionDefinitionSchema,
        },
      },
    },
  },
  {
    name: 'record_outcome',
    description: 'Attach ground truth to a past evaluate() call for calibration tracking. outcome: boolean applied to all answers, or {questionId: boolean}.',
    inputSchema: {
      type: 'object',
      required: ['decision_id', 'outcome'],
      properties: { decision_id: { type: 'string' }, outcome: {}, note: { type: 'string' } },
    },
  },
  {
    name: 'decision_stats',
    description: 'Calibration report: confidence buckets vs observed accuracy from recorded outcomes. Shows whether high-confidence answers are actually right that often.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function runtimeConfig(options, env) {
  // DECISION_* is canonical; JEV_* kept as legacy alias for pre-rename configs.
  const value = (key, envKey, fallback) =>
    options[key] ?? env[envKey] ?? env[`JEV_${envKey.slice(9)}`] ?? fallback;
  const dataDir = value('dataDir', 'DECISION_DATA_DIR', undefined);
  return {
    backend: value('backend', 'DECISION_BACKEND', 'needle'),
    baseUrl: value('baseUrl', 'DECISION_BASE_URL', 'http://127.0.0.1:11434/v1'),
    apiKey: value('apiKey', 'DECISION_API_KEY', ''),
    model: value('model', 'DECISION_MODEL', 'qwen3.5-4b'),
    mode: value('mode', 'DECISION_MODE', 'verbalized'),
    samples: Number(value('samples', 'DECISION_SAMPLES', 7)),
    temperature: Number(value('temperature', 'DECISION_TEMPERATURE', 0.8)),
    python: value('python', 'DECISION_PYTHON', 'python'),
    needleGeneration: Number(value('needleGeneration', 'DECISION_NEEDLE_GENERATION', 3)),
    layaModel: value('layaModel', 'DECISION_LAYA_MODEL', undefined),
    layaWarmup: !/^(0|off|false|no)$/i.test(String(value('layaWarmup', 'DECISION_LAYA_WARMUP', '1'))),
    logPath: value('logPath', 'DECISION_LOG', dataDir ? resolve(dataDir, 'decisions.jsonl') : resolve(process.cwd(), 'decisions.jsonl')),
  };
}

function combineUsage(...usages) {
  const total = {};
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
    }
  }
  return Object.keys(total).length ? total : undefined;
}

export function createDecisionRuntime({ env = process.env, options = {} } = {}) {
  const cfg = runtimeConfig(options, env);
  const log = new DecisionLog(cfg.logPath);
  const backend = options.backendImpl ?? (cfg.backend === 'needle'
    ? new NeedleBackend({ python: cfg.python, generation: cfg.needleGeneration })
    : cfg.backend === 'laya'
      ? new LayaBackend({ python: cfg.python, model: cfg.layaModel })
      : new DecisionBackend(cfg));

  // Laya checkpoints cold-build in ~10s each on first predict; kick a preload
  // now so a real evaluate() does not wait on it. Fire-and-forget — warmup
  // must not block the MCP handshake, and a failure just leaves lazy loading.
  if (cfg.backend === 'laya' && cfg.layaWarmup && typeof backend.warmup === 'function') {
    Promise.resolve(backend.warmup()).then((r) => {
      if (r?.error) process.stderr.write(`decision-lite: laya warmup failed: ${r.error}\n`);
      else if (r?.errors) process.stderr.write(`decision-lite: laya warmup partial: ${JSON.stringify(r.errors)}\n`);
    }).catch(() => {});
  }

  async function callTool(name, args = {}) {
    if (name === 'evaluate') {
      const questions = validateQuestions(args.questions);
      const modelQuestions = {};
      const policyFactQuestions = {};
      const factRefs = new Map();
      let nextFactId = 0;
      for (const [id, question] of Object.entries(questions)) {
        if (!question.conditions) {
          modelQuestions[id] = question;
          continue;
        }
        const refs = {};
        for (const [factId, factQuestion] of Object.entries(question.conditions.facts)) {
          let backendId;
          do { backendId = `__decision_policy_fact_${nextFactId++}`; }
          while (Object.hasOwn(questions, backendId) || Object.hasOwn(policyFactQuestions, backendId));
          policyFactQuestions[backendId] = factQuestion;
          refs[factId] = backendId;
        }
        factRefs.set(id, refs);
      }

      const direct = Object.keys(modelQuestions).length
        ? await backend.evaluate(args.state, modelQuestions)
        : { dists: {}, confidences: {}, meta: {} };
      let extracted = { dists: {}, confidences: {}, meta: {} };
      let factExtractionError = false;
      if (Object.keys(policyFactQuestions).length) {
        try {
          extracted = await backend.evaluate(args.state, policyFactQuestions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof SyntaxError || /backend returned no (?:JSON object|valid answer\/probabilities)/i.test(message)) {
            factExtractionError = true;
          } else {
            throw error;
          }
        }
      }

      const dists = { ...direct.dists };
      const confidences = { ...direct.confidences };
      const meta = { ...direct.meta };
      for (const [id, question] of Object.entries(questions)) {
        if (!question.conditions) continue;
        const factInputs = Object.fromEntries(Object.entries(factRefs.get(id)).map(([factId, backendId]) => [factId, {
          distribution: extracted.dists?.[backendId],
          confidence: extracted.confidences?.[backendId],
          meta: extracted.meta?.[backendId],
        }]));
        const evaluated = evaluateConditionPolicy(question, factInputs, { extractionError: factExtractionError });
        dists[id] = evaluated.distribution;
        meta[id] = evaluated.meta;
      }

      const usage = combineUsage(direct.usage, extracted.usage);
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = shapeAnswer(q, dists[id]);
        if (confidences[id] != null) answers[id].confidence = confidences[id];
        if (meta[id]) answers[id].meta = meta[id];
        if (meta[id]?.conditions?.distribution === 'declared_default') answers[id].confidence = 0;
      }
      const model = cfg.backend === 'needle' ? `needle-${cfg.needleGeneration}`
        : cfg.backend === 'laya' ? `laya-${cfg.layaModel ?? 'router'}`
        : cfg.model;
      const mode = cfg.backend === 'needle' ? 'needle'
        : cfg.backend === 'laya' ? 'laya'
        : cfg.mode;
      const decisionId = log.recordDecision({ state: args.state, questions, answers, model, mode, usage });
      return { backend: cfg.backend, model, mode, answers, usage, decision_id: decisionId };
    }
    if (name === 'record_outcome') {
      const recorded = log.recordOutcome(args.decision_id, args.outcome, args.note);
      return { ok: true, recorded };
    }
    if (name === 'decision_stats') return log.stats();
    throw new Error(`unknown tool ${name}`);
  }

  return {
    name: manifest.name,
    version: manifest.version,
    tools: toolDefinitions,
    callTool,
    close: async () => { await backend.close?.(); },
  };
}
