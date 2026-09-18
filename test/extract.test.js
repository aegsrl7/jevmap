'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFile, findRouteTable, areaOf, parseMiddleware, fileHeader } = require('../src/extract');
const { rulesFor, detectLang } = require('../src/languages');

const byName = (units, name) => units.find((u) => u.name === name);

test('detectLang maps extensions and ignores the rest', () => {
  assert.equal(detectLang('a/b.js'), 'js');
  assert.equal(detectLang('a/b.tsx'), 'ts');
  assert.equal(detectLang('a/b.py'), 'py');
  assert.equal(detectLang('x.kts'), 'kotlin');
  assert.equal(detectLang('x.cs'), 'csharp');
  assert.equal(detectLang('x.rb'), 'ruby');
  assert.equal(detectLang('README.md'), null);
  assert.equal(detectLang('.bashrc'), null);
  assert.equal(detectLang('Makefile'), null);
});

test('rulesFor covers every language and falls back to a generic set', () => {
  for (const lang of ['js', 'ts', 'py', 'go', 'rs', 'java', 'kotlin', 'csharp', 'swift', 'ruby', 'php', 'sh', 'sql']) {
    const r = rulesFor(lang);
    assert.ok(Array.isArray(r.patterns) && r.patterns.length > 0, lang);
    assert.ok(r.comment && Array.isArray(r.comment.line), lang);
  }
  assert.deepEqual(rulesFor(null).patterns, []);
});

test('findRouteTable reads component= and element= forms and route objects', () => {
  const app = `
    <Route path="/emails" component={EmailList} />
    <Route path="/settings" element={<Settings />} />
    <Route exact path="/orders/:id" element={<OrderPage id={1} />} />
  `;
  const objects = `const routes = [{ path: '/home', element: <Home /> }, { path: '/about', component: About }];`;
  const table = findRouteTable(new Map([['App.js', app], ['routes.js', objects]]));
  assert.equal(table.EmailList, '/emails');
  assert.equal(table.Settings, '/settings');
  assert.equal(table.OrderPage, '/orders/:id');
  assert.equal(table.Home, '/home');
  assert.equal(table.About, '/about');
  assert.deepEqual(findRouteTable({ 'x.js': 'const a = 1;' }), {});
});

test('Express routes: method, path, middleware, comment, tables, emits, imports', () => {
  const text = [
    "const router = require('express').Router();",
    '',
    '// List emails with filters.',
    "router.get('/api/emails', optionalAuth, requireRoles(['admin']), async (req, res) => {",
    "  const rows = await db.query('SELECT * FROM email_messages');",
    "  const imap = require('../services/imap');",
    "  io.emit('email-updated', rows);",
    '  res.json(rows);',
    '});',
    "router.delete('/api/emails/:id', auth, controller.remove);",
  ].join('\n');
  const units = extractFile('backend/routes/emails.js', text, 'js', {});
  const get = byName(units, 'GET /api/emails');
  assert.ok(get);
  assert.equal(get.type, 'endpoint');
  assert.equal(get.start, 4);
  assert.equal(get.end, 9);
  assert.equal(get.comment, 'List emails with filters.');
  assert.deepEqual(get.extra.middleware, ['optionalAuth', "requireRoles(['admin'])"]);
  assert.deepEqual(get.extra.tables, ['email_messages']);
  assert.deepEqual(get.extra.emits, ['email-updated']);
  assert.deepEqual(get.extra.imports, ['../services/imap']);
  assert.equal(get.id, 'backend/routes/emails.js:4 GET /api/emails');
  const del = byName(units, 'DELETE /api/emails/:id');
  assert.equal(del.type, 'endpoint');
  assert.deepEqual(del.extra.middleware, ['auth']);
  assert.equal(del.end, 10);
});

test('parseMiddleware keeps the middleware and drops the handler', () => {
  assert.deepEqual(parseMiddleware(", optionalAuth, upload.single('file'), async (req, res) => {"), ['optionalAuth', "upload.single('file')"]);
  assert.deepEqual(parseMiddleware(', auth, controller.list);'), ['auth']);
  assert.deepEqual(parseMiddleware(', controller.list);'), []);
  assert.deepEqual(parseMiddleware(', function (req, res) {'), []);
});

test('JS functions, arrow consts, classes with methods, jobs and JSDoc comments', () => {
  const text = [
    '/**',
    ' * Sum two numbers.',
    ' * @param {number} a',
    ' */',
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    '// ---------------',
    '// Multiply.',
    'export const mul = (a, b) => a * b;',
    '',
    'class Store {',
    '  // Save a record.',
    '  async save(rec) {',
    "    await db.query('INSERT INTO records (a) VALUES (?)', [rec]);",
    '  }',
    '',
    '  static load = async (id) => {',
    '    return cache.get(id);',
    '  };',
    '}',
    '',
    '// Nightly cleanup.',
    "cron.schedule('0 3 * * *', () => {",
    '  purge();',
    '});',
    'setInterval(tick, 1000);',
  ].join('\n');
  const units = extractFile('src/x.js', text, 'js', {});
  const add = byName(units, 'add');
  assert.equal(add.type, 'function');
  assert.equal(add.comment, 'Sum two numbers.');
  assert.equal(add.start, 5);
  assert.equal(add.end, 7);
  const mul = byName(units, 'mul');
  assert.equal(mul.type, 'function');
  assert.equal(mul.comment, 'Multiply.');
  assert.equal(mul.end, 11);
  const store = byName(units, 'Store');
  assert.equal(store.type, 'class');
  assert.equal(store.end, 22);
  const save = byName(units, 'save');
  assert.equal(save.type, 'method');
  assert.equal(save.extra.parent, 'Store');
  assert.equal(save.comment, 'Save a record.');
  assert.deepEqual(save.extra.tables, ['records']);
  const load = byName(units, 'load');
  assert.equal(load.type, 'method');
  const cron = byName(units, 'cron 0 3 * * *');
  assert.equal(cron.type, 'job');
  assert.equal(cron.comment, 'Nightly cleanup.');
  assert.equal(cron.end, 27);
  assert.equal(byName(units, 'interval tick').type, 'job');
  assert.equal(units.filter((u) => u.name === 'save').length, 1);
});

test('nested definitions inside a top-level unit are not separate units', () => {
  const text = [
    'export default function Page() {',
    "  const load = () => axios.get('/api/things');",
    '  return (',
    '    <div>{load()}</div>',
    '  );',
    '}',
  ].join('\n');
  const units = extractFile('frontend/src/Page.js', text, 'js', {});
  assert.equal(units.length, 1);
  assert.equal(units[0].type, 'component');
  assert.deepEqual(units[0].extra.calls, ['/api/things']);
});

test('React components become pages when the route table maps them', () => {
  const text = [
    "import React from 'react';",
    '',
    '// Inbox page.',
    'const Inbox = () => {',
    "  const rows = fetch(`${API}/api/emails?x=1`);",
    '  return <Table rows={rows} />;',
    '};',
    'class Old extends React.Component {',
    '  render() { return <div />; }',
    '}',
    'function helper() { return 1; }',
  ].join('\n');
  const units = extractFile('frontend/src/Inbox.js', text, 'js', {}, { Inbox: '/inbox' });
  const inbox = byName(units, 'Inbox');
  assert.equal(inbox.type, 'page');
  assert.equal(inbox.extra.route, '/inbox');
  assert.deepEqual(inbox.extra.calls, ['/api/emails?x=1']);
  assert.equal(inbox.comment, 'Inbox page.');
  assert.equal(byName(units, 'Old').type, 'component');
  assert.equal(byName(units, 'helper').type, 'function');
});

test('NestJS decorators produce endpoints with the controller prefix', () => {
  const text = [
    "@Controller('users')",
    'export class UsersController {',
    "  @Get(':id')",
    '  findOne(@Param() id: string) {',
    '    return this.service.find(id);',
    '  }',
    '',
    '  @Post()',
    '  create(@Body() dto: Dto) {',
    '    return this.service.create(dto);',
    '  }',
    '}',
  ].join('\n');
  const units = extractFile('src/users.controller.ts', text, 'ts', {});
  const one = byName(units, 'GET /users/:id');
  assert.ok(one);
  assert.equal(one.type, 'endpoint');
  assert.equal(one.extra.handler, 'findOne');
  assert.equal(byName(units, 'POST /users').type, 'endpoint');
  assert.equal(byName(units, 'POST /users').extra.parent, 'UsersController');
});

test('Python: Flask route with docstring, class, method and def with a # comment', () => {
  const text = [
    '"""Module docstring."""',
    'from flask import Flask',
    '',
    "@app.route('/api/items', methods=['GET', 'POST'])",
    'def items():',
    '    """List or create items."""',
    "    return db.execute('SELECT * FROM items')",
    '',
    '',
    'class Store:',
    '    """A store."""',
    '',
    '    def add(self, x):',
    '        """Add x."""',
    '        self.items.append(x)',
    '',
    '',
    '# Helper.',
    'def helper():',
    '    def inner():',
    '        pass',
    '    return inner',
    '',
    '@celery.task',
    'def nightly():',
    '    pass',
  ].join('\n');
  const units = extractFile('api/app.py', text, 'py', {});
  const route = byName(units, 'GET,POST /api/items');
  assert.ok(route);
  assert.equal(route.type, 'endpoint');
  assert.equal(route.comment, 'List or create items.');
  assert.equal(route.extra.handler, 'items');
  assert.deepEqual(route.extra.tables, ['items']);
  assert.equal(route.start, 5);
  assert.equal(route.end, 7);
  const store = byName(units, 'Store');
  assert.equal(store.type, 'class');
  assert.equal(store.comment, 'A store.');
  assert.equal(store.end, 15);
  const add = byName(units, 'add');
  assert.equal(add.type, 'method');
  assert.equal(add.extra.parent, 'Store');
  assert.equal(add.comment, 'Add x.');
  const helper = byName(units, 'helper');
  assert.equal(helper.type, 'function');
  assert.equal(helper.comment, 'Helper.');
  assert.equal(helper.end, 22);
  assert.equal(byName(units, 'inner'), undefined);
  assert.equal(byName(units, 'nightly').type, 'job');
});

test('TypeScript class with methods, interface and exported function', () => {
  const text = [
    'export interface Opts { a: string }',
    '/** Formatter. */',
    'export class Fmt {',
    '  private locale = "en";',
    '  format(d: Date): string {',
    '    return String(d);',
    '  }',
    '  public async relative<T>(d: T): Promise<string> {',
    '    return "";',
    '  }',
    '}',
    'export function cap(s: string): string { return s; }',
  ].join('\n');
  const units = extractFile('lib/util.ts', text, 'ts', {});
  assert.equal(byName(units, 'Opts').type, 'class');
  assert.equal(byName(units, 'Opts').extra.kind, 'interface');
  const fmt = byName(units, 'Fmt');
  assert.equal(fmt.type, 'class');
  assert.equal(fmt.comment, 'Formatter.');
  const methods = units.filter((u) => u.type === 'method' && u.extra.parent === 'Fmt').map((u) => u.name);
  assert.deepEqual(methods, ['format', 'relative']);
  assert.equal(byName(units, 'cap').type, 'function');
  assert.equal(byName(units, 'cap').end, 12);
});

test('Go, Rust, Java, C#, Kotlin, Swift, Ruby, PHP, shell and SQL rules find their units', () => {
  const go = extractFile('main.go', [
    '// Handler for users.',
    'func (s *Server) Users(w http.ResponseWriter, r *http.Request) {',
    '}',
    'func main() {',
    '\tr.HandleFunc("/users", s.Users)',
    '\te.GET("/ping", ping)',
    '}',
    'type Server struct {',
    '\tdb *sql.DB',
    '}',
  ].join('\n'), 'go', {});
  assert.equal(byName(go, 'Users').type, 'method');
  assert.equal(byName(go, 'Users').extra.parent, 'Server');
  assert.equal(byName(go, 'Users').comment, 'Handler for users.');
  assert.equal(byName(go, 'main').type, 'function');
  assert.equal(byName(go, 'ANY /users').type, 'endpoint');
  assert.equal(byName(go, 'GET /ping').type, 'endpoint');
  assert.equal(byName(go, 'Server').type, 'class');

  const rs = extractFile('src/lib.rs', [
    '/// A point.',
    'pub struct Point { x: i32 }',
    'impl Point {',
    '    /// Make one.',
    '    pub fn new() -> Self { Point { x: 0 } }',
    '}',
    '#[get("/health")]',
    'async fn health() -> &\'static str { "ok" }',
    'fn main() {}',
  ].join('\n'), 'rs', {});
  assert.equal(byName(rs, 'Point').type, 'class');
  assert.equal(byName(rs, 'Point').comment, 'A point.');
  assert.equal(byName(rs, 'impl Point').type, 'class');
  assert.equal(byName(rs, 'new').type, 'method');
  assert.equal(byName(rs, 'new').extra.parent, 'impl Point');
  assert.equal(byName(rs, 'GET /health').type, 'endpoint');
  assert.equal(byName(rs, 'main').type, 'function');

  const java = extractFile('src/Api.java', [
    'package x;',
    '@RequestMapping("/api")',
    'public class Api {',
    '    @GetMapping("/users")',
    '    public List<User> users() {',
    '        return repo.findAll();',
    '    }',
    '    // Save one.',
    '    private void save(User u) throws IOException {',
    '    }',
    '}',
  ].join('\n'), 'java', {});
  assert.equal(byName(java, 'Api').type, 'class');
  assert.equal(byName(java, 'GET /api/users').type, 'endpoint');
  assert.equal(byName(java, 'GET /api/users').extra.handler, 'users');
  assert.equal(byName(java, 'save').type, 'method');
  assert.equal(byName(java, 'save').comment, 'Save one.');

  const cs = extractFile('Api.cs', [
    'namespace App.Web',
    '{',
    '    [Route("api/[controller]")]',
    '    public class ItemsController : ControllerBase',
    '    {',
    '        [HttpGet("{id}")]',
    '        public async Task<Item> Get(int id)',
    '        {',
    '            return await _db.Find(id);',
    '        }',
    '        public int Count() => 1;',
    '    }',
    '}',
  ].join('\n'), 'csharp', {});
  assert.equal(byName(cs, 'ItemsController').type, 'class');
  assert.equal(byName(cs, 'GET /api/[controller]/{id}').type, 'endpoint');
  assert.equal(byName(cs, 'Count').type, 'method');
  assert.equal(byName(cs, 'Count').extra.parent, 'ItemsController');

  const kt = extractFile('Main.kt', [
    'data class User(val id: Int)',
    'class Repo {',
    '    // Find.',
    '    fun find(id: Int): User? = null',
    '}',
    'fun main() {',
    '    println("hi")',
    '}',
  ].join('\n'), 'kotlin', {});
  assert.equal(byName(kt, 'User').type, 'class');
  assert.equal(byName(kt, 'find').type, 'method');
  assert.equal(byName(kt, 'find').comment, 'Find.');
  assert.equal(byName(kt, 'main').type, 'function');

  const swift = extractFile('App.swift', [
    'struct User { let id: Int }',
    'final class Store {',
    '    func load() -> [User] { [] }',
    '}',
    'func run() {}',
  ].join('\n'), 'swift', {});
  assert.equal(byName(swift, 'User').type, 'class');
  assert.equal(byName(swift, 'load').type, 'method');
  assert.equal(byName(swift, 'run').type, 'function');

  const rb = extractFile('app/models/user.rb', [
    '# A user.',
    'class User < ApplicationRecord',
    '  # Full name.',
    '  def full_name',
    '    "#{first} #{last}"',
    '  end',
    '',
    '  def self.find_by_email(e)',
    '    where(email: e).first',
    '  end',
    'end',
    "get '/health' do",
    "  'ok'",
    'end',
  ].join('\n'), 'ruby', {});
  assert.equal(byName(rb, 'User').type, 'class');
  assert.equal(byName(rb, 'User').comment, 'A user.');
  assert.equal(byName(rb, 'User').end, 11);
  assert.equal(byName(rb, 'full_name').type, 'method');
  assert.equal(byName(rb, 'full_name').end, 6);
  assert.equal(byName(rb, 'find_by_email').type, 'method');
  assert.equal(byName(rb, 'GET /health').type, 'endpoint');
  assert.equal(byName(rb, 'GET /health').end, 14);

  const php = extractFile('routes/web.php', [
    '<?php',
    "Route::get('/users', [UserController::class, 'index']);",
    '// Helper.',
    'function helper($x) {',
    '    return $x;',
    '}',
    'class Foo {',
    '    public function bar() {',
    '    }',
    '}',
  ].join('\n'), 'php', {});
  assert.equal(byName(php, 'GET /users').type, 'endpoint');
  assert.equal(byName(php, 'helper').type, 'function');
  assert.equal(byName(php, 'helper').comment, 'Helper.');
  assert.equal(byName(php, 'bar').type, 'method');

  const sh = extractFile('deploy.sh', [
    '#!/bin/bash',
    '# Build the app.',
    'build() {',
    '  npm run build # comment with } brace',
    '}',
    'function deploy {',
    '  rsync -a dist/ server:/var/www',
    '}',
  ].join('\n'), 'sh', {});
  assert.equal(byName(sh, 'build').type, 'function');
  assert.equal(byName(sh, 'build').comment, 'Build the app.');
  assert.equal(byName(sh, 'build').end, 5);
  assert.equal(byName(sh, 'deploy').type, 'function');

  const sql = extractFile('schema.sql', [
    '-- Users of the app.',
    'CREATE TABLE IF NOT EXISTS users (',
    '  id INT PRIMARY KEY,',
    '  email TEXT',
    ');',
    'CREATE OR REPLACE VIEW active_users AS SELECT * FROM users WHERE active = 1;',
    'CREATE FUNCTION total_users() RETURNS INT AS $$ SELECT COUNT(*) FROM users $$;',
  ].join('\n'), 'sql', {});
  assert.equal(byName(sql, 'table users').type, 'class');
  assert.equal(byName(sql, 'table users').comment, 'Users of the app.');
  assert.equal(byName(sql, 'table users').end, 5);
  assert.equal(byName(sql, 'view active_users').type, 'class');
  assert.equal(byName(sql, 'function total_users').type, 'function');
  assert.deepEqual(byName(sql, 'function total_users').extra.tables, ['users']);
});

test('whole-file fallback unit when nothing is found', () => {
  const text = '// Constants for the app.\nmodule.exports = { A: 1, B: 2 };\n';
  const units = extractFile('backend/constants/x.js', text, 'js', {});
  assert.equal(units.length, 1);
  assert.equal(units[0].type, 'file');
  assert.equal(units[0].name, 'x.js');
  assert.equal(units[0].start, 1);
  assert.equal(units[0].comment, 'Constants for the app.');
  assert.equal(units[0].id, 'backend/constants/x.js:1 x.js');
  const md = extractFile('docs/guide.md', '# Guide\n\ntext\n', null, {});
  assert.equal(md.length, 1);
  assert.equal(md[0].type, 'file');
  assert.equal(md[0].lang, null);
});

test('comment extraction strips decoration, tags and respects the 240 char cap', () => {
  const long = 'x'.repeat(300);
  const text = ['// ======', `// ${long}`, '// ======', 'function f() {}'].join('\n');
  const [u] = extractFile('a.js', text, 'js', {});
  assert.equal(u.comment.length, 240);
  const text2 = ['/* One. */', 'function g() {}', '', '// Two.', '', 'function h() {}'].join('\n');
  const units = extractFile('b.js', text2, 'js', {});
  assert.equal(byName(units, 'g').comment, 'One.');
  assert.equal(byName(units, 'h').comment, '');
});

test('fileHeader reads the leading comment block', () => {
  assert.equal(fileHeader(['#!/usr/bin/env node', '// Tool.', '// Second line.', 'const a = 1;'], rulesFor('js')), 'Tool. Second line.');
  assert.equal(fileHeader(['"""Module doc.', 'More.', '"""', 'import os'], rulesFor('py')), 'Module doc. More.');
  assert.equal(fileHeader(['const a = 1;', '// not a header'], rulesFor('js')), '');
});

test('areaOf uses config areas on the basename, then the path, then the first directory', () => {
  const config = { areas: [['email|imap', 'email'], ['components/laser', 'laser']] };
  assert.equal(areaOf('backend/routes/emails.js', config), 'email');
  assert.equal(areaOf('frontend/src/components/laser/Panel.js', config), 'laser');
  assert.equal(areaOf('backend/routes/orders.js', config), 'backend');
  assert.equal(areaOf('server.js', config), 'root');
  assert.equal(areaOf('a/b.js', {}), 'a');
  assert.equal(areaOf('a/b.js', { areas: [['(', 'broken']] }), 'a');
});
