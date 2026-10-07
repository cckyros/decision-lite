// Needle backend: spawns python/needle_bridge.py (cactus-needle), talks JSONL.
// Needle gives {answer, confidence} per call — no full distribution — so we
// synthesize one: P(chosen) = max(c, 1/n), rest spread evenly.
// Judgment questions normally land in suppressed_calls (Needle's grounding gate
// withholds answers that aren't literal text spans) — we still use the answer,
// flagged via meta.suppressed; only missing/invalid answers fall back uniform.
// NOTE: Needle's confidence head is English-calibrated; Cactus measured correct
// non-English calls at 0.0 — distrust it for non-English states.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, normalizeDistribution } from './contract.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'needle_bridge.py');

export class NeedleBackend {
  constructor({ python = 'python', generation = 3, bridgeScript = BRIDGE } = {}) {
    this.python = python;
    this.generation = generation;
    this.bridgeScript = bridgeScript;
    this._proc = null;
    this._pending = new Map();
    this._nextId = 1;
    this._stderr = '';
  }

  _ensureProc() {
    if (this._proc) return this._proc;
    const proc = spawn(this.python, [this.bridgeScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // belt-and-suspenders with the bridge's own stream reconfigure: without
      // this, a GBK/cp936 Windows locale corrupts non-ASCII JSONL
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    proc.stderr.on('data', (d) => {
      this._stderr = (this._stderr + d.toString()).slice(-2000);
    });
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const resolve = this._pending.get(msg.id);
      if (resolve) { this._pending.delete(msg.id); resolve(msg); return; }
      // The bridge couldn't recover the request id (unparseable request line).
      // Requests are processed serially, so attribute the error to the oldest
      // outstanding call rather than letting it hang until timeout.
      if (msg.error && this._pending.size) {
        const [oldestId, oldestResolve] = this._pending.entries().next().value;
        this._pending.delete(oldestId);
        oldestResolve(msg);
      }
    });
    proc.on('exit', (code) => {
      this._proc = null;
      for (const [, r] of this._pending) {
        r({ error: `bridge exited (code ${code}). stderr: ${this._stderr.slice(-500)}` });
      }
      this._pending.clear();
    });
    this._proc = proc;
    return proc;
  }

  _request(payload, timeoutMs = 120000) {
    const proc = this._ensureProc();
    const id = this._nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          resolve({ error: `bridge timeout after ${timeoutMs}ms (model may still be downloading)` });
        }
      }, timeoutMs);
      this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ ...payload, id, generation: this.generation }) + '\n');
    });
  }

  async evalQuestion(state, id, q) {
    const r = await this.evaluate(state, { [id]: q });
    return { dist: r.dists[id], confidence: r.confidences?.[id], meta: r.meta?.[id] };
  }

  // returns { dists, confidences, meta } — same shape DecisionBackend produces
  async evaluate(state, questions) {
    const resp = await this._request({ state, questions });
    if (resp.error) throw new Error(`needle backend: ${resp.error}`);

    const dists = {}, confidences = {}, meta = {};
    const inputText = `${typeof state === 'string' ? state : JSON.stringify(state)}\n${JSON.stringify(questions)}`;
    const confidenceUnreliable = /[^\x00-\x7F]/u.test(inputText);
    for (const [qid, q] of Object.entries(questions)) {
      const options = optionsOf(q);
      const a = resp.answers?.[qid] ?? {};
      const valid = a.answer != null && options.includes(a.answer);
      if (valid) {
        const c = Number.isFinite(a.confidence) ? Math.min(Math.max(a.confidence, 0), 1) : 0.5;
        // floor at uniform share so the model's own pick stays the argmax;
        // real confidence (possibly tiny) is still reported in `confidence`
        const pTop = Math.max(c, 1 / options.length);
        const rest = options.length > 1 ? (1 - pTop) / (options.length - 1) : 0;
        const raw = {};
        for (const o of options) raw[o] = o === a.answer ? pTop : rest;
        dists[qid] = normalizeDistribution(raw, options);
        confidences[qid] = c;
      } else {
        // no call / invalid option → honestly uniform
        const u = 1 / options.length;
        const dist = {};
        for (const o of options) dist[o] = u;
        dists[qid] = dist;
        confidences[qid] = 0;
      }
      meta[qid] = {
        backend: 'needle',
        suppressed: !!a.suppressed,
        rawAnswer: a.answer ?? null,
        ...(a.suppressed ? { note: 'grounding-gate withheld; answer is the suppressed call' } : {}),
        ...(valid || a.suppressed ? {} : { note: 'no call/invalid → uniform distribution' }),
        ...(confidenceUnreliable ? {
          confidence_unreliable: true,
          warning: 'Needle confidence is unreliable for non-ASCII input',
        } : {}),
      };
    }
    return { dists, confidences, meta };
  }

  async close() {
    if (!this._proc) return;
    this._proc.stdin.end();
    this._proc.kill();
    this._proc = null;
  }
}
