// Fake needle bridge for tests: canned JSONL responses keyed by a marker in state.
// state containing "ERR" -> error response
// state containing "NULLID" -> error response with id:null (bridge lost the request id)
// state containing "SUPPRESS" -> suppressed_calls
// state containing "NOCALL" -> no calls at all
// otherwise -> answers each question with its first option at confidence 0.8
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const qids = Object.keys(req.questions || {});
  let out;
  if (req.state?.includes('NULLID')) {
    out = { id: null, error: 'bridge lost request id', answers: {} };
  } else if (req.state?.includes('ERR')) {
    out = { id: req.id, error: 'boom', answers: {} };
  } else if (req.state?.includes('SUPPRESS')) {
    // suppressed but valid answer, low confidence
    out = { id: req.id, answers: Object.fromEntries(Object.entries(req.questions).map(([qid, q]) => {
      const opt = q.type === 'noul' ? 'true'
        : q.type === 'choice' ? Object.keys(q.criteria)[0]
        : '0';
      return [qid, { answer: opt, confidence: 0.05, suppressed: true }];
    })) };
  } else if (req.state?.includes('NOCALL')) {
    out = { id: req.id, answers: Object.fromEntries(qids.map(qid =>
      [qid, { answer: null, confidence: null, suppressed: false }])) };
  } else {
    out = {
      id: req.id,
      answers: Object.fromEntries(Object.entries(req.questions).map(([qid, q]) => {
        const opt = q.type === 'noul' ? 'true'
          : q.type === 'choice' ? Object.keys(q.criteria)[0]
          : '0';
        return [qid, { answer: opt, confidence: 0.8, suppressed: false }];
      })),
    };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
