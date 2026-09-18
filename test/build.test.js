'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, listFiles, renderMarkdown, writeMap, loadMap, parseGitignore } = require('../src/build');
const { loadConfig, matchGlob, parseEnv, DEFAULT_EXCLUDES } = require('../src/config');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-repo');

function ensureNodeModulesFile() {
  const file = path.join(FIXTURE, 'node_modules', 'left-pad', 'index.js');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// A dependency that must never appear in the map.\nmodule.exports = () => 1;\n');
  }
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jevmap-${name}-`));
}

const byName = (units, name) => units.find((u) => u.name === name);

test('loadConfig merges defaults, jevmap.config.json and overrides', () => {
  const cfg = loadConfig(FIXTURE);
  assert.equal(cfg.root, FIXTURE);
  assert.ok(cfg.project.startsWith('sample-repo'));
  assert.deepEqual(cfg.areas, [['email|imap|mail', 'email']]);
  assert.equal(cfg.out, '.jevmap');
  assert.equal(cfg.descriptions, '.jevmap/descriptions.json');
  assert.equal(cfg.batch, 60);
  assert.deepEqual(cfg.include, []);
  assert.equal(typeof cfg.env.JEV_MODEL, 'string');
  const over = loadConfig(FIXTURE, { project: 'other', include: 'backend/**,lib/**', batch: '10', out: undefined });
  assert.equal(over.project, 'other');
  assert.deepEqual(over.include, ['backend/**', 'lib/**']);
  assert.equal(over.batch, 10);
  assert.equal(over.out, '.jevmap');
});

test('loadConfig reads .env for the known keys without touching process.env', () => {
  const dir = tmpDir('env');
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nexport TYPESAFE_API_KEY="ts-key"\nCLAUDE_API_KEY=\'cl-key\'\nJEV_MODEL=jev-test # trailing\nOTHER=1\n');
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_API_KEY: process.env.CLAUDE_API_KEY, JEV_MODEL: process.env.JEV_MODEL };
  delete process.env.TYPESAFE_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_API_KEY; delete process.env.JEV_MODEL;
  try {
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.env, { TYPESAFE_API_KEY: 'ts-key', ANTHROPIC_API_KEY: 'cl-key', JEV_MODEL: 'jev-test' });
    process.env.ANTHROPIC_API_KEY = 'from-process';
    assert.equal(loadConfig(dir).env.ANTHROPIC_API_KEY, 'from-process');
    assert.equal(process.env.TYPESAFE_API_KEY, undefined);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(parseEnv('A=1\nB="two words"\n=bad\nC'), { A: '1', B: 'two words' });
});

test('matchGlob supports **, *, ? and bare names on any segment', () => {
  assert.equal(matchGlob('node_modules', 'a/node_modules/b.js'), true);
  assert.equal(matchGlob('*.min.js', 'x/y/app.min.js'), true);
  assert.equal(matchGlob('*.min.js', 'x/y/app.js'), false);
  assert.equal(matchGlob('backend/**', 'backend/routes/x.js'), true);
  assert.equal(matchGlob('backend/**', 'frontend/x.js'), false);
  assert.equal(matchGlob('**/*.test.js', 'a/b/c.test.js'), true);
  assert.equal(matchGlob('**/*.test.js', 'c.test.js'), true);
  assert.equal(matchGlob('backend/scripts', 'backend/scripts/mappa/x.py'), true);
  assert.equal(matchGlob('src/?.js', 'src/a.js'), true);
  assert.equal(matchGlob('src/?.js', 'src/ab.js'), false);
  assert.equal(matchGlob('build', 'src/build.js'), false);
  assert.equal(matchGlob('', 'x'), false);
  assert.ok(DEFAULT_EXCLUDES.includes('node_modules'));
});

test('listFiles keeps source files and drops node_modules, docs and config json', () => {
  ensureNodeModulesFile();
  const cfg = loadConfig(FIXTURE);
  const files = listFiles(FIXTURE, cfg);
  assert.deepEqual(files, [
    'api/app.py',
    'backend/routes/emails.js',
    'backend/services/imap.js',
    'frontend/src/App.js',
    'frontend/src/components/EmailList.js',
    'frontend/src/components/Settings.jsx',
    'lib/util.ts',
  ]);
  assert.ok(!files.some((f) => f.startsWith('node_modules/')));
  assert.ok(!files.includes('README.md'));
  assert.ok(!files.includes('package.json'));
  const only = listFiles(FIXTURE, loadConfig(FIXTURE, { include: ['backend/**', 'README.md'], exclude: ['**/imap.js'] }));
  assert.deepEqual(only, ['README.md', 'backend/routes/emails.js']);
});

test('listFiles walks the tree honouring .gitignore when git is not available', () => {
  const dir = tmpDir('walk');
  try {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'ignored.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp', 'gen.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'big.js'), '// big\n' + 'x'.repeat(1024 * 1024 + 10));
    fs.writeFileSync(path.join(dir, '.gitignore'), '# ignore\nignored.js\ntmp/\n!keep.js\n');
    fs.writeFileSync(path.join(dir, 'keep.js'), 'module.exports = 1;\n');
    const files = listFiles(dir, loadConfig(dir));
    assert.ok(!files.includes('ignored.js'));
    assert.ok(!files.includes('tmp/gen.js'));
    assert.ok(!files.includes('big.js'));
    assert.ok(!files.some((f) => f.startsWith('node_modules/')));
    assert.ok(files.includes('keep.js'));
    assert.ok(files.includes('backend/routes/emails.js'));
    assert.deepEqual(parseGitignore('a\n!b\n# c\n\n d/ \n'), [{ pattern: 'a', negate: false }, { pattern: 'b', negate: true }, { pattern: 'd/', negate: false }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build extracts the expected units from the fixture repo', () => {
  ensureNodeModulesFile();
  const logs = [];
  const map = build(FIXTURE, loadConfig(FIXTURE), { log: (m) => logs.push(m) });
  assert.equal(map.version, 1);
  assert.equal(map.root, FIXTURE);
  assert.ok(map.project.startsWith('sample-repo'));
  assert.equal(map.n_files, 7);
  assert.equal(map.n_units, map.units.length);
  assert.equal(logs.length, 1);
  assert.ok(!Object.keys(map.files).some((f) => f.startsWith('node_modules/')));
  assert.equal(map.files['README.md'], undefined);
  assert.equal(map.files['package.json'], undefined);

  const inFile = (f) => map.units.filter((u) => u.file === f);

  // Express routes
  const routes = inFile('backend/routes/emails.js');
  const get = byName(routes, 'GET /api/emails');
  assert.equal(get.type, 'endpoint');
  assert.equal(get.extra.method, 'GET');
  assert.equal(get.extra.path, '/api/emails');
  assert.equal(get.comment, 'List emails with filters (category, archived).');
  assert.equal(get.description, get.comment);
  assert.deepEqual(get.extra.tables, ['email_messages']);
  assert.deepEqual(get.extra.middleware, ['optionalAuth']);
  assert.equal(get.start, 8);
  assert.equal(get.end, 11);
  assert.equal(get.area, 'email');
  const post = byName(routes, 'POST /api/emails/:id/archive');
  assert.equal(post.type, 'endpoint');
  assert.equal(post.extra.method, 'POST');
  assert.deepEqual(post.extra.emits, ['email-updated']);
  assert.equal(byName(routes, 'countUnread').type, 'function');
  assert.equal(byName(routes, 'countUnread').comment, 'Count unread emails per category.');
  assert.equal(byName(routes, 'formatSender').type, 'function');
  assert.equal(byName(routes, 'formatSender').end, 29);

  // IMAP service
  const imap = inFile('backend/services/imap.js');
  assert.equal(byName(imap, 'syncMailbox').type, 'function');
  assert.equal(byName(imap, 'syncMailbox').comment, 'Fetch new messages from the IMAP server and store them.');
  assert.deepEqual(byName(imap, 'syncMailbox').extra.tables, ['email_accounts', 'email_messages']);
  assert.equal(byName(imap, 'purgeOld').type, 'function');
  const job = imap.find((u) => u.type === 'job');
  assert.equal(job.name, 'cron */5 * * * *');
  assert.equal(job.comment, 'Sync every five minutes.');

  // React
  const app = byName(inFile('frontend/src/App.js'), 'App');
  assert.equal(app.type, 'component');
  const list = byName(inFile('frontend/src/components/EmailList.js'), 'EmailList');
  assert.equal(list.type, 'page');
  assert.equal(list.extra.route, '/emails');
  assert.ok(list.extra.calls.includes('/api/emails'));
  assert.equal(list.area, 'email');
  const settings = byName(inFile('frontend/src/components/Settings.jsx'), 'Settings');
  assert.equal(settings.type, 'page');
  assert.equal(settings.extra.route, '/settings');
  assert.equal(settings.comment, 'Settings page: IMAP account form.');

  // Flask
  const py = inFile('api/app.py');
  const items = byName(py, 'GET /api/items');
  assert.equal(items.type, 'endpoint');
  assert.equal(items.comment, 'Return every item from the items table.');
  assert.equal(items.extra.handler, 'list_items');
  assert.deepEqual(items.extra.tables, ['items']);
  assert.equal(items.area, 'api');
  assert.equal(byName(py, 'ItemStore').type, 'class');
  assert.equal(byName(py, 'ItemStore').comment, 'In-memory store used by the tests.');
  assert.equal(byName(py, 'add').type, 'method');
  assert.equal(byName(py, 'add').extra.parent, 'ItemStore');
  assert.equal(byName(py, 'add').comment, 'Append an item and return its index.');
  assert.equal(byName(py, 'make_store').type, 'function');
  assert.equal(byName(py, 'make_store').comment, 'Build the store once at import time.');

  // TypeScript
  const ts = inFile('lib/util.ts');
  assert.equal(byName(ts, 'DateFormatter').type, 'class');
  assert.equal(byName(ts, 'DateFormatter').comment, 'Formats dates for the UI.');
  const methods = ts.filter((u) => u.type === 'method' && u.extra.parent === 'DateFormatter').map((u) => u.name);
  assert.deepEqual(methods, ['format', 'relative']);
  assert.equal(byName(ts, 'capitalise').type, 'function');
  assert.equal(byName(ts, 'capitalise').lang, 'ts');

  // files table
  const info = map.files['backend/routes/emails.js'];
  assert.equal(info.lines, 32);
  assert.equal(info.lang, 'js');
  assert.equal(info.area, 'email');
  assert.equal(info.header, 'Email routes: list, archive and stats for the inbox page.');
  assert.equal(info.n_units, 4);
  for (const u of map.units) {
    assert.equal(u.id, `${u.file}:${u.start} ${u.name}`);
    assert.ok(u.end >= u.start);
  }
});

test('build merges descriptions.json by id and by file::name', () => {
  const dir = tmpDir('desc');
  try {
    const file = path.join(dir, 'descriptions.json');
    fs.writeFileSync(file, JSON.stringify({
      'backend/routes/emails.js::countUnread': 'Counts the unread rows.',
      'backend/routes/emails.js:8 GET /api/emails': 'Lists the inbox.',
      'backend/routes/emails.js::missing': 'ignored',
    }));
    const map = build(FIXTURE, loadConfig(FIXTURE, { descriptions: file }));
    assert.equal(byName(map.units, 'countUnread').description, 'Counts the unread rows.');
    assert.equal(byName(map.units, 'countUnread').comment, 'Count unread emails per category.');
    assert.equal(byName(map.units, 'GET /api/emails').description, 'Lists the inbox.');
    assert.equal(byName(map.units, 'purgeOld').description, 'Remove messages older than 90 days.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMarkdown groups by area and file with one bullet per unit', () => {
  const map = build(FIXTURE, loadConfig(FIXTURE));
  const md = renderMarkdown(map);
  assert.ok(md.startsWith('# Codebase map\n'));
  assert.ok(md.includes('## Area: email'));
  assert.ok(md.includes('## Area: api'));
  assert.ok(md.includes('### backend/routes/emails.js (32 lines) - Email routes'));
  assert.ok(md.includes('- `8-11` **GET /api/emails** - List emails with filters (category, archived). [tables: email_messages; auth: optionalAuth]'));
  assert.ok(md.includes('[api: /api/emails'));
  assert.ok(md.includes('route: /emails]'));
  assert.ok(!md.includes('—'));
});

test('writeMap writes map.json and map.md and loadMap reads them back', () => {
  const dir = tmpDir('out');
  try {
    const map = build(FIXTURE, loadConfig(FIXTURE));
    const { jsonPath, mdPath } = writeMap(map, dir);
    assert.equal(jsonPath, path.join(dir, 'map.json'));
    assert.equal(mdPath, path.join(dir, 'map.md'));
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(fs.existsSync(mdPath));
    const back = loadMap(dir);
    assert.equal(back.n_units, map.n_units);
    assert.equal(back.units.length, map.units.length);
    assert.deepEqual(back.units[0], map.units[0]);
    assert.equal(back.files['lib/util.ts'].lang, 'ts');
    const relative = writeMap(map, '.jevmap-test');
    assert.equal(relative.jsonPath, path.join(FIXTURE, '.jevmap-test', 'map.json'));
    assert.ok(fs.existsSync(relative.jsonPath));
    fs.rmSync(path.join(FIXTURE, '.jevmap-test'), { recursive: true, force: true });
    assert.equal(loadMap(path.join(dir, 'missing')), null);
    fs.writeFileSync(jsonPath, '{ broken');
    assert.equal(loadMap(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(FIXTURE, '.jevmap-test'), { recursive: true, force: true });
  }
});
