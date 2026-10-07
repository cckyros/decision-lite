// Fake laya bridge for tests: canned JSONL responses keyed by a marker in state.
// state containing "ERR" -> error response
// state containing "NULLID" -> error response with id:null
// state containing "NODIST" -> no probabilities -> uniform fallback in backend
// otherwise -> a real per-option distribution skewed to the first option
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  let out;
  if (req.warmup) {
    out = { id: req.id, warmed: req.model ? [req.model] : ['english', 'multilingual'], error: null };
  } else if (req.state?.includes('NULLID')) {
    out = { id: null, error: 'bridge lost request id', answers: {} };
  } else if (req.state?.includes('ERR')) {
    out = { id: req.id, error: 'boom', answers: {} };
  } else {
    out = {
      id: req.id,
      routing: { model: 'laya', reason: 'latin-script text' },
      answers: Object.fromEntries(Object.entries(req.questions).map(([qid, q]) => {
        if (req.state?.includes('NODIST')) {
          return [qid, { answer: null, confidence: null, probabilities: null,
            answer_confidence: null, entropy_confidence: null }];
        }
        const opts = q.type === 'noul' ? ['true', 'false']
          : q.type === 'choice' ? Object.keys(q.criteria)
          : Object.keys(q.criteria);
        const p = 0.7;
        const rest = 0.3 / (opts.length - 1);
        const probabilities = Object.fromEntries(opts.map((o, i) => [o, i === 0 ? p : rest]));
        return [qid, {
          answer: opts[0], probabilities,
          answer_confidence: p, entropy_confidence: 0.55,
          expected: q.type === 'score' ? opts[0] : undefined,
        }];
      })),
    };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
