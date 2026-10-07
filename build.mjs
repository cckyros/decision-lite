import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './src/manifest.mjs';
import { toolDefinitions } from './src/runtime.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const openclawDist = join(root, 'openclaw-dist');
const vars = {
  name: manifest.name,
  brand: manifest.brand,
  version: manifest.version,
  description: manifest.description,
  skillDir: manifest.markers.skillDir,
};
const fill = (text) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => vars[key] ?? `{{${key}}}`);

await mkdir(dist, { recursive: true });
await mkdir(openclawDist, { recursive: true });
await Promise.all([
  build({ entryPoints: [join(root, 'src/cli.mjs')], outfile: join(dist, 'cli.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node18' }),
  build({ entryPoints: [join(root, 'src/openclaw-plugin.mjs')], outfile: join(dist, 'openclaw-plugin.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node18', external: ['openclaw/plugin-sdk/*'] }),
  build({ entryPoints: [join(root, 'src/dsh-plugin.mjs')], outfile: join(dist, 'dsh-plugin.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node18', external: ['@deepseek-ai/*'] }),
]);

const pluginJson = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: manifest.brand,
  version: manifest.version,
  description: manifest.description,
  license: 'MIT',
  keywords: [manifest.name, 'mcp', 'agent-plugins', 'agent-skills', 'decision-layer'],
};
await writeFile(join(root, 'plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`);

const mcpJson = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    [manifest.name]: { type: 'stdio', command: 'npx', args: ['-y', manifest.name, 'mcp'] },
  },
};
await writeFile(join(root, 'mcp.json'), `${JSON.stringify(mcpJson, null, 2)}\n`);
// .mcp.json is the local registration for this checkout: run the built bundle
// directly so it works before the package exists on npm. This checkout serves
// the local laya backend; PATH `python` must have `laya` installed (torch CPU).
// hf-mirror keeps checkpoint downloads working where huggingface.co is not.
const localMcpJson = {
  $schema: mcpJson.$schema,
  mcpServers: {
    [manifest.name]: {
      type: 'stdio', command: 'node', args: [join(root, 'dist', 'cli.mjs'), 'mcp'],
      env: { DECISION_BACKEND: 'laya', HF_ENDPOINT: 'https://hf-mirror.com' },
    },
  },
};
await writeFile(join(root, '.mcp.json'), `${JSON.stringify(localMcpJson, null, 2)}\n`);

const marketplaceJson = {
  name: manifest.name,
  owner: { name: manifest.brand },
  metadata: { description: manifest.description, version: manifest.version },
  plugins: [{ name: manifest.brand, source: '.', description: manifest.description, version: manifest.version, license: 'MIT' }],
};
await writeFile(join(root, 'marketplace.json'), `${JSON.stringify(marketplaceJson, null, 2)}\n`);

const openclawPluginJson = {
  id: manifest.brand,
  name: manifest.brand,
  description: manifest.description,
  version: manifest.version,
  configSchema: {
    type: 'object',
    properties: {
      dataDir: { type: 'string' }, backend: { type: 'string' }, baseUrl: { type: 'string' },
      model: { type: 'string' }, mode: { type: 'string' },
      samples: { type: 'number' }, temperature: { type: 'number' }, python: { type: 'string' },
      needleGeneration: { type: 'number' },
    },
    additionalProperties: false,
  },
  activation: { onStartup: true },
  contracts: { tools: toolDefinitions.map(({ name }) => name) },
};
await writeFile(join(root, 'openclaw.plugin.json'), `${JSON.stringify(openclawPluginJson, null, 2)}\n`);

const dshPluginJson = {
  name: manifest.brand,
  description: manifest.description,
  version: manifest.version,
  entry: { name: manifest.name, inject: ['tools'] },
  client: { platform: 'node' },
};
await writeFile(join(root, 'dsh.plugin.json'), `${JSON.stringify(dshPluginJson, null, 2)}\n`);
await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n    - id: ${manifest.brand}\n      name: "${manifest.name}"\n      config: {}\n`);

const skillSource = await readFile(join(root, 'src/skill.md'), 'utf8');
const skillDir = join(root, 'skills', manifest.markers.skillDir);
await mkdir(skillDir, { recursive: true });
await writeFile(join(skillDir, 'SKILL.md'), fill(skillSource));
await cp(join(dist, 'openclaw-plugin.mjs'), join(openclawDist, 'openclaw-plugin.mjs'));
await writeFile(join(openclawDist, 'package.json'), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  type: 'module',
  main: 'openclaw-plugin.mjs',
  openclaw: { extensions: ['./openclaw-plugin.mjs'] },
}, null, 2)}\n`);

process.stdout.write(`build ok: CLI, OpenClaw and DSH bundles + 22-target plugin metadata (${manifest.name} v${manifest.version})\n`);
