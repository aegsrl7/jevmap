'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, stem, unitText, keywordScore, looksComposite, splitTask } = require('../src/text');

test('tokenize drops stop words in Italian and English, folds accents and splits camelCase', () => {
  assert.deepEqual(tokenize('Aggiungi il cliente nella lista delle mail'), ['cliente', 'lista', 'mail']);
  assert.deepEqual(tokenize('Add the customer to the email list'), ['customer', 'email', 'list']);
  assert.deepEqual(tokenize('/api/emails getEmailList'), ['api', 'emails', 'get', 'email', 'list']);
  assert.deepEqual(tokenize('perché è già così'), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('stem collapses singular/plural and verb forms in both languages', () => {
  const pairs = [
    ['emails', 'email'], ['clienti', 'cliente'], ['commesse', 'commessa'], ['lamiere', 'lamiera'],
    ['lavorazione', 'lavorare'], ['preventivi', 'preventivo'], ['created', 'create'], ['creation', 'create'],
    ['descriptions', 'description'], ['settings', 'setting'], ['workers', 'worker'], ['users', 'user'],
    ['archived', 'archive'], ['routes', 'route'], ['loading', 'load'],
  ];
  for (const [a, b] of pairs) assert.equal(stem(a), stem(b), `${a} vs ${b}`);
  assert.equal(stem('loading'), 'load');
  assert.equal(stem('emails'), 'email');
  assert.equal(stem('ore'), 'ore');
  assert.equal(stem(''), '');
});

test('stem is stable when applied twice', () => {
  for (const w of ['commesse', 'clienti', 'settings', 'creation', 'lamiere', 'routes', 'users', 'archived', 'lavorazione']) {
    assert.equal(stem(stem(w)), stem(w), w);
  }
});

const emailUnit = {
  id: 'backend/routes/emails.js:8 GET /api/emails', file: 'backend/routes/emails.js', type: 'endpoint',
  name: 'GET /api/emails', description: 'List emails with filters', area: 'email',
  extra: { method: 'GET', path: '/api/emails', tables: ['email_messages'] },
};
const laserUnit = {
  id: 'backend/services/laser.js:3 readProgram', file: 'backend/services/laser.js', type: 'function',
  name: 'readProgram', description: 'Reads a laser program file', area: 'laser', extra: {},
};

test('unitText includes id, name, file, description, tables, calls, route and area', () => {
  const t = unitText({ ...emailUnit, extra: { ...emailUnit.extra, calls: ['/api/x'], route: '/emails', emits: ['email-updated'] } });
  for (const s of ['GET /api/emails', 'backend/routes/emails.js', 'List emails', 'email_messages', '/api/x', '/emails', 'email-updated', 'email']) {
    assert.ok(t.includes(s), s);
  }
  assert.equal(unitText(null), '');
});

test('keywordScore counts shared stems and adds the name/path bonus', () => {
  const q = tokenize('list the emails');
  const s = keywordScore(emailUnit, q);
  assert.equal(s, 2.5);
  assert.equal(keywordScore(laserUnit, q), 0);
  assert.ok(keywordScore(laserUnit, tokenize('read the laser program')) > keywordScore(emailUnit, tokenize('read the laser program')));
  assert.equal(keywordScore(emailUnit, []), 0);
  assert.equal(keywordScore('List emails with filters', q), 2);
  assert.equal(keywordScore('laser program', q), 0);
});

test('looksComposite detects lists, separators and long texts', () => {
  assert.equal(looksComposite('fix the archived filter'), false);
  assert.equal(looksComposite('fix the filter; add the column'), true);
  assert.equal(looksComposite('first line\nsecond line'), true);
  assert.equal(looksComposite('PVM bridge for laser, design system tokens'), true);
  assert.equal(looksComposite('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'), true);
});

test('splitTask splits on Italian and English connectors, bullets and commas', () => {
  assert.deepEqual(splitTask('aggiungi il cliente nella lista mail e poi sistema il filtro archiviate'),
    ['aggiungi il cliente nella lista mail', 'sistema il filtro archiviate']);
  assert.deepEqual(splitTask('Add the customer column to the email list and then fix the archived filter'),
    ['Add the customer column to the email list', 'fix the archived filter']);
  assert.deepEqual(splitTask('Show the totals in the report, also export it as PDF'),
    ['Show the totals in the report', 'export it as PDF']);
  assert.deepEqual(splitTask('fix: mail list\n- add customer column\n- fix archived filter'),
    ['mail list', 'add customer column', 'fix archived filter']);
  assert.deepEqual(splitTask('PVM bridge for laser, design system tokens, batch analyze endpoint'),
    ['PVM bridge for laser', 'design system tokens', 'batch analyze endpoint']);
  assert.deepEqual(splitTask('rinomina il campo cliente; aggiorna la pagina commesse'),
    ['rinomina il campo cliente', 'aggiorna la pagina commesse']);
});

test('splitTask keeps a single task whole and dedupes parts', () => {
  assert.deepEqual(splitTask('fix the archived filter'), ['fix the archived filter']);
  assert.deepEqual(splitTask('fix the archived filter, please'), ['fix the archived filter, please']);
  assert.deepEqual(splitTask('same part here; same part here'), ['same part here; same part here']);
  assert.deepEqual(splitTask(''), ['']);
});
