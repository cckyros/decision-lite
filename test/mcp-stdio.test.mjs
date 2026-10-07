// MCP stdio smoke test: spawn the server, run initialize + tools/list over JSON-RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function mcpSession(env = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-mcp-'));
  const child = spawn(process.execPath, [join(root, 'src', 'index.mjs')], {
    env: { ...process.env, DECISION_LOG: join(logDir, 'd.jsonl'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, send };
}

test('MCP server: initialize, tools/list, record_outcome error path', async () => {
  const { child, send } = mcpSession();
  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'decision-lite');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await send('tools/list', {});
    const names = list.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['decision_stats', 'evaluate', 'record_outcome']);

    // record_outcome on unknown id returns structured error, not a crash
    const bad = await send('tools/call', {
      name: 'record_outcome',
      arguments: { decision_id: 'missing', outcome: true },
    });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /not found/);

    // decision_stats on empty log works
    const stats = await send('tools/call', { name: 'decision_stats', arguments: {} });
    const parsed = JSON.parse(stats.result.content[0].text);
    assert.equal(parsed.totalDecisions, 0);
  } finally {
    child.kill();
  }
});
