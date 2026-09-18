#!/usr/bin/env node
'use strict';

// jevmap CLI: argument parsing and printing only. All the work lives in src/.
//
//   jevmap build [--root .] [--out .jevmap] [--project "..."] [--include g --exclude g] [--json]
//   jevmap find "task" [--mode scan|prefilter] [--split llm|heuristic|none] [--top 15] [--files-only] [--json]
//   jevmap describe [--model claude-haiku-4-5] [--dry-run] [--max-units 500]
//   jevmap bench [--commits 100] [--modes scan,prefilter] [--json]
//   jevmap --help | --version
//
// Exit codes: 0 ok, 1 error (message on stderr), 2 usage.

const fs = require('fs');
const path = require('path');

const PKG = require('../package.json');
const SRC = path.join(__dirname, '..', 'src');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const DEFAULTS = {
  top: 15,
  candidates: 40,
  batch: 60,
  maxUnits: 500,
  commits: 100,
  modes: ['scan', 'prefilter'],
  describeModel: 'claude-haiku-4-5',
  jevModel: 'jev-latest',
  jevTimeoutMs: 30000,
  jevMaxRetry: 2,
};

// Options that take a value. Repeatable ones accumulate into an array.
const VALUE_OPTIONS = new Set([
  'root', 'out', 'project', 'include', 'exclude', 'descriptions', 'mode', 'split', 'top',
  'batch', 'candidates', 'model', 'max-units', 'commits', 'modes',
]);
const REPEATABLE_OPTIONS = new Set(['include', 'exclude']);
const BOOLEAN_OPTIONS = new Set(['json', 'files-only', 'dry-run', 'help', 'version', 'no-color']);

// ---------------------------------------------------------------------------
// Colours (plain ANSI, only on a TTY)
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.argv.includes('--no-color');
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const red = paint('31');

// ---------------------------------------------------------------------------
// Argument parsing (by hand, no dependency)
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq > -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (BOOLEAN_OPTIONS.has(name)) {
        if (value !== undefined) throw new UsageError(`Option --${name} takes no value`);
        out.flags[name] = true;
        continue;
      }
      if (!VALUE_OPTIONS.has(name)) throw new UsageError(`Unknown option --${name}`);
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`Option --${name} needs a value`);
        value = argv[++i];
      }
      if (REPEATABLE_OPTIONS.has(name)) {
        (out.flags[name] = out.flags[name] || []).push(value);
      } else {
        out.flags[name] = value;
      }
      continue;
    }
    if (a === '-h') { out.flags.help = true; continue; }
    if (a === '-v' || a === '-V') { out.flags.version = true; continue; }
    if (a.startsWith('-') && a.length > 1) throw new UsageError(`Unknown option ${a}`);
    if (out.command === null) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

function intOption(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`Option --${name} must be a positive integer (got "${flags[name]}")`);
  return n;
}

function enumOption(flags, name, allowed, fallback) {
  if (flags[name] === undefined) return fallback;
  const v = String(flags[name]).toLowerCase();
  if (!allowed.includes(v)) throw new UsageError(`Option --${name} must be one of: ${allowed.join(', ')} (got "${flags[name]}")`);
  return v;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `jevmap ${PKG.version}
Map a codebase into units and let Jev pick the files that matter for a task.

Usage:
  jevmap build [--root .] [--out .jevmap] [--project "..."] [--include g] [--exclude g] [--json]
  jevmap find "task" [--mode scan|prefilter] [--split llm|heuristic|none] [--top 15]
                     [--files-only] [--json] [--batch 60] [--candidates 40]
  jevmap describe [--model claude-haiku-4-5] [--dry-run] [--max-units 500]
  jevmap bench [--commits 100] [--modes scan,prefilter] [--top 15] [--json]
  jevmap --help | --version

Commands:
  build      Scan the repository and write <out>/map.json and <out>/map.md (no AI).
  find       Ask Jev which units matter for the task; print files and units by probability.
  describe   Fill missing unit descriptions with an Anthropic model, then rebuild the map.
  bench      Measure the finder on the git history (message = task, touched files = answer).

Common options:
  --root <dir>        Repository root (default: current directory).
  --out <dir>         Map output directory, relative to root (default: .jevmap).
  --project <text>    One sentence about the project, used inside Jev questions.
  --include <glob>    Only scan matching paths (repeatable).
  --exclude <glob>    Skip matching paths (repeatable).
  --descriptions <f>  Descriptions file merged at build time (default: <out>/descriptions.json).
  --json              Print the raw result as JSON.

find options:
  --mode scan|prefilter    scan (default): one yes/no per unit, batched, in parallel.
                           prefilter: keyword score, then one choice question on the candidates.
  --split llm|heuristic|none   How composite tasks are split (default: llm when
                           ANTHROPIC_API_KEY is set, otherwise heuristic).
  --top <n>                Units to print (default 15).
  --files-only             Print only the files to read.
  --batch <n>              Units per Jev request in scan mode (default 60).
  --candidates <n>         Candidates for the prefilter choice (default 40).

describe options:
  --model <id>             Anthropic model (default claude-haiku-4-5).
  --dry-run                Print what would be sent, do not call the API.
  --max-units <n>          Stop after this many units (default 500).

bench options:
  --commits <n>            Commits to read from git log (default 100).
  --modes scan,prefilter   Modes to measure (default both).

Environment:
  TYPESAFE_API_KEY    Jev key (https://docs.typesafe.ai). Without it, find falls back to keyword order.
  ANTHROPIC_API_KEY   Used by describe and by the llm task splitter (CLAUDE_API_KEY is accepted too).
  JEV_MODEL           Jev model id (default jev-latest).
A .env file in the repository root is read for these variables.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(p) {
  return String(Math.round((Number(p) || 0) * 100)).padStart(3) + '%';
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtUsd(v) {
  return '$' + (Number(v) || 0).toFixed(4);
}

function capitalise(s) {
  s = String(s || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shorten(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function makeLogger(json) {
  // Progress goes to stderr so --json output stays clean on stdout.
  return (msg) => {
    if (json) return;
    process.stderr.write(dim(String(msg)) + '\n');
  };
}

function resolveRoot(flags) {
  const root = path.resolve(process.cwd(), flags.root || '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Root directory not found: ${root}`);
  }
  return root;
}

function configOverrides(flags) {
  const o = {};
  if (flags.out !== undefined) o.out = flags.out;
  if (flags.project !== undefined) o.project = flags.project;
  if (flags.include) o.include = flags.include;
  if (flags.exclude) o.exclude = flags.exclude;
  if (flags.descriptions !== undefined) o.descriptions = flags.descriptions;
  if (flags.batch !== undefined) o.batch = intOption(flags, 'batch', DEFAULTS.batch);
  return o;
}

function loadMapOrExplain(root, config) {
  const { loadMap } = require(path.join(SRC, 'build.js'));
  const outDir = path.resolve(root, config.out || '.jevmap');
  const map = loadMap(outDir);
  if (!map) {
    const err = new Error(`No map found at ${path.join(outDir, 'map.json')}. Run \`jevmap build\` first (add --root if the repository is elsewhere).`);
    err.exitCode = EXIT_ERROR;
    throw err;
  }
  return { map, outDir };
}

function jevOptions(config, flags) {
  const env = (config && config.env) || {};
  return {
    apiKey: env.TYPESAFE_API_KEY || '',
    model: env.JEV_MODEL || DEFAULTS.jevModel,
    timeoutMs: DEFAULTS.jevTimeoutMs,
    maxRetry: DEFAULTS.jevMaxRetry,
  };
}

function llmOptions(config, flags) {
  const env = (config && config.env) || {};
  return {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: flags.model || DEFAULTS.describeModel,
  };
}

// ---------------------------------------------------------------------------
// Printing of a find result
// ---------------------------------------------------------------------------

function printPart(part, { filesOnly, top }) {
  console.log(`${bold('Task:')} ${part.task}`);
  if (part.note) console.log(yellow(part.note));
  const mode = part.mode || 'scan';
  if (part.calls !== undefined && part.calls !== null && part.calls > 0) {
    console.log(`${capitalise(mode)}: ${part.calls} call${part.calls === 1 ? '' : 's'} in ${part.ms || 0} ms, ${fmtTokens(part.tokens)} tokens (${fmtUsd(part.cost_usd)})`);
  }
  console.log(bold('Files to read:'));
  const files = part.files || [];
  if (!files.length) console.log(dim('  (no candidate)'));
  for (const f of files) {
    const label = f.p === null || f.p === undefined ? String(f.score === undefined ? '' : f.score).padStart(4) : pct(f.p);
    console.log(`  ${green(label)}  ${f.file}`);
  }
  if (filesOnly) return;
  console.log(bold('Units:'));
  const units = (part.units || []).slice(0, top);
  if (!units.length) console.log(dim('  (no candidate)'));
  for (const u of units) {
    const label = u.p === null || u.p === undefined ? String(u.score === undefined ? '' : u.score).padStart(4) : pct(u.p);
    const where = `${u.file}:${u.line}`;
    const desc = u.description ? dim(' - ' + shorten(u.description, 70)) : '';
    console.log(`  ${green(label)}  ${cyan(where)}  ${u.name}${desc}`);
  }
}

function printFindResult(result, opts) {
  const parts = result.parts || [];
  if (parts.length > 1) {
    console.log(bold(`Composite task, ${parts.length} parts:`));
    parts.forEach((p, i) => {
      console.log(`\n${bold(`[${i + 1}/${parts.length}]`)}`);
      printPart(p, opts);
    });
    return;
  }
  if (parts.length === 1) {
    printPart(parts[0], opts);
    return;
  }
  console.log(yellow('No result.'));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdBuild(flags) {
  const root = resolveRoot(flags);
  const { loadConfig } = require(path.join(SRC, 'config.js'));
  const { build, writeMap } = require(path.join(SRC, 'build.js'));
  const config = loadConfig(root, configOverrides(flags));
  const log = makeLogger(flags.json);
  const t0 = Date.now();
  const map = await build(root, config, { log });
  const outDir = path.resolve(root, config.out || '.jevmap');
  const written = writeMap(map, outDir);
  const ms = Date.now() - t0;
  if (flags.json) {
    console.log(JSON.stringify({
      root,
      out: outDir,
      n_files: map.n_files,
      n_units: map.n_units,
      generated: map.generated,
      json: written.jsonPath,
      md: written.mdPath,
      ms,
    }, null, 2));
    return EXIT_OK;
  }
  console.log(`${green('Map built')}: ${map.n_files} files, ${map.n_units} units in ${ms} ms`);
  console.log(`  ${written.jsonPath}`);
  console.log(`  ${written.mdPath}`);
  const missing = (map.units || []).filter((u) => !u.description).length;
  if (missing) console.log(dim(`  ${missing} units have no description: run \`jevmap describe\` to fill them (needs ANTHROPIC_API_KEY).`));
  return EXIT_OK;
}

async function cmdFind(flags, positional) {
  const task = positional.join(' ').trim();
  if (!task) throw new UsageError('find needs a task, for example: jevmap find "add the customer to the email list"');
  const root = resolveRoot(flags);
  const { loadConfig } = require(path.join(SRC, 'config.js'));
  const config = loadConfig(root, configOverrides(flags));
  const { map } = loadMapOrExplain(root, config);

  const top = intOption(flags, 'top', DEFAULTS.top);
  const candidates = intOption(flags, 'candidates', DEFAULTS.candidates);
  const batch = intOption(flags, 'batch', config.batch || DEFAULTS.batch);
  const mode = enumOption(flags, 'mode', ['scan', 'prefilter'], 'scan');
  const jev = jevOptions(config, flags);
  const llm = llmOptions(config, flags);
  const split = enumOption(flags, 'split', ['llm', 'heuristic', 'none'], llm.apiKey ? 'llm' : 'heuristic');
  const printOpts = { filesOnly: Boolean(flags['files-only']), top };

  // Without a Jev key, find() returns the keyword prefilter order (scores
  // instead of probabilities) and marks the part with a note.
  if (!jev.apiKey && !flags.json) {
    process.stderr.write(yellow('TYPESAFE_API_KEY is not set: falling back to the keyword prefilter order (no Jev). Set the key to get probabilities.\n'));
  }
  const { find } = require(path.join(SRC, 'find.js'));
  const result = await find(map, task, {
    mode,
    split,
    top,
    candidates,
    batch,
    jev,
    llm,
    project: config.project || '',
  });

  if (flags.json) {
    if (flags['files-only']) {
      const slim = { task: result.task, mode: result.mode, parts: (result.parts || []).map((p) => ({ task: p.task, files: p.files })) };
      console.log(JSON.stringify(slim, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return EXIT_OK;
  }
  printFindResult(result, printOpts);
  return EXIT_OK;
}

async function cmdDescribe(flags) {
  const root = resolveRoot(flags);
  const { loadConfig } = require(path.join(SRC, 'config.js'));
  const { build, writeMap } = require(path.join(SRC, 'build.js'));
  const { describe } = require(path.join(SRC, 'describe.js'));
  const config = loadConfig(root, configOverrides(flags));
  const { map, outDir } = loadMapOrExplain(root, config);
  const dryRun = Boolean(flags['dry-run']);
  const apiKey = (config.env && config.env.ANTHROPIC_API_KEY) || '';
  if (!apiKey && !dryRun) {
    throw new Error('ANTHROPIC_API_KEY is not set (CLAUDE_API_KEY is accepted too). Add it to the environment or to .env, or use --dry-run to see what would be sent.');
  }
  const log = makeLogger(flags.json);
  const outFile = path.resolve(root, config.descriptions || path.join(config.out || '.jevmap', 'descriptions.json'));
  const res = await describe(map, root, {
    apiKey,
    model: flags.model || DEFAULTS.describeModel,
    maxUnits: intOption(flags, 'max-units', DEFAULTS.maxUnits),
    dryRun,
    log,
    outFile,
  });

  let rebuilt = null;
  if (!dryRun && res && res.described > 0) {
    log('Rebuilding the map with the new descriptions...');
    const fresh = await build(root, config, { log });
    rebuilt = writeMap(fresh, outDir);
  }

  if (flags.json) {
    console.log(JSON.stringify(Object.assign({}, res, { rebuilt: Boolean(rebuilt) }), null, 2));
    return EXIT_OK;
  }
  if (dryRun) {
    console.log(`${bold('Dry run')}: ${res.described || 0} units would be described in ${res.requests || 0} request${res.requests === 1 ? '' : 's'}.`);
    return EXIT_OK;
  }
  console.log(`${green('Described')} ${res.described || 0} units in ${res.requests || 0} request${res.requests === 1 ? '' : 's'}, ${fmtTokens(res.tokens)} tokens (about ${fmtUsd(res.cost_usd_estimate)})`);
  console.log(`  ${res.outFile || outFile}`);
  if (rebuilt) console.log(`  map rebuilt: ${rebuilt.jsonPath}`);
  return EXIT_OK;
}

function printBenchTable(result) {
  const modes = Object.keys(result.modes || {});
  console.log(`${bold('Commits:')} ${result.commits} usable (message = task, touched files = answer)`);
  if (!modes.length) {
    console.log(yellow('No mode measured.'));
    return;
  }
  const header = ['mode'.padEnd(11), 'top-1'.padStart(6), 'top-3'.padStart(6), 'top-5'.padStart(6), 'cov@3'.padStart(6), 'calls'.padStart(7), 'tokens'.padStart(8), 'cost'.padStart(9), 'ms'.padStart(7)].join(' ');
  console.log(bold(header));
  for (const m of modes) {
    const s = result.modes[m] || {};
    const cov = result.coverageTop3 ? result.coverageTop3[m] : undefined;
    console.log([
      m.padEnd(11),
      `${s.top1 === undefined ? '-' : s.top1 + '%'}`.padStart(6),
      `${s.top3 === undefined ? '-' : s.top3 + '%'}`.padStart(6),
      `${s.top5 === undefined ? '-' : s.top5 + '%'}`.padStart(6),
      `${cov === undefined ? '-' : cov + '%'}`.padStart(6),
      String(s.calls === undefined ? '-' : Number(s.calls).toFixed(1)).padStart(7),
      fmtTokens(s.tokens).padStart(8),
      fmtUsd(s.cost_usd).padStart(9),
      String(s.ms === undefined ? '-' : Math.round(s.ms)).padStart(7),
    ].join(' '));
  }
  console.log(dim('top-N: share of commits whose first touched file is within the first N proposed files.'));
  console.log(dim('cov@3: average share of touched files found in the top-3 files of any part. calls, tokens, ms: average per commit; cost: total.'));
  if (result.outFile) console.log(dim(`Rows written to ${result.outFile}`));
}

async function cmdBench(flags) {
  const root = resolveRoot(flags);
  const { loadConfig } = require(path.join(SRC, 'config.js'));
  const { bench } = require(path.join(SRC, 'bench.js'));
  const config = loadConfig(root, configOverrides(flags));
  const { map, outDir } = loadMapOrExplain(root, config);
  const jev = jevOptions(config, flags);
  if (!jev.apiKey) throw new Error('bench needs TYPESAFE_API_KEY (https://docs.typesafe.ai). Add it to the environment or to .env.');
  const llm = llmOptions(config, flags);
  const commits = intOption(flags, 'commits', DEFAULTS.commits);
  const top = intOption(flags, 'top', DEFAULTS.top);
  let modes = DEFAULTS.modes;
  if (flags.modes !== undefined) {
    modes = String(flags.modes).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = modes.filter((m) => !['scan', 'prefilter'].includes(m));
    if (!modes.length || bad.length) throw new UsageError(`Option --modes must be a comma-separated list of scan, prefilter (got "${flags.modes}")`);
  }
  const log = makeLogger(flags.json);
  const result = await bench(root, map, {
    modes,
    commits,
    top,
    jev,
    llm,
    project: config.project || '',
    batch: intOption(flags, 'batch', config.batch || DEFAULTS.batch),
    candidates: intOption(flags, 'candidates', DEFAULTS.candidates),
    log,
    outDir,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }
  printBenchTable(result);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function describeError(err) {
  if (!err) return 'unknown error';
  let msg = err.message || String(err);
  if (err.status) msg = `${msg} (HTTP ${err.status})`;
  if (err.body && typeof err.body === 'string' && err.body.length < 300) msg = `${msg}: ${err.body}`;
  if (err.code === 'MODULE_NOT_FOUND') msg = `${msg}. The installation looks incomplete: reinstall jevmap.`;
  return msg;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(red(`Usage error: ${e.message}\n`));
      process.stderr.write('Run `jevmap --help` for the full usage.\n');
      return EXIT_USAGE;
    }
    throw e;
  }
  const { command, positional, flags } = parsed;

  if (flags.version) {
    console.log(PKG.version);
    return EXIT_OK;
  }
  if (flags.help || command === 'help' || (!command && !positional.length)) {
    process.stdout.write(HELP);
    return command || flags.help ? EXIT_OK : EXIT_USAGE;
  }

  const commands = { build: cmdBuild, find: cmdFind, describe: cmdDescribe, bench: cmdBench };
  const run = commands[command];
  if (!run) {
    process.stderr.write(red(`Unknown command "${command}". Commands: build, find, describe, bench.\n`));
    process.stderr.write('Run `jevmap --help` for the full usage.\n');
    return EXIT_USAGE;
  }
  try {
    return await run(flags, positional);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(red(`Usage error: ${e.message}\n`));
      return EXIT_USAGE;
    }
    process.stderr.write(red(`Error: ${describeError(e)}\n`));
    if (process.env.JEVMAP_DEBUG && e && e.stack) process.stderr.write(dim(e.stack) + '\n');
    return typeof e.exitCode === 'number' ? e.exitCode : EXIT_ERROR;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(red(`Error: ${describeError(e)}\n`));
      process.exitCode = EXIT_ERROR;
    }
  );
}

module.exports = { parseArgs, main, printFindResult, printBenchTable, UsageError };
