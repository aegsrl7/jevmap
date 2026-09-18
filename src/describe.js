'use strict';

// Fill missing unit descriptions with an Anthropic model. The extractor only
// keeps the comment above a unit; units without one get a one-line
// description here, written into <root>/.jevmap/descriptions.json (key = unit
// id). Existing keys are never overwritten; rebuild the map afterwards.

const fs = require('fs');
const path = require('path');
const { anthropicJson } = require('./llm');

const DEFAULT_MODEL = 'claude-haiku-4-5';
const UNITS_PER_REQUEST = 25;
const MAX_LINES_PER_UNIT = 60;
const HEADER_LINES = 5;
const CONCURRENCY = 4;

// Anthropic list prices for Claude Haiku 4.5 (USD per million tokens), as of
// 09/2026. Used only for the estimate printed at the end.
const HAIKU_INPUT_USD_PER_MTOKEN = 1;
const HAIKU_OUTPUT_USD_PER_MTOKEN = 5;

const SYSTEM_PROMPT = [
  'You receive source code units (functions, endpoints, classes, components) from one file of a software project.',
  'For each unit write ONE line saying what it does: max 160 characters, no imperative mood, no leading verb like "Function that", plain statement.',
  'Write in the same language as the code comments of the file (English if there are none).',
  'Mention tables, endpoints, events or pages when they appear in the code.',
  'Answer ONLY with JSON: {"descriptions": {"<unit id>": "..."}} using exactly the unit ids given.',
].join(' ');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch (_) {
    return null;
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function sliceUnit(lines, unit) {
  const start = Math.max(1, Number(unit.start) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(unit.end) || start), start + MAX_LINES_PER_UNIT - 1);
  const body = lines.slice(start - 1, end);
  const truncated = (Number(unit.end) || start) > end;
  return { start, end, source: body.join('\n') + (truncated ? '\n// ... (truncated)' : '') };
}

function buildRequest(relFile, lines, group) {
  const header = lines.slice(0, HEADER_LINES).join('\n');
  const blocks = group.map((u) => {
    const s = sliceUnit(lines, u);
    return `### id: ${u.id}\n(${u.type || 'unit'} ${u.name || ''}, lines ${s.start}-${s.end})\n\`\`\`\n${s.source}\n\`\`\``;
  });
  const user = `File: ${relFile}\nFirst lines of the file:\n\`\`\`\n${header}\n\`\`\`\n\nUnits:\n\n${blocks.join('\n\n')}`;
  return { file: relFile, ids: group.map((u) => u.id), user };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

/**
 * Describe units without a description.
 *
 * @param {object} map        map.json content
 * @param {string} root       repository root (unit files are relative to it)
 * @param {object} options
 * @param {string} options.apiKey       ANTHROPIC_API_KEY (required unless dryRun)
 * @param {string} [options.model]      default 'claude-haiku-4-5'
 * @param {number} [options.maxUnits]   cap on units sent, default 500
 * @param {boolean} [options.dryRun]    print what would be sent, no request, no write
 * @param {function} [options.log]      line printer, default console.log
 * @param {function} [options.llmImpl]  anthropicJson-compatible function (tests inject a fake)
 * @param {string} [options.outFile]    default <root>/.jevmap/descriptions.json
 * @returns {Promise<{ described, requests, tokens, cost_usd_estimate, outFile }>}
 */
async function describe(map, root, {
  apiKey,
  model = DEFAULT_MODEL,
  maxUnits = 500,
  dryRun = false,
  log = console.log,
  llmImpl = anthropicJson,
  outFile,
} = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const rootDir = path.resolve(root || '.');
  const target = outFile ? path.resolve(outFile) : path.join(rootDir, '.jevmap', 'descriptions.json');
  const units = (map && Array.isArray(map.units)) ? map.units : [];
  const existing = readJson(target);
  const cap = Math.max(0, Number(maxUnits) || 0);

  const missing = units
    .filter((u) => u && u.id && !String(u.description || '').trim() && !existing[u.id])
    .slice(0, cap);

  const summary = { described: 0, requests: 0, tokens: 0, cost_usd_estimate: 0, outFile: target };
  if (!missing.length) {
    say('All units already have a description; nothing to do.');
    return summary;
  }
  if (!dryRun && !apiKey) throw new Error('ANTHROPIC_API_KEY is missing (needed by `jevmap describe`)');

  // Group by file, max UNITS_PER_REQUEST per request.
  const byFile = new Map();
  for (const u of missing) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u);
  }
  const requests = [];
  let unreadable = 0;
  for (const [relFile, group] of byFile) {
    const lines = readLines(path.join(rootDir, relFile));
    if (!lines) { unreadable += group.length; say(`skip ${relFile}: cannot read file`); continue; }
    for (const part of chunk(group, UNITS_PER_REQUEST)) requests.push(buildRequest(relFile, lines, part));
  }
  say(`${missing.length} units without description in ${byFile.size} files -> ${requests.length} requests to ${model}${unreadable ? ` (${unreadable} skipped, file unreadable)` : ''}`);

  if (dryRun) {
    for (const r of requests) {
      say(`\n--- ${r.file} (${r.ids.length} units, ~${Math.round(r.user.length / 4)} tokens) ---`);
      say(r.user);
    }
    say(`\nDry run: nothing sent, nothing written to ${target}`);
    summary.requests = requests.length;
    return summary;
  }

  const found = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = 0;
  await runPool(requests, async (r) => {
    try {
      const res = await llmImpl({ apiKey, model, system: SYSTEM_PROMPT, user: r.user, maxTokens: 60 * r.ids.length + 200 });
      const d = (res && res.json && res.json.descriptions) || {};
      let got = 0;
      for (const id of r.ids) {
        const v = d[id];
        if (typeof v === 'string' && v.trim()) { found[id] = v.trim().replace(/\s+/g, ' ').slice(0, 160); got++; }
      }
      inputTokens += (res && res.usage && Number(res.usage.input_tokens)) || 0;
      outputTokens += (res && res.usage && Number(res.usage.output_tokens)) || 0;
      say(`${r.file}: ${got}/${r.ids.length} described`);
    } catch (e) {
      failed++;
      say(`${r.file}: request failed (${e && e.message ? e.message : e})`);
    }
  }, CONCURRENCY);

  // Merge: never overwrite existing keys.
  const merged = { ...existing };
  let added = 0;
  for (const [id, desc] of Object.entries(found)) {
    if (merged[id]) continue;
    merged[id] = desc;
    added++;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged, null, 1) + '\n', 'utf8');

  const cost = inputTokens / 1e6 * HAIKU_INPUT_USD_PER_MTOKEN + outputTokens / 1e6 * HAIKU_OUTPUT_USD_PER_MTOKEN;
  summary.described = added;
  summary.requests = requests.length;
  summary.tokens = inputTokens + outputTokens;
  summary.cost_usd_estimate = Math.round(cost * 1e6) / 1e6;
  say(`Described ${added} units in ${requests.length} requests${failed ? ` (${failed} failed)` : ''}; ${inputTokens} in + ${outputTokens} out tokens, about $${cost.toFixed(4)} (list prices)`);
  say(`Written ${target}; run \`jevmap build\` to merge the descriptions into the map.`);
  return summary;
}

module.exports = {
  describe,
  buildRequest,
  sliceUnit,
  SYSTEM_PROMPT,
  HAIKU_INPUT_USD_PER_MTOKEN,
  HAIKU_OUTPUT_USD_PER_MTOKEN,
  UNITS_PER_REQUEST,
};
