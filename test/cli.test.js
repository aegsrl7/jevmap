'use strict';

// CLI smoke tests: spawn bin/jevmap.js and check exit codes and text.
// No network, no map: only bin/jevmap.js and package.json are needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'jevmap.js');
const PKG = require(path.join(ROOT, 'package.json'));

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_API_KEY: '', NO_COLOR: '1' }, opts.env || {}),
    timeout: 20000,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('--help exits 0 and lists the commands', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /jevmap build/);
  assert.match(r.stdout, /jevmap find/);
  assert.match(r.stdout, /jevmap describe/);
  assert.match(r.stdout, /jevmap bench/);
  assert.match(r.stdout, /TYPESAFE_API_KEY/);
  assert.equal(r.stderr, '');
});

test('-h is the same as --help', () => {
  const r = run(['-h']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test('--version prints the package.json version and exits 0', () => {
  const r = run(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG.version);
  assert.match(PKG.version, /^\d+\.\d+\.\d+/);
});

test('no arguments prints the help and exits 2', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Usage:/);
});

test('unknown command exits 2 with a message on stderr', () => {
  const r = run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});

test('unknown option exits 2', () => {
  const r = run(['find', 'something', '--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option --bogus/);
});

test('find without a task exits 2', () => {
  const r = run(['find']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /find needs a task/);
});

test('an option that needs a value but has none exits 2', () => {
  const r = run(['find', 'x', '--top']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--top needs a value/);
});

test('a missing root directory exits 1', () => {
  const r = run(['build', '--root', path.join(os.tmpdir(), 'jevmap-does-not-exist-' + process.pid)]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Root directory not found/);
});

test('find in a repository without a map exits 1 and says to run build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevmap-cli-'));
  try {
    const r = run(['find', 'add a field', '--root', dir]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.length > 0, 'expected a message on stderr');
    const srcReady = fs.existsSync(path.join(ROOT, 'src', 'config.js')) && fs.existsSync(path.join(ROOT, 'src', 'build.js'));
    if (srcReady) assert.match(r.stderr, /jevmap build/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs handles repeatable and --key=value options', () => {
  const { parseArgs } = require(BIN);
  const p = parseArgs(['build', '--include', 'src/**', '--include=lib/**', '--out=.map', '--json']);
  assert.equal(p.command, 'build');
  assert.deepEqual(p.flags.include, ['src/**', 'lib/**']);
  assert.equal(p.flags.out, '.map');
  assert.equal(p.flags.json, true);
  const f = parseArgs(['find', 'add', 'the', 'customer', '--top', '5']);
  assert.equal(f.command, 'find');
  assert.deepEqual(f.positional, ['add', 'the', 'customer']);
  assert.equal(f.flags.top, '5');
});
