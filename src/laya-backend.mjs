// Laya backend: spawns python/laya_bridge.py, talks JSONL (same pattern as needle).
// Laya is a trained non-autoregressive decision model: one forward pass scores
// every option, so `probabilities` is a real distribution — not verbalized, not
// synthesized from a scalar confidence. The multilingual checkpoint reads CJK.
//
// Config:
//   DECISION_BACKEND=laya
//   DECISION_PYTHON   python with `laya` installed (default "python")
//   DECISION_LAYA_MODEL  optional "english"|"multilingual" pin (default: auto-route by script)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsOf, normalizeDistribution } from './contract.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'laya_bridge.py');

export class LayaBackend {
  constructor({ python = 'python', bridgeScript = BRIDGE, model } = {}) {
    this.python = python;
    this.bridgeScript = bridgeScript;
    this.model = model;
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
      // Unroutable response (bridge lost the request id): requests are serial,
      // so attribute the error to the oldest outstanding call rather than hang.
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

  _request(payload, timeoutMs = 180000) {
    const proc = this._ensureProc();
    const id = this._nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          resolve({ error: `bridge timeout after ${timeoutMs}ms (model may still be downloading)` });
        }
      }, timeoutMs);
      this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ ...payload, id, model: this.model }) + '\n');
    });
  }

  // Ask the bridge to preload checkpoints now instead of on the first real
  // request — a cold build costs ~10s per checkpoint. Best-effort: resolves
  // with the bridge response ({warmed:[...]} or {error}), never throws; a
  // failed warmup just leaves loading lazy as before. When `model` is pinned
  // only that checkpoint warms.
  warmup() {
    return this._request({ warmup: true });
  }

  async evalQuestion(state, id, q) {
    const r = await this.evaluate(state, { [id]: q });
    return { dist: r.dists[id], confidence: r.confidences?.[id], meta: r.meta?.[id] };
  }

  // returns { dists, confidences, meta } — same shape DecisionBackend produces
  async evaluate(state, questions) {
    const resp = await this._request({ state, questions });
    if (resp.error) throw new Error(`laya backend: ${resp.error}`);

    const dists = {}, confidences = {}, meta = {};
    for (const [qid, q] of Object.entries(questions)) {
      const options = optionsOf(q);
      const a = resp.answers?.[qid] ?? {};
      const raw = {};
      let hasDist = false;
      if (a.probabilities && typeof a.probabilities === 'object') {
        for (const o of options) {
          const v = Number(a.probabilities[o]);
          raw[o] = Number.isFinite(v) && v > 0 ? v : 0;
          if (raw[o] > 0) hasDist = true;
        }
      }
      if (hasDist) {
        dists[qid] = normalizeDistribution(raw, options);
      } else {
        // no distribution from the model → honestly uniform
        const u = 1 / options.length;
        const dist = {};
        for (const o of options) dist[o] = u;
        dists[qid] = dist;
      }
      // Prefer answer_confidence (max p — the calibratable quantity); fall back to
      // the entropy confidence laya also reports.
      const ac = Number(a.answer_confidence);
      const ec = Number(a.entropy_confidence);
      confidences[qid] = Number.isFinite(ac) ? Math.min(Math.max(ac, 0), 1)
        : Number.isFinite(ec) ? Math.min(Math.max(ec, 0), 1) : 0;
      meta[qid] = {
        backend: 'laya',
        rawAnswer: a.answer ?? null,
        answer_confidence: Number.isFinite(ac) ? ac : null,
        entropy_confidence: Number.isFinite(ec) ? ec : null,
        ...(a.expected != null ? { expected_score: a.expected } : {}),
        ...(hasDist ? {} : { note: 'no distribution → uniform fallback' }),
      };
      if (resp.routing) meta[qid].routing = resp.routing;
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
