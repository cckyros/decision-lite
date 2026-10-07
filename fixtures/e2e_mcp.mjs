// End-to-end MCP smoke: spawn the built stdio server, run a real JSON-RPC
// session — initialize, tools/list, evaluate, record_outcome, decision_stats.
// Uses whichever backend the env selects (DECISION_BACKEND, default needle);
// DECISION_LOG is pointed at a temp file so the smoke does not touch the
// real decision log. Run: node fixtures/e2e_mcp.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.mjs');
const logPath = process.env.DECISION_LOG ?? join(tmpdir(), 'decision-lite-e2e-mcp.jsonl');
const proc = spawn(process.execPath, [cli, 'mcp'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, DECISION_LOG: logPath },
});

const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timeout`)); }, 300000);
  pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
const toolText = (msg) => JSON.parse(msg.result.content[0].text);

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) process.stdout.write(`PASS  ${name}\n`);
  else { failed++; process.stdout.write(`FAIL  ${name} ${detail}\n`); }
};

const deadline = setTimeout(() => { process.stderr.write('e2e timeout\n'); proc.kill(); process.exit(2); }, 360000);
try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-mcp', version: '0' },
  });
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'decision-lite',
    JSON.stringify(init.result?.serverInfo));
  notify('notifications/initialized');

  const tools = await send('tools/list');
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  check('tools/list exposes the three tools',
    JSON.stringify(names) === JSON.stringify(['decision_stats', 'evaluate', 'record_outcome']), names.join(','));

  const ev = await send('tools/call', {
    name: 'evaluate',
    arguments: {
      state: '客户来信：你们的系统又宕机了，我已经第三次报这个问题，要求立刻退款，否则投诉到底。',
      questions: {
        urgent: { type: 'noul', instructions: 'Does this need a reply within 1 hour?', criteria: { true: 'urgent', false: 'normal' } },
        dept: { type: 'choice', instructions: 'Which team handles this?', criteria: { billing: 'invoices and refunds', technical: 'bugs and outages', sales: 'new purchases' } },
        anger: { type: 'score', instructions: 'Customer anger level', criteria: ['calm', 'frustrated', 'furious'] },
      },
    },
  });
  const evBody = toolText(ev);
  const a = evBody.answers ?? {};
  check('evaluate returns a decision_id', typeof evBody.decision_id === 'string' && evBody.decision_id.length > 0);
  check('evaluate noul answer shaped', typeof a.urgent?.noul === 'number' && a.urgent.probabilities != null);
  check('evaluate choice answer shaped', typeof a.dept?.choice === 'string' && a.dept.probabilities != null);
  check('evaluate score answer shaped', typeof a.anger?.score === 'number' && a.anger.legend != null);
  process.stdout.write(`  -> dept=${a.dept?.choice} urgent=${a.urgent?.noul} anger=${a.anger?.score} backend=${evBody.backend} model=${evBody.model}\n`);

  const rec = await send('tools/call', {
    name: 'record_outcome',
    arguments: { decision_id: evBody.decision_id, outcome: { urgent: true, dept: true, anger: false } },
  });
  check('record_outcome records per-question outcomes', toolText(rec).ok === true);

  const stats = await send('tools/call', { name: 'decision_stats', arguments: {} });
  const st = toolText(stats);
  check('decision_stats counts the recorded outcome',
    (st.judgedAnswers ?? 0) >= 2 && (st.totalDecisions ?? 0) >= 1);

  const bad = await send('tools/call', { name: 'evaluate', arguments: { state: 'x', questions: { q: { type: 'nope' } } } });
  check('invalid question type surfaces isError', bad.result?.isError === true);
} catch (e) {
  failed++;
  process.stderr.write(`e2e error: ${e instanceof Error ? e.message : e}\n`);
} finally {
  clearTimeout(deadline);
  proc.kill();
}
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : '\ne2e MCP smoke: all checks passed\n');
process.exit(failed ? 1 : 0);
