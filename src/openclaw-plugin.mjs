import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { Type } from 'typebox';
import { createDecisionRuntime, toolDefinitions } from './runtime.mjs';
import { manifest } from './manifest.mjs';

const questionKinds = Type.Union([Type.Literal('noul'), Type.Literal('choice'), Type.Literal('score')]);
const conditionFact = Type.Object({
  type: questionKinds,
  instructions: Type.Optional(Type.String()),
  criteria: Type.Any(),
}, { additionalProperties: true });
const conditionPolicy = Type.Object({
  version: Type.Literal(1),
  facts: Type.Record(Type.String(), conditionFact),
  rules: Type.Array(Type.Object({
    id: Type.String(),
    when: Type.Array(Type.Object({
      fact: Type.String(),
      op: Type.Union(['eq', 'neq', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte'].map((op) => Type.Literal(op))),
      value: Type.Any(),
    }, { additionalProperties: false })),
    then: Type.String(),
  }, { additionalProperties: false })),
  default: Type.String(),
}, { additionalProperties: false, description: 'Facts are extracted by the configured backend. Rules are applied locally; output probabilities assume independent fact marginals.' });
const questionDefinition = Type.Object({
  type: questionKinds,
  instructions: Type.Optional(Type.String()),
  criteria: Type.Any(),
  conditions: Type.Optional(conditionPolicy),
}, { additionalProperties: true });

const schemas = {
  evaluate: Type.Object({
    state: Type.Any(),
    questions: Type.Record(Type.String(), questionDefinition),
  }),
  record_outcome: Type.Object({
    decision_id: Type.String(),
    outcome: Type.Any(),
    note: Type.Optional(Type.String()),
  }),
  decision_stats: Type.Object({}),
};

const labels = {
  evaluate: 'Evaluate',
  record_outcome: 'Record Outcome',
  decision_stats: 'Decision Stats',
};

let runtime;

function createTool(definition) {
  const parameters = schemas[definition.name];
  return () => ({
    name: definition.name,
    label: labels[definition.name],
    description: definition.description,
    parameters,
    factory: ({ config }) => ({
      name: definition.name,
      label: labels[definition.name],
      description: definition.description,
      parameters,
      execute: async (_toolCallId, params) => {
        runtime ??= createDecisionRuntime({ options: config ?? {} });
        return jsonResult(await runtime.callTool(definition.name, params));
      },
    }),
  });
}

export default defineToolPlugin({
  id: manifest.brand,
  name: 'Decision Lite',
  description: manifest.description,
  configSchema: Type.Object({
    dataDir: Type.Optional(Type.String()),
    backend: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    mode: Type.Optional(Type.String()),
    samples: Type.Optional(Type.Number()),
    temperature: Type.Optional(Type.Number()),
    python: Type.Optional(Type.String()),
    needleGeneration: Type.Optional(Type.Number()),
  }),
  tools: (tool) => toolDefinitions.map((definition) => tool(createTool(definition)())),
});
