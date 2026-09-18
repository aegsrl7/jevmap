'use strict';

// Finder: given a task written in plain language, say which units of the map
// a developer must read or modify, with a probability per unit.
//
// Modes:
//   scan (default): one `noul` question per unit ("must read or modify this
//     unit for the task?"), batched `batch` units per Jev call, all batches in
//     parallel. Measured on 103 AEGEST commits: top-1 76%, top-5 90%.
//   prefilter: keyword score -> top `candidates` units -> one `choice`
//     question with criteria u1..uN plus `none`.
// Composite tasks ("add X; fix Y") are split (LLM or heuristic) and each part
// is searched in parallel, because a single choice spreads its probability
// over several right answers.

const text = require('./text');
const { createJevClient, choice, noul, costUsd } = require('./jev');

const DEFAULT_TOP = 15;
const DEFAULT_CANDIDATES = 40;
const DEFAULT_BATCH = 60;
const MAX_PARTS = 8;
const DESCRIPTION_IN_QUESTION = 200;
const DESCRIPTION_IN_RESULT = 120;

const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const round6 = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;
const list = (arr, n) => (Array.isArray(arr) && arr.length ? arr.slice(0, n).join(', ') : '');
const descriptionOf = (u) => String((u && (u.description || u.comment)) || '');

// Fallback used only when src/text.js does not expose looksComposite.
function localLooksComposite(task) {
  const t = String(task || '');
  return /[\n;•]|,\s*\S+\s+\S+/.test(t) || t.split(/\s+/).filter(Boolean).length > 14;
}
const looksComposite = typeof text.looksComposite === 'function' ? text.looksComposite : localLooksComposite;

function projectClause(project) {
  const p = String(project || '').trim();
  return p ? ` in the project (${p})` : '';
}

/**
 * Compact one-line description of a unit, used inside Jev questions:
 * "file | type name | does: ... | tables: ... | calls: ... | page ..."
 */
function unitLabel(unit) {
  const u = unit || {};
  const extra = u.extra || {};
  const desc = descriptionOf(u).slice(0, DESCRIPTION_IN_QUESTION);
  const kind = u.type === 'endpoint' ? `endpoint ${u.name || ''}` : `${u.type || 'unit'} ${u.name || ''}`;
  const tables = list(extra.tables, 5);
  const calls = list(extra.calls, 5);
  return [
    u.file || '',
    kind.trim(),
    desc ? `does: ${desc}` : '',
    tables ? `tables: ${tables}` : '',
    calls ? `calls: ${calls}` : '',
    extra.route ? `page ${extra.route}` : '',
  ].filter(Boolean).join(' | ');
}

// Text of a unit used by the keyword prefilter (id, name, path, description, extra).
function unitSearchText(u) {
  const extra = (u && u.extra) || {};
  return [
    u.id, u.name, u.file, u.area, descriptionOf(u), u.comment,
    extra.path, extra.route, extra.parent,
    ...(Array.isArray(extra.tables) ? extra.tables : []),
    ...(Array.isArray(extra.calls) ? extra.calls : []),
    ...(Array.isArray(extra.emits) ? extra.emits : []),
  ].filter(Boolean).join(' ');
}

function unitNameText(u) {
  const extra = (u && u.extra) || {};
  return [u.name, u.file, extra.path, extra.route].filter(Boolean).join(' ');
}

/**
 * Keyword prefilter: score each unit against the task tokens; +0.5 per query
 * word found in the name or path (more specific than the description).
 * @returns {Array<{ unit, score }>} top `n`, score > 0, best first
 */
function prefilterUnits(map, task, n = DEFAULT_CANDIDATES) {
  const units = (map && Array.isArray(map.units)) ? map.units : [];
  const queryTokens = text.tokenize(String(task || ''));
  if (!queryTokens.length) return [];
  const scored = [];
  for (const unit of units) {
    const base = Number(text.keywordScore(unitSearchText(unit), queryTokens)) || 0;
    if (base <= 0) continue;
    const inName = Number(text.keywordScore(unitNameText(unit), queryTokens)) || 0;
    scored.push({ unit, score: base + 0.5 * inName });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(n) || DEFAULT_CANDIDATES));
}

async function askWithOneRetry(jevClient, state, questions) {
  try {
    return await jevClient.ask(state, questions);
  } catch (first) {
    try {
      return await jevClient.ask(state, questions);
    } catch (second) {
      second.firstError = first;
      throw second;
    }
  }
}

/**
 * Full scan: one noul question per unit, `batch` units per Jev call, all
 * batches in parallel. Each batch is retried once on failure; a batch that
 * fails twice makes the whole scan reject (find() handles the fallback).
 * @returns {Promise<{ scored: Array<{ unit, p }>, calls, ms, tokens }>}
 */
async function scanUnits(map, task, { jevClient, batch = DEFAULT_BATCH, project } = {}) {
  if (!jevClient || typeof jevClient.ask !== 'function') throw new Error('scanUnits needs a jevClient');
  const units = (map && Array.isArray(map.units)) ? map.units : [];
  const size = Math.max(1, Number(batch) || DEFAULT_BATCH);
  const batches = [];
  for (let i = 0; i < units.length; i += size) batches.push(units.slice(i, i + size));
  const t0 = Date.now();
  let tokens = 0;
  const where = projectClause(project);
  const state = { task: String(task) };
  const results = await Promise.all(batches.map(async (group) => {
    const questions = {};
    group.forEach((unit, k) => {
      questions['q' + k] = noul(
        `To carry out the task in \`task\`${where}, a developer must read or modify this code unit: ${unitLabel(unit)}`
      );
    });
    const res = await askWithOneRetry(jevClient, state, questions);
    tokens += (res.usage && Number(res.usage.input_tokens)) || 0;
    return group.map((unit, k) => {
      const a = res.answers && res.answers['q' + k];
      const p = a && typeof a.noul === 'number' ? a.noul : 0;
      return { unit, p };
    });
  }));
  const scored = results.flat().sort((a, b) => b.p - a.p);
  return { scored, calls: batches.length, ms: Date.now() - t0, tokens };
}

/**
 * Rerank keyword candidates with one Jev `choice` (criteria u1..uN + none).
 * @param {Array<{ unit, score }>} candidates
 * @returns {Promise<{ ordered: Array<{ unit, score, p }>, confidence, none, ms, tokens }>}
 */
async function rerankWithJev(task, candidates, { jevClient, project } = {}) {
  if (!jevClient || typeof jevClient.ask !== 'function') throw new Error('rerankWithJev needs a jevClient');
  const cands = Array.isArray(candidates) ? candidates : [];
  if (!cands.length) return { ordered: [], confidence: 0, none: 0, ms: 0, tokens: 0 };
  const criteria = {};
  cands.forEach((c, k) => {
    const u = c.unit || {};
    const extra = u.extra || {};
    const entry = {
      file: u.file,
      unit: u.name,
      type: u.type,
      does: descriptionOf(u).slice(0, 220),
    };
    if (Array.isArray(extra.tables) && extra.tables.length) entry.tables = extra.tables.slice(0, 6);
    if (Array.isArray(extra.calls) && extra.calls.length) entry.calls = extra.calls.slice(0, 6);
    if (extra.route) entry.route = extra.route;
    criteria['u' + (k + 1)] = entry;
  });
  criteria.none = 'None of these units is the right place for the task';
  const question = choice(
    `A developer must carry out the task described in \`task\`${projectClause(project)}. Which code unit is the main place to work on? Consider file, name, what it does, tables and API calls. If the task touches both backend and frontend, pick the unit that holds the logic to change.`,
    criteria
  );
  const t0 = Date.now();
  const res = await askWithOneRetry(jevClient, { task: String(task) }, { unit: question });
  const answer = (res.answers && res.answers.unit) || {};
  const probs = answer.probabilities || {};
  const ordered = cands
    .map((c, k) => ({ unit: c.unit, score: c.score, p: Number(probs['u' + (k + 1)]) || 0 }))
    .sort((a, b) => b.p - a.p);
  return {
    ordered,
    confidence: Number(answer.confidence) || 0,
    none: Number(probs.none) || 0,
    ms: Date.now() - t0,
    tokens: (res.usage && Number(res.usage.input_tokens)) || 0,
  };
}

/**
 * Split a composite task into self-contained parts.
 * split = 'llm' (Anthropic model when a key exists and the text looks
 * composite, else heuristic), 'heuristic' (text.splitTask), 'none' ([task]).
 */
async function splitComposite(task, { split = 'llm', llm = {} } = {}) {
  const whole = String(task || '').trim();
  if (!whole) return [];
  if (split === 'none') return [whole];
  if (split === 'heuristic' || !llm || !llm.apiKey || !looksComposite(whole)) {
    return heuristicParts(whole);
  }
  try {
    const { anthropicJson } = require('./llm');
    const { json } = await anthropicJson({
      apiKey: llm.apiKey,
      model: llm.model || undefined,
      maxTokens: 600,
      system: 'You receive the description of a job to do on a software project. Split it into the DISTINCT sub-tasks that require touching different parts of the code. Each sub-task is one self-contained sentence, in the same language as the input, keeping the domain words (page, function, table, endpoint) when present in the text. Ignore rationale, explanations, notes, commit references and authors. If the text describes a single job, return a list with one element. Maximum 8 elements. Answer ONLY with JSON: {"tasks": ["...", "..."]}',
      user: whole.slice(0, 4000),
    });
    const parts = (Array.isArray(json.tasks) ? json.tasks : [])
      .map((x) => String(x).trim())
      .filter((x) => x.length >= 8);
    return parts.length ? parts.slice(0, MAX_PARTS) : [whole];
  } catch (_) {
    return heuristicParts(whole);
  }
}

function heuristicParts(whole) {
  const parts = (text.splitTask(whole) || []).map((x) => String(x).trim()).filter(Boolean);
  return parts.length ? parts.slice(0, MAX_PARTS) : [whole];
}

// Result shaping -----------------------------------------------------------

function uniqueFiles(scored, key, limit = 10) {
  const files = [];
  const seen = new Set();
  for (const x of scored) {
    const f = x.unit && x.unit.file;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    files.push({ file: f, [key]: key === 'p' ? round3(x.p) : x.score });
    if (files.length >= limit) break;
  }
  return files;
}

function shapeUnit(x, withScore) {
  const u = x.unit || {};
  const out = {
    id: u.id,
    file: u.file,
    line: u.start,
    name: u.name,
    p: x.p == null ? null : round3(x.p),
    description: descriptionOf(u).slice(0, DESCRIPTION_IN_RESULT),
  };
  if (withScore && x.score != null) out.score = x.score;
  return out;
}

function keywordPart(map, task, mode, top, candidates, note, extra = {}) {
  const cands = prefilterUnits(map, task, Math.max(top, candidates));
  return {
    task,
    mode,
    jev: false,
    note,
    calls: 0,
    ms: 0,
    tokens: 0,
    cost_usd: 0,
    files: uniqueFiles(cands, 'score'),
    units: cands.slice(0, top).map((x) => shapeUnit(x, true)),
    ...extra,
  };
}

async function findPart(map, task, opts) {
  const { mode, top, candidates, batch, project, jevClient } = opts;
  if (!jevClient) {
    return keywordPart(map, task, mode, top, candidates, 'No Jev API key: keyword order only (set TYPESAFE_API_KEY for probabilities)');
  }
  try {
    if (mode === 'prefilter') {
      const cands = prefilterUnits(map, task, candidates);
      if (!cands.length) {
        return { task, mode, jev: true, note: 'No unit shares a keyword with the task', calls: 0, ms: 0, tokens: 0, cost_usd: 0, files: [], units: [] };
      }
      const r = await rerankWithJev(task, cands, { jevClient, project });
      return {
        task,
        mode,
        jev: true,
        calls: 1,
        ms: r.ms,
        tokens: r.tokens,
        cost_usd: round6(costUsd(r.tokens)),
        confidence: r.confidence,
        none: round3(r.none),
        files: uniqueFiles(r.ordered, 'p'),
        units: r.ordered.slice(0, top).map((x) => shapeUnit(x, true)),
      };
    }
    const r = await scanUnits(map, task, { jevClient, batch, project });
    return {
      task,
      mode: 'scan',
      jev: true,
      calls: r.calls,
      ms: r.ms,
      tokens: r.tokens,
      cost_usd: round6(costUsd(r.tokens)),
      files: uniqueFiles(r.scored, 'p'),
      units: r.scored.slice(0, top).map((x) => shapeUnit(x, false)),
    };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    return keywordPart(map, task, mode, top, candidates, 'Jev failed after one retry: keyword order only', { error: message });
  }
}

/**
 * Main entry. See CONTRACT.md "Finder".
 * options: { mode, split, top, candidates, batch, jev: { apiKey, model, timeoutMs, maxRetry }, llm: { apiKey, model }, project, jevClient }
 */
async function find(map, task, options = {}) {
  const whole = String(task || '').trim();
  if (!whole) throw new Error('find() needs a task');
  if (!map || !Array.isArray(map.units)) throw new Error('find() needs a map with a units array (run `jevmap build` first)');
  const mode = options.mode === 'prefilter' ? 'prefilter' : 'scan';
  const split = ['llm', 'heuristic', 'none'].includes(options.split) ? options.split : 'llm';
  const top = Math.max(1, Number(options.top) || DEFAULT_TOP);
  const candidates = Math.max(1, Number(options.candidates) || DEFAULT_CANDIDATES);
  const batch = Math.max(1, Number(options.batch) || DEFAULT_BATCH);
  const project = options.project || (map && map.project) || '';
  const jevOpts = options.jev || {};

  let jevClient = options.jevClient || null;
  if (!jevClient && jevOpts.apiKey) {
    jevClient = createJevClient({
      apiKey: jevOpts.apiKey,
      model: jevOpts.model || undefined,
      timeoutMs: jevOpts.timeoutMs || undefined,
      maxRetry: jevOpts.maxRetry == null ? undefined : jevOpts.maxRetry,
    });
  }

  const parts = await splitComposite(whole, { split, llm: options.llm || {} });
  const results = await Promise.all(parts.map((p) => findPart(map, p, { mode, top, candidates, batch, project, jevClient })));
  return { task: whole, mode, parts: results };
}

module.exports = {
  find,
  unitLabel,
  prefilterUnits,
  scanUnits,
  rerankWithJev,
  splitComposite,
};
