// E2E: spawn real MCP server with needle backend, send evaluate over stdio.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logDir = mkdtempSync(join(tmpdir(), 'jev-e2e-'));

const child = spawn(process.execPath, [join(root, 'src', 'index.mjs')], {
  env: { ...process.env, DECISION_BACKEND: 'needle', DECISION_LOG: join(logDir, 'd.jsonl') },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let nid = 1;
const send = (method, params) => new Promise((res, rej) => {
  const id = nid++;
  pending.set(id, res);
  setTimeout(() => rej(new Error(`timeout ${method}`)), 180000);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const init = await send('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'e2e', version: '0' },
});
console.log('init:', init.result.serverInfo.name, init.result.serverInfo.version);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const r = await send('tools/call', {
  name: 'evaluate',
  arguments: {
    state: 'The refund was charged twice and the customer is threatening a chargeback.',
    questions: {
      is_urgent: { type: 'noul', instructions: 'needs response within 1 hour?', criteria: { true: 'yes', false: 'no' } },
      department: { type: 'choice', instructions: 'route to team', criteria: { billing: 'invoices and refunds', technical: 'product bugs' } },
      risk_level: { type: 'score', instructions: 'customer anger level', criteria: ['calm', 'frustrated', 'very angry'] },
    },
  },
});
console.log('evaluate:', r.result.content[0].text);
child.kill();
