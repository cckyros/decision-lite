#!/usr/bin/env node
// decision-lite: Jev-compatible decision layer as an MCP stdio server.
// Env config:
//   DECISION_BASE_URL   OpenAI-compatible base, e.g. https://open.bigmodel.cn/api/paas/v4
//   DECISION_API_KEY    bearer key (optional for local servers)
//   DECISION_MODEL      model name, e.g. glm-5.3-flash / deepseek-chat / qwen3.5-4b
//   DECISION_MODE       verbalized (default) | sampling | logprobs
//   DECISION_SAMPLES    votes per question in sampling mode (default 7)
//   DECISION_TEMPERATURE sampling temperature (default 0.8)
//   DECISION_LOG        decision log path (default ./decisions.jsonl next to cwd, or %DECISION_LOG%)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDecisionRuntime } from './runtime.mjs';
import { manifest } from './manifest.mjs';

const runtime = createDecisionRuntime();
const server = new Server(
  { name: manifest.name, version: manifest.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: runtime.tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await runtime.callTool(name, args ?? {});
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, name === 'decision_stats' ? 2 : undefined),
      }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `decision-lite error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
