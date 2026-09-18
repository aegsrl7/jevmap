'use strict';

// Configuration: defaults, jevmap.config.json, CLI overrides and the environment.
// Precedence: CLI overrides > jevmap.config.json > defaults.
// Environment: process.env first, then <root>/.env for the missing keys.
// Only the known variables are read from .env and none of them is ever printed.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'jevmap.config.json';
const ENV_KEYS = ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'JEV_MODEL'];
const DEFAULT_JEV_MODEL = 'jev-latest';
const MAX_FILE_BYTES = 1024 * 1024;

// Directories, generated files, lockfiles and binaries that are never scanned.
// A pattern without a slash matches any path segment (like .gitignore).
const DEFAULT_EXCLUDES = [
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'dist', 'build', 'out',
  'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target', '.jevmap', '.next',
  '.nuxt', '.cache', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.tox',
  '*.min.js', '*.min.css', '*.map', '*.bundle.js',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.svg', '*.webp', '*.bmp', '*.tif', '*.tiff',
  '*.pdf', '*.zip', '*.gz', '*.tar', '*.tgz', '*.7z', '*.rar', '*.bz2', '*.xz',
  '*.woff', '*.woff2', '*.ttf', '*.eot', '*.otf',
  '*.mp3', '*.mp4', '*.mov', '*.avi', '*.wav', '*.ogg', '*.webm',
  '*.exe', '*.dll', '*.so', '*.dylib', '*.class', '*.jar', '*.war', '*.pyc', '*.pyo',
  '*.wasm', '*.bin', '*.db', '*.sqlite', '*.sqlite3', '*.o', '*.a', '*.obj', '*.lib',
];

const DEFAULTS = {
  project: '',
  include: [],
  exclude: [],
  areas: [],
  out: '.jevmap',
  descriptions: '.jevmap/descriptions.json',
  batch: 60,
};

const globCache = new Map();

// Compile a glob pattern into an anchored RegExp. Supports **, * and ?.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()[]{}|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function compiledGlob(pattern) {
  let re = globCache.get(pattern);
  if (!re) { re = globToRegExp(pattern); globCache.set(pattern, re); }
  return re;
}

// True when the glob pattern matches the relative path (always with forward slashes).
// A pattern without a slash matches any segment of the path (basename or directory),
// a pattern with a slash matches the whole path or one of its ancestor directories.
function matchGlob(pattern, relPath) {
  if (!pattern) return false;
  let p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (!p) return false;
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  const re = compiledGlob(p);
  if (!p.includes('/')) {
    return rel.split('/').some((seg) => re.test(seg));
  }
  if (re.test(rel)) return true;
  const segs = rel.split('/');
  for (let k = segs.length - 1; k > 0; k--) {
    if (re.test(segs.slice(0, k).join('/'))) return true;
  }
  return false;
}

// Minimal KEY=VALUE parser for .env files: comments, blank lines, `export KEY=...`,
// single or double quotes stripped, unquoted trailing ` # comment` removed.
function parseEnv(text) {
  const out = {};
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}

// Read the known variables: process.env wins, <root>/.env fills the gaps.
function readEnv(root) {
  const found = {};
  for (const k of ENV_KEYS) if (process.env[k]) found[k] = process.env[k];
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    let parsed = {};
    try { parsed = parseEnv(fs.readFileSync(envPath, 'utf8')); } catch (_) { parsed = {}; }
    for (const k of ENV_KEYS) if (!found[k] && parsed[k]) found[k] = parsed[k];
  }
  return {
    TYPESAFE_API_KEY: found.TYPESAFE_API_KEY || '',
    ANTHROPIC_API_KEY: found.ANTHROPIC_API_KEY || found.CLAUDE_API_KEY || '',
    JEV_MODEL: found.JEV_MODEL || DEFAULT_JEV_MODEL,
  };
}

function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function toAreas(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    if (Array.isArray(a) && a.length >= 2) out.push([String(a[0]), String(a[1])]);
    else if (a && typeof a === 'object' && a.pattern && a.name) out.push([String(a.pattern), String(a.name)]);
  }
  return out;
}

function readConfigFile(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`Cannot read ${CONFIG_FILE}: ${e.message}`); }
  try { return JSON.parse(text) || {}; } catch (e) { throw new Error(`Invalid JSON in ${CONFIG_FILE}: ${e.message}`); }
}

// Build the effective configuration for a repository root.
function loadConfig(root, overrides = {}) {
  const absRoot = path.resolve(root || '.');
  const fileCfg = readConfigFile(absRoot);
  const ov = {};
  for (const [k, v] of Object.entries(overrides || {})) if (v !== undefined && v !== null) ov[k] = v;
  const merged = Object.assign({}, DEFAULTS, fileCfg, ov);
  const batch = Number(merged.batch);
  return {
    root: absRoot,
    project: String(merged.project || ''),
    include: toList(merged.include),
    exclude: toList(merged.exclude),
    areas: toAreas(merged.areas),
    out: String(merged.out || DEFAULTS.out),
    descriptions: String(merged.descriptions || DEFAULTS.descriptions),
    batch: Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : DEFAULTS.batch,
    env: readEnv(absRoot),
  };
}

module.exports = {
  loadConfig,
  DEFAULT_EXCLUDES,
  DEFAULTS,
  CONFIG_FILE,
  ENV_KEYS,
  MAX_FILE_BYTES,
  matchGlob,
  globToRegExp,
  parseEnv,
  readEnv,
};
