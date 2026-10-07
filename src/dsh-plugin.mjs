import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDecisionRuntime, toolDefinitions } from './runtime.mjs';
import { manifest } from './manifest.mjs';

export const name = manifest.name;
export const inject = ['tools'];
export const Config = z.object({});

function parametersFor(name) {
  if (name === 'evaluate') {
    return {
      state: { type: 'json', required: true, description: 'Text or JSON state to evaluate.' },
      questions: { type: 'json', required: true, description: 'Map question IDs to Jev definitions. Optional conditions v1 extracts typed facts, applies first-match rules locally, and composes probabilities assuming independent facts.' },
    };
  }
  if (name === 'record_outcome') {
    return {
      decision_id: { type: 'string', required: true },
      outcome: { type: 'json', required: true },
      note: { type: 'string' },
    };
  }
  return {};
}

export async function apply(ctx, config = {}) {
  const runtime = createDecisionRuntime({ options: config });
  for (const definition of toolDefinitions) {
    ctx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      parameters: parametersFor(definition.name),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: (args) => runtime.callTool(definition.name, args),
    }));
  }
}
