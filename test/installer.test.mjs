import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTargets, runInstaller } from '../src/installer.mjs';
import { manifest } from '../src/manifest.mjs';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-install-'));
  const home = mkdtempSync(join(tmpdir(), 'jev-home-'));
  const output = [];
  return {
    dir,
    home,
    output,
    options: {
      cwd: dir,
      home,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), PATH: '' },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    },
  };
}

test('generated MCP and native plugin descriptors share Decision Lite identity', () => {
  const plugin = JSON.parse(readFileSync('plugin.json', 'utf8'));
  const mcp = JSON.parse(readFileSync('mcp.json', 'utf8'));
  const dotMcp = readFileSync('.mcp.json', 'utf8');
  const openclaw = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'));
  const openclawPackage = JSON.parse(readFileSync('openclaw-dist/package.json', 'utf8'));
  const dsh = JSON.parse(readFileSync('dsh.plugin.json', 'utf8'));

  assert.equal(plugin.name, manifest.brand);
  assert.equal(plugin.version, manifest.version);
  assert.equal(mcp.mcpServers[manifest.name].args.at(-1), 'mcp');
  // .mcp.json is the local registration: it runs the built bundle via node
  // (works before npm publish) instead of npx like the shipped mcp.json.
  const dotMcpJson = JSON.parse(dotMcp);
  assert.equal(dotMcpJson.mcpServers[manifest.name].command, 'node');
  assert.match(dotMcpJson.mcpServers[manifest.name].args[0], /dist[\\/]cli\.mjs$/);
  assert.equal(dotMcpJson.mcpServers[manifest.name].args.at(-1), 'mcp');
  assert.deepEqual(openclaw.contracts.tools, ['evaluate', 'record_outcome', 'decision_stats']);
  assert.equal(openclaw.configSchema.properties.apiKey, undefined);
  assert.equal(openclawPackage.openclaw.extensions[0], './openclaw-plugin.mjs');
  assert.equal(dsh.entry.name, manifest.name);
});

test('generated plugin descriptors share package identity and expose all Jev tools', () => {
  const readJson = (file) => JSON.parse(readFileSync(join(process.cwd(), file), 'utf8'));
  const plugin = readJson('plugin.json');
  const mcp = readJson('mcp.json');
  const openclaw = readJson('openclaw.plugin.json');
  const openclawPackage = readJson('openclaw-dist/package.json');
  const dsh = readJson('dsh.plugin.json');
  assert.equal(plugin.name, manifest.brand);
  assert.equal(plugin.version, manifest.version);
  assert.deepEqual(mcp.mcpServers[manifest.name].args, ['-y', manifest.name, 'mcp']);
  const localMcp = readJson('.mcp.json');
  assert.equal(localMcp.mcpServers[manifest.name].command, 'node');
  assert.equal(localMcp.mcpServers[manifest.name].args.at(-1), 'mcp');
  assert.deepEqual(openclaw.contracts.tools, ['evaluate', 'record_outcome', 'decision_stats']);
  assert.equal(openclaw.configSchema.properties.apiKey, undefined);
  assert.equal(openclawPackage.openclaw.extensions[0], './openclaw-plugin.mjs');
  assert.equal(dsh.entry.name, manifest.name);
});

test('target catalog contains the 22 goal-acceptance platform IDs by adapter kind', () => {
  const targets = listTargets();
  assert.equal(targets.length, 22);
  assert.equal(targets.filter((target) => target.kind === 'native').length, 8);
  assert.equal(targets.filter((target) => target.kind === 'skill').length, 4);
  assert.equal(targets.filter((target) => target.kind === 'plugin').length, 10);
  assert.deepEqual(targets.map((target) => target.id), [
    'claude', 'codex', 'opencode', 'qwen', 'reasonix', 'kilo', 'workbuddy', 'devin',
    'trae', 'pi', 'omp', 'dsh', 'copilot', 'cursor', 'kiro', 'openclaw', 'hermes',
    'vscode', 'chatgpt-codex', 'grok', 'nanoclaw', 'other',
  ]);
});

test('all-target dry-run never writes into project or home', async () => {
  const { dir, home, options, output } = scratch();
  const code = await runInstaller('install', ['--target', 'all', '--dry-run'], options);
  assert.equal(code, 0, output.join('\n'));
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(home), []);
});

test('all 22 adapters install and uninstall in an isolated fake home without invoking host CLIs', async () => {
  const { dir, home, options, output } = scratch();
  const installed = await runInstaller('install', ['--target', 'all'], options);
  assert.equal(installed, 0, output.join('\n'));
  assert.ok(!output.some((line) => line.includes('[ERROR]')), output.join('\n'));
  assert.ok(existsSync(join(dir, '.mcp.json')));
  assert.ok(existsSync(join(home, '.decision-lite', 'plugin', '.decision-lite-managed')));

  const removed = await runInstaller('uninstall', ['--target', 'all'], options);
  assert.equal(removed, 0, output.join('\n'));
  assert.ok(!output.some((line) => line.includes('[ERROR]')), output.join('\n'));
  assert.ok(existsSync(join(home, '.decision-lite', 'plugin', '.decision-lite-managed')));
});

test('Claude MCP install merges safely, is idempotent, and removes only its entry', async () => {
  const { dir, home, options, output } = scratch();
  const configFile = join(dir, '.mcp.json');
  writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { command: 'node', args: ['other.mjs'] } } }, null, 2));
  const args = ['--target', 'claude', '--scope', 'project', '--backend', 'openai', '--model', 'qwen3:0.6b', '--mode', 'logprobs'];

  assert.equal(await runInstaller('install', args, options), 0, output.join('\n'));
  const first = JSON.parse(readFileSync(configFile, 'utf8'));
  const server = first.mcpServers[manifest.name];
  assert.equal(first.mcpServers.other.command, 'node');
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [join(dir, '.decision-lite', 'plugin', 'dist', 'cli.mjs'), 'mcp']);
  assert.equal(server.env.DECISION_BACKEND, 'openai');
  assert.equal(server.env.DECISION_MODEL, 'qwen3:0.6b');
  assert.equal(server.env.DECISION_API_KEY, undefined);
  assert.ok(existsSync(join(dir, '.decision-lite', 'plugin', '.decision-lite-managed')));

  assert.equal(await runInstaller('install', args, options), 0, output.join('\n'));
  assert.equal(readFileSync(configFile, 'utf8'), `${JSON.stringify(first, null, 2)}\n`);

  assert.equal(await runInstaller('uninstall', ['--target', 'claude', '--scope', 'project'], options), 0, output.join('\n'));
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['other']);
  assert.ok(existsSync(join(dir, '.decision-lite', 'plugin', '.decision-lite-managed')), 'shared package is retained unless purge-config is requested');
});

test('installer refuses to overwrite an unowned MCP entry', async () => {
  const { dir, options, output } = scratch();
  const configFile = join(dir, '.mcp.json');
  const original = { mcpServers: { [manifest.name]: { command: 'custom-user-command' } } };
  writeFileSync(configFile, JSON.stringify(original, null, 2));

  assert.equal(await runInstaller('install', ['--target', 'claude', '--scope', 'project'], options), 0, output.join('\n'));
  assert.ok(output.some((line) => line.toLowerCase().includes('manual')));
  assert.equal(readFileSync(configFile, 'utf8'), JSON.stringify(original, null, 2));
});

test('Codex TOML install round-trips its managed section and preserves other sections', async () => {
  const { dir, options, output } = scratch();
  const configFile = join(dir, '.codex', 'config.toml');
  const original = '[model]\nname = "local"\n';
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(configFile, original);

  assert.equal(await runInstaller('install', ['--target', 'codex', '--scope', 'project'], options), 0, output.join('\n'));
  const installed = readFileSync(configFile, 'utf8');
  assert.match(installed, /\[mcp_servers\."decision-lite"\]/);
  assert.match(installed, /decision-lite:managed/);
  assert.match(installed, /name = "local"/);

  assert.equal(await runInstaller('uninstall', ['--target', 'codex', '--scope', 'project'], options), 0, output.join('\n'));
  const removed = readFileSync(configFile, 'utf8');
  assert.match(removed, /\[model\]/);
  assert.doesNotMatch(removed, /mcp_servers/);
});

test('Cursor uninstall keeps an unmarked user plugin directory', async () => {
  const { home, options, output } = scratch();
  const pluginDir = join(home, '.cursor', 'plugins', 'local', 'decision-lite');
  const userFile = join(pluginDir, 'user-notes.txt');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(userFile, 'keep');

  assert.equal(await runInstaller('uninstall', ['--target', 'cursor'], options), 0, output.join('\n'));
  assert.equal(readFileSync(userFile, 'utf8'), 'keep');
});
