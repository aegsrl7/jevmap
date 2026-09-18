'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { find, unitLabel, prefilterUnits, scanUnits, rerankWithJev, splitComposite } = require('../src/find');

// Inline map: 8 units over 6 files, no disk, no network.
const U = (file, type, name, start, description, extra = {}) => ({
  id: `${file}:${start} ${name}`, file, lang: 'js', type, name, start, end: start + 20, comment: description, description, area: file.split('/')[0], extra,
});
const MAP = {
  version: 1, generated: '2026-09-18T00:00:00', root: '/repo', project: 'Demo, an Express + React app', n_files: 6, n_units: 8,
  files: {},
  units: [
    U('backend/routes/emails.js', 'endpoint', 'GET /api/emails', 10, 'List emails with filters (category, archived).', { method: 'GET', path: '/api/emails', tables: ['email_messages'] }),
    U('backend/routes/emails.js', 'endpoint', 'POST /api/emails/:id/archive', 60, 'Archive one email.', { method: 'POST', path: '/api/emails/:id/archive', tables: ['email_messages'] }),
    U('backend/services/imap.js', 'function', 'fetchInbox', 5, 'Download new messages from the IMAP server.', { tables: ['email_messages'] }),
    U('frontend/src/pages/EmailList.js', 'page', 'EmailList', 1, 'Email list page with category filter and archive button.', { route: '/emails', calls: ['/api/emails', '/api/emails/:id/archive'] }),
    U('frontend/src/components/Button.js', 'component', 'Button', 1, 'Generic button of the design system.', {}),
    U('backend/routes/orders.js', 'endpoint', 'GET /api/orders', 12, 'List customer orders.', { method: 'GET', path: '/api/orders', tables: ['orders'] }),
    U('backend/routes/orders.js', 'function', 'computeTotal', 80, 'Sum order lines with VAT.', { tables: ['order_lines'] }),
    U('backend/jobs/cleanup.js', 'job', 'cleanup nightly', 3, 'Delete temporary files older than 7 days.', {}),
  ],
};

// Deterministic fake Jev: noul probability from a table keyed by the unit file
// (found inside the instructions); choice probabilities favour the criteria
// whose file matches the task words.
const NOUL_P = {
  'backend/routes/emails.js:10': 0.93, 'backend/routes/emails.js:60': 0.41, 'backend/services/imap.js': 0.30,
  'frontend/src/pages/EmailList.js': 0.88, 'frontend/src/components/Button.js': 0.05,
  'backend/routes/orders.js:12': 0.02, 'backend/routes/orders.js:80': 0.01, 'backend/jobs/cleanup.js': 0.03,
};
function noulFor(instructions) {
  if (instructions.includes('backend/routes/emails.js | endpoint GET /api/emails')) return NOUL_P['backend/routes/emails.js:10'];
  if (instructions.includes('backend/routes/emails.js | endpoint POST')) return NOUL_P['backend/routes/emails.js:60'];
  if (instructions.includes('backend/routes/orders.js | endpoint')) return NOUL_P['backend/routes/orders.js:12'];
  if (instructions.includes('backend/routes/orders.js | function')) return NOUL_P['backend/routes/orders.js:80'];
  for (const k of Object.keys(NOUL_P)) if (instructions.includes(k + ' |')) return NOUL_P[k];
  return 0;
}
function makeFakeClient() {
  const log = [];
  return {
    log,
    async ask(state, questions) {
      log.push({ state, questions });
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[id] = { noul: noulFor(q.instructions) };
        else if (q.type === 'choice') {
          const keys = Object.keys(q.criteria);
          const probabilities = {};
          let best = null;
          for (const k of keys) {
            const c = q.criteria[k];
            if (k === 'none') { probabilities[k] = 0.04; continue; }
            const p = c.file === 'frontend/src/pages/EmailList.js' ? 0.7 : c.file === 'backend/routes/emails.js' ? 0.2 : 0.01;
            probabilities[k] = p;
            if (!best || p > probabilities[best]) best = k;
          }
          answers[id] = { choice: best, probabilities, confidence: 0.8 };
        }
      }
      return { answers, usage: { input_tokens: 100 * Object.keys(questions).length, output_tokens: 1 }, model: 'jev-fake', ms: 1, attempts: 1 };
    },
  };
}

test('unitLabel is the compact one-line description', () => {
  const label = unitLabel(MAP.units[3]);
  assert.equal(label, 'frontend/src/pages/EmailList.js | page EmailList | does: Email list page with category filter and archive button. | calls: /api/emails, /api/emails/:id/archive | page /emails');
  assert.equal(unitLabel(MAP.units[0]), 'backend/routes/emails.js | endpoint GET /api/emails | does: List emails with filters (category, archived). | tables: email_messages');
});

test('prefilterUnits scores by keywords and prefers name/path hits', () => {
  const cands = prefilterUnits(MAP, 'archive email', 40);
  assert.ok(cands.length >= 2);
  assert.ok(cands.every((c) => c.score > 0));
  const files = cands.map((c) => c.unit.file);
  assert.ok(files.includes('backend/routes/emails.js'));
  assert.ok(!files.includes('backend/jobs/cleanup.js'), 'unrelated units are not candidates');
  assert.ok(cands[0].score >= cands[cands.length - 1].score, 'sorted best first');
  assert.deepEqual(prefilterUnits(MAP, '', 40), []);
});

test('scan mode: ordering by noul probability, batches, file de-duplication', async () => {
  const client = makeFakeClient();
  const res = await find(MAP, 'fix the email list', { jevClient: client, mode: 'scan', batch: 3, split: 'none', top: 5 });
  assert.equal(res.mode, 'scan');
  assert.equal(res.parts.length, 1);
  const part = res.parts[0];
  assert.equal(part.jev, true);
  assert.equal(part.calls, 3, '8 units in batches of 3 = 3 calls');
  assert.equal(client.log.length, 3);
  assert.deepEqual(client.log[0].state, { task: 'fix the email list' });
  assert.match(client.log[0].questions.q0.instructions, /`task`/);
  assert.match(client.log[0].questions.q0.instructions, /Demo, an Express \+ React app/);
  assert.equal(part.tokens, 800);
  assert.equal(part.cost_usd, Math.round(800 / 1e6 * 0.042 * 1e6) / 1e6, 'cost = tokens / 1e6 * 0.042, rounded to 6 decimals');

  assert.deepEqual(part.units.map((u) => u.p), [0.93, 0.88, 0.41, 0.3, 0.05]);
  assert.equal(part.units[0].name, 'GET /api/emails');
  assert.equal(part.units[0].line, 10);
  assert.equal(part.units[0].id, 'backend/routes/emails.js:10 GET /api/emails');
  assert.ok(part.units[0].description.length <= 120);

  const files = part.files.map((f) => f.file);
  assert.deepEqual(files.slice(0, 3), ['backend/routes/emails.js', 'frontend/src/pages/EmailList.js', 'backend/services/imap.js']);
  assert.equal(new Set(files).size, files.length, 'files are unique');
  assert.equal(part.files[0].p, 0.93, 'file probability = best unit probability');
  assert.equal(files.length, 6, 'one entry per distinct file (8 units over 6 files)');
});

test('scanUnits exposes scored units and retries a failed batch once', async () => {
  const client = makeFakeClient();
  let failedOnce = false;
  const original = client.ask.bind(client);
  client.ask = async (state, questions) => {
    if (!failedOnce) { failedOnce = true; throw new Error('boom'); }
    return original(state, questions);
  };
  const r = await scanUnits(MAP, 'fix the email list', { jevClient: client, batch: 60 });
  assert.equal(r.calls, 1);
  assert.equal(r.scored.length, 8);
  assert.equal(r.scored[0].unit.name, 'GET /api/emails');
});

test('prefilter mode: choice probabilities give the order', async () => {
  const client = makeFakeClient();
  const res = await find(MAP, 'add archive button to the email list page', { jevClient: client, mode: 'prefilter', split: 'none', candidates: 40, top: 10 });
  const part = res.parts[0];
  assert.equal(part.mode, 'prefilter');
  assert.equal(part.jev, true);
  assert.equal(part.calls, 1);
  assert.equal(client.log.length, 1);
  const q = client.log[0].questions.unit;
  assert.equal(q.type, 'choice');
  assert.ok(q.criteria.u1 && q.criteria.u1.file, 'criteria u1..uN carry the file');
  assert.equal(q.criteria.none, 'None of these units is the right place for the task');
  assert.equal(part.confidence, 0.8);
  assert.equal(part.none, 0.04);
  assert.equal(part.units[0].file, 'frontend/src/pages/EmailList.js');
  assert.equal(part.units[0].p, 0.7);
  assert.equal(part.units[1].file, 'backend/routes/emails.js');
  assert.ok(typeof part.units[0].score === 'number', 'keyword score is kept next to p');
  assert.equal(part.files[0].file, 'frontend/src/pages/EmailList.js');
  assert.equal(part.files[1].file, 'backend/routes/emails.js');
});

test('rerankWithJev returns ordered candidates with confidence and none', async () => {
  const client = makeFakeClient();
  const cands = prefilterUnits(MAP, 'email list', 40);
  const r = await rerankWithJev('email list', cands, { jevClient: client, project: 'Demo' });
  assert.equal(r.ordered[0].unit.name, 'EmailList');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.none, 0.04);
  assert.ok(r.tokens > 0);
});

test('composite task with split heuristic runs one part per sub-task', async () => {
  const parts = await splitComposite('add a button; fix the email list', { split: 'heuristic' });
  assert.deepEqual(parts, ['add a button', 'fix the email list']);
  const client = makeFakeClient();
  const res = await find(MAP, 'add a button; fix the email list', { jevClient: client, mode: 'scan', split: 'heuristic', batch: 60 });
  assert.equal(res.parts.length, 2);
  assert.equal(res.parts[0].task, 'add a button');
  assert.equal(res.parts[1].task, 'fix the email list');
  assert.equal(client.log.length, 2, 'one scan call per part');
  assert.equal(res.parts[1].units[0].name, 'GET /api/emails');
});

test('split none keeps the whole task; llm without a key falls back to the heuristic', async () => {
  assert.deepEqual(await splitComposite('add a button; fix the email list', { split: 'none' }), ['add a button; fix the email list']);
  assert.deepEqual(await splitComposite('add a button; fix the email list', { split: 'llm', llm: {} }), ['add a button', 'fix the email list']);
  assert.deepEqual(await splitComposite('fix the email list', { split: 'heuristic' }), ['fix the email list']);
});

test('fallback without a Jev client: keyword order, jev false, note', async () => {
  const res = await find(MAP, 'archive email', { split: 'none', jev: {} });
  const part = res.parts[0];
  assert.equal(part.jev, false);
  assert.ok(part.note && /TYPESAFE_API_KEY/.test(part.note));
  assert.equal(part.calls, 0);
  assert.equal(part.cost_usd, 0);
  assert.ok(part.units.length >= 2);
  assert.ok(part.units.every((u) => typeof u.score === 'number' && u.p === null));
  assert.ok(part.files.every((f) => typeof f.score === 'number'));
  assert.ok(part.units[0].file === 'backend/routes/emails.js' || part.units[0].file === 'frontend/src/pages/EmailList.js');
});

test('a Jev batch that fails twice marks the part with error and keeps keyword order', async () => {
  const client = { async ask() { throw new Error('503 from Jev'); } };
  const res = await find(MAP, 'archive email', { jevClient: client, split: 'none' });
  const part = res.parts[0];
  assert.equal(part.jev, false);
  assert.equal(part.error, '503 from Jev');
  assert.match(part.note, /keyword order/);
  assert.ok(part.units.length >= 1);
});

test('find rejects an empty task or a map without units', async () => {
  await assert.rejects(find(MAP, '   ', {}), /needs a task/);
  await assert.rejects(find({}, 'x', {}), /jevmap build/);
});
