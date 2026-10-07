// Decision log: JSONL append-only record for calibration tracking.
// Each evaluate() call writes entries {id, ts, qid, type, answer, confidence, probabilities, stateHash}
// record_outcome(decisionId, correct|incorrect) attaches ground truth later.
// decision_stats() buckets confidence vs observed accuracy → ECE-style report.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class DecisionLog {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) appendFileSync(path, '');
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    this._cache = { decisions: new Map(), outcomes: new Map() };
    const text = readFileSync(this.path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.kind === 'decision') this._cache.decisions.set(rec.id, rec);
        else if (rec.kind === 'outcome') this._cache.outcomes.set(rec.decisionId, rec);
      } catch { /* skip corrupt lines */ }
    }
    return this._cache;
  }

  _append(rec) {
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
    if (rec.kind === 'decision') this._cache?.decisions.set(rec.id, rec);
    else if (rec.kind === 'outcome') this._cache?.outcomes.set(rec.decisionId, rec);
  }

  // one decision record per evaluate() call (contains all question answers)
  recordDecision({ state, questions, answers, model, mode, usage }) {
    const id = randomUUID();
    const rec = {
      kind: 'decision',
      id,
      ts: new Date().toISOString(),
      stateHash: createHash('sha256').update(stateText(state)).digest('hex').slice(0, 16),
      model, mode,
      answers,
      usage,
    };
    this._append(rec);
    return id;
  }

  recordOutcome(decisionId, outcome, note) {
    const d = this._load().decisions.get(decisionId);
    if (!d) throw new Error(`decision ${decisionId} not found`);
    const rec = {
      kind: 'outcome',
      decisionId,
      ts: new Date().toISOString(),
      // per-question truth map: {qid: true|false} or single bool applied to all
      outcome,
      note: note ?? null,
    };
    this._append(rec);
    return rec;
  }

  // calibration report: bucket predictions by confidence, compare to hit rate
  stats() {
    const { decisions, outcomes } = this._load();
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      range: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
      n: 0, correct: 0, confSum: 0,
    }));
    let nTotal = 0, nJudged = 0;
    for (const [id, d] of decisions) {
      const o = outcomes.get(id);
      for (const [qid, a] of Object.entries(d.answers)) {
        nTotal++;
        if (a.confidence == null) continue;
        if (!o) continue;
        const truth = typeof o.outcome === 'object' ? o.outcome[qid] : o.outcome;
        if (typeof truth !== 'boolean') continue;
        nJudged++;
        const bi = Math.min(9, Math.floor(a.confidence * 10));
        buckets[bi].n++;
        buckets[bi].confSum += a.confidence;
        if (truth) buckets[bi].correct++;
      }
    }
    return {
      totalDecisions: decisions.size,
      judgedDecisions: outcomes.size,
      totalAnswers: nTotal,
      judgedAnswers: nJudged,
      buckets: buckets.filter(b => b.n > 0).map(b => ({
        confidenceRange: b.range,
        n: b.n,
        meanConfidence: +(b.confSum / b.n).toFixed(3),
        observedAccuracy: +(b.correct / b.n).toFixed(3),
        gap: +((b.confSum / b.n) - (b.correct / b.n)).toFixed(3),
      })),
    };
  }
}

const stateText = (s) => (typeof s === 'string' ? s : JSON.stringify(s));
