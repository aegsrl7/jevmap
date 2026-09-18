'use strict';

// Benchmark of the finder on the git history: every recent commit is a test
// case where the commit message is the task and the touched source files are
// the right answer. For each mode (scan, prefilter) we record the rank of the
// first touched file among the proposed files and the per-part coverage, the
// same measures as the original bench-trova.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MODES = ['scan', 'prefilter'];
const MIN_MESSAGE_LENGTH = 15;

// Trailers that carry no information about the task.
const TRAILER_RX = /^(co-authored-by|claude-session|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|cc|change-id|refs?|see-also|fixes|closes):/i;

// Touched files that are never a good "answer": docs, lockfiles, data and config files.
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
]);
const EXCLUDED_EXT = new Set(['.md', '.markdown', '.rst', '.txt', '.json', '.yml', '.yaml', '.lock', '.toml', '.ini', '.cfg']);

function isExcludedTarget(file, outDir) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  if (LOCKFILES.has(base)) return true;
  if (EXCLUDED_EXT.has(path.posix.extname(base))) return true;
  if (/(^|\/)docs?\//.test(lower)) return true;
  if (outDir) {
    const rel = outDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel && (lower === rel.toLowerCase() || lower.startsWith(rel.toLowerCase() + '/'))) return true;
  }
  return false;
}

function looksLikePath(line) {
  return /^[^\s]+$/.test(line) && !/^@@/.test(line);
}

// Pure parser of `git log --pretty=format:'@@%h|%s|%b' --name-only` output.
// Returns [{ hash, task, files }], newest first. Options:
//   mapFiles: object or Set of relative paths present in the map (keeps only those)
//   outDir:   map output directory (relative), excluded from the targets
function parseGitLog(raw, { mapFiles, outDir } = {}) {
  const has = (f) => {
    if (!mapFiles) return true;
    if (mapFiles instanceof Set) return mapFiles.has(f);
    return Object.prototype.hasOwnProperty.call(mapFiles, f);
  };
  const out = [];
  const blocks = String(raw || '').split(/(?:^|\n)@@/).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const head = lines[0];
    const firstBar = head.indexOf('|');
    const secondBar = head.indexOf('|', firstBar + 1);
    if (firstBar < 0 || secondBar < 0) continue;
    const hash = head.slice(0, firstBar).trim();
    const subject = head.slice(firstBar + 1, secondBar).trim();
    const bodyLines = [head.slice(secondBar + 1)];

    // The file list is the trailing block of non-empty, whitespace-free lines.
    const rest = lines.slice(1);
    let end = rest.length;
    while (end > 0 && !rest[end - 1].trim()) end--;
    let start = end;
    while (start > 0 && rest[start - 1].trim() && looksLikePath(rest[start - 1].trim())) start--;
    const fileLines = rest.slice(start, end).map((l) => l.trim());
    bodyLines.push(...rest.slice(0, start));

    if (/^merge\b/i.test(subject)) continue;

    const body = bodyLines
      .map((l) => l.trim())
      .filter((l) => l && !TRAILER_RX.test(l));
    const task = [subject, ...body].join(' ').replace(/\s+/g, ' ').trim();
    if (task.length < MIN_MESSAGE_LENGTH) continue;

    const seen = new Set();
    const files = [];
    for (const f of fileLines) {
      if (seen.has(f) || !has(f) || isExcludedTarget(f, outDir)) continue;
      seen.add(f);
      files.push(f);
    }
    if (!files.length) continue;
    out.push({ hash, task, files });
  }
  return out;
}

// Reads the last `n` commits of the repository at `root`.
// Options: { mapFiles, outDir } as in parseGitLog. Throws if git is missing or
// the directory is not a repository.
function listCommits(root, n, options = {}) {
  let raw;
  try {
    raw = execFileSync('git', ['log', '-n', String(n), '--pretty=format:@@%h|%s|%b', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = e && e.stderr ? String(e.stderr).trim().split('\n')[0] : (e && e.message) || '';
    const err = new Error(`Cannot read the git history of ${root}: ${detail || 'git not available'}`);
    err.cause = e;
    throw err;
  }
  return parseGitLog(raw, options);
}

// Rank (1-based) of the first proposed file that is a touched file; 0 = miss.
function rankOfFirstHit(proposed, touched) {
  const set = new Set(touched);
  const i = (proposed || []).findIndex((f) => set.has(f));
  return i < 0 ? 0 : i + 1;
}

// Union of the proposed files of every part, in order, without duplicates.
function unionFiles(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts || []) {
    for (const f of p.files || []) {
      const name = typeof f === 'string' ? f : f.file;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Share of touched files found in the top `k` files of any part.
function coverage(parts, touched, k) {
  if (!touched.length) return 0;
  const found = new Set();
  for (const p of parts || []) {
    for (const f of (p.files || []).slice(0, k)) found.add(typeof f === 'string' ? f : f.file);
  }
  return touched.filter((f) => found.has(f)).length / touched.length;
}

function sumParts(parts, key) {
  return (parts || []).reduce((a, p) => a + (Number(p[key]) || 0), 0);
}

function round(v, digits) {
  const m = Math.pow(10, digits);
  return Math.round((Number(v) || 0) * m) / m;
}

// Runs the finder on every usable commit, in the requested modes.
// Returns { commits, modes: { <mode>: { top1, top3, top5, calls, tokens, cost_usd, ms } },
//           coverageTop3: { <mode>: pct }, rows, outFile }.
// `findImpl` is injectable for tests (same signature as find.js#find).
async function bench(root, map, options = {}) {
  const {
    modes = DEFAULT_MODES,
    commits = 100,
    top = 15,
    jev = {},
    llm = {},
    project = '',
    batch,
    candidates,
    split,
    log = () => {},
    findImpl,
    outDir,
  } = options;

  // Lazy requires keep the pure helpers (parseGitLog and friends) usable alone.
  const find = findImpl || require('./find').find;
  const { costUsd } = require('./jev');
  const outRel = outDir ? path.relative(root, outDir) : '';
  const list = listCommits(root, commits, { mapFiles: map && map.files, outDir: outRel });
  log(`${list.length} usable commits out of the last ${commits}; modes: ${modes.join(', ')}`);

  const splitMode = split || (llm && llm.apiKey ? 'llm' : 'heuristic');
  const rows = [];
  for (const c of list) {
    const row = { hash: c.hash, task: c.task.slice(0, 70), targets: c.files.length, files: c.files };
    for (const mode of modes) {
      const t0 = Date.now();
      try {
        const res = await find(map, c.task, {
          mode,
          split: splitMode,
          top,
          batch,
          candidates,
          jev,
          llm,
          project,
        });
        const parts = res.parts || [];
        row[mode] = {
          parts: parts.length,
          rank: rankOfFirstHit(unionFiles(parts), c.files),
          coverage1: round(coverage(parts, c.files, 1), 3),
          coverage3: round(coverage(parts, c.files, 3), 3),
          calls: sumParts(parts, 'calls'),
          tokens: sumParts(parts, 'tokens'),
          cost_usd: round(sumParts(parts, 'cost_usd') || costUsd(sumParts(parts, 'tokens')), 6),
          ms: Date.now() - t0,
        };
      } catch (e) {
        row[mode] = { parts: 0, rank: 0, coverage1: 0, coverage3: 0, calls: 0, tokens: 0, cost_usd: 0, ms: Date.now() - t0, error: (e && e.message) || String(e) };
        log(`  ${c.hash} ${mode}: ${row[mode].error}`);
      }
    }
    rows.push(row);
    log(`  ${rows.length}/${list.length} ${c.hash} ${modes.map((m) => `${m}#${row[m].rank || '-'}`).join(' ')}`);
  }

  const n = rows.length;
  const pct = (fn) => (n ? Math.round((100 * rows.filter(fn).length) / n) : 0);
  const avg = (fn) => (n ? rows.reduce((a, r) => a + (Number(fn(r)) || 0), 0) / n : 0);
  const summary = {};
  const coverageTop3 = {};
  for (const mode of modes) {
    const g = (r) => r[mode] || {};
    summary[mode] = {
      top1: pct((r) => g(r).rank === 1),
      top3: pct((r) => g(r).rank >= 1 && g(r).rank <= 3),
      top5: pct((r) => g(r).rank >= 1 && g(r).rank <= 5),
      calls: round(avg((r) => g(r).calls), 1),
      tokens: Math.round(avg((r) => g(r).tokens)),
      cost_usd: round(rows.reduce((a, r) => a + (Number(g(r).cost_usd) || 0), 0), 4),
      ms: Math.round(avg((r) => g(r).ms)),
      errors: rows.filter((r) => g(r).error).length,
    };
    coverageTop3[mode] = Math.round(100 * avg((r) => g(r).coverage3));
  }

  const result = { commits: n, requested: commits, modes: summary, coverageTop3, rows };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'bench.json');
    fs.writeFileSync(outFile, JSON.stringify(Object.assign({ generated: new Date().toISOString() }, result), null, 1));
    result.outFile = outFile;
  }
  return result;
}

module.exports = { bench, listCommits, parseGitLog, rankOfFirstHit, unionFiles, coverage, isExcludedTarget };
