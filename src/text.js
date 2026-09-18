'use strict';

// Text utilities: tokenizer, light stemmer (English + Italian), searchable text of
// a unit, keyword scoring for the prefilter, and the heuristic task splitter.

const STOP_EN = 'the a an of to and or in on for with from by at as is are be been was were this that these those it its into not but if then than so we you they our your their all any each when where how what which who also should must can could would will add remove create make put new fix change show use using via only just some more less very please need needs want does did done do has have had may might per about after before over under out up down off yes no'.split(' ');

const STOP_IT = 'il lo la i gli le un uno una di a da in con su per tra fra e o che non del della dei delle degli dello al alla ai alle agli allo dal dalla dai dalle nel nella nei nelle sul sulla sui sulle come piu meno anche gia poi quando dove cosa fai fa fare metti mettere aggiungi aggiungere togli togliere crea creare nuovo nuova nuovi nuove questo questa quello quella questi queste se ma perche cosi ora adesso ogni tutto tutti tutte tutta sia essere sono era stato stata stati state viene vengono deve devono puo possono vorrei voglio bisogna serve servono'.split(' ');

const STOP_WORDS = new Set([...STOP_EN, ...STOP_IT]);

function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Lowercase ASCII-folded tokens longer than 2 characters, camelCase split, stop
// words removed. `/api/emails` becomes ["api", "emails"].
function tokenize(text) {
  const folded = fold(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const out = [];
  for (const w of folded.split(' ')) {
    if (w.length > 2 && !STOP_WORDS.has(w)) out.push(w);
  }
  return out;
}

function stripSuffix(word, re, replacement = '') {
  const m = re.exec(word);
  if (!m) return word;
  const out = word.slice(0, m.index) + replacement;
  return out.length >= 3 ? out : word;
}

// Light stemmer: English plural/verb endings, then the final Italian vowel
// (plural and gender), then common Italian and English derivational suffixes.
// Each step keeps at least 3 characters and the passes repeat until the word
// stops changing, so stem(stem(w)) === stem(w). It is deliberately rough: the
// goal is that "cliente"/"clienti", "emails"/"email", "created"/"create" collapse.
function stem(word) {
  let s = String(word || '').toLowerCase();
  for (let i = 0; i < 4; i++) {
    const next = stemOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

function stemOnce(word) {
  let s = word;
  if (s.length <= 3) return s;
  s = stripSuffix(s, /ies$/, 'y');
  if (!/(ss|us|is)$/.test(s)) {
    let t = stripSuffix(s, /ers$/);
    if (t === s) t = stripSuffix(s, /es$/);
    if (t === s) t = stripSuffix(s, /s$/);
    s = t;
  }
  s = stripSuffix(s, /(ing|ed|tion)$/);
  s = stripSuffix(s, /[aeio]$/);
  s = stripSuffix(s, /(azion|ament|atur|ion|ent|at|ut|it|al|ar|er|ir)$/);
  return s;
}

function stemAll(tokens) {
  return tokens.map(stem);
}

function listOf(v) {
  return Array.isArray(v) ? v.join(' ') : (v || '');
}

// Everything worth searching in a unit, joined by spaces.
function unitText(unit) {
  if (!unit) return '';
  const extra = unit.extra || {};
  return [
    unit.id, unit.name, unit.file, unit.description, unit.comment,
    extra.path, listOf(extra.tables), listOf(extra.calls), extra.route, listOf(extra.emits),
    unit.area,
  ].filter(Boolean).join(' ');
}

// Text that counts as the "name" of a unit for the +0.5 bonus: name, route path,
// page route, file path.
function unitNameText(unit) {
  const extra = (unit && unit.extra) || {};
  return [unit.name, unit.file, extra.path, extra.route].filter(Boolean).join(' ');
}

// Keyword score against the query tokens (output of tokenize(task)).
// With a unit object: +1 for every stemmed query token found in the unit text,
// +0.5 more when the token is also in the unit name, route path or file path.
// With a plain string: +1 per stemmed query token found in that text (callers
// that pass unitText/unitNameText themselves add the bonus on their side).
// 0 when nothing is in common.
function keywordScore(unitOrText, queryTokens) {
  const q = new Set(stemAll(queryTokens || []));
  if (!q.size) return 0;
  let s = 0;
  if (typeof unitOrText === 'string') {
    const t = new Set(stemAll(tokenize(unitOrText)));
    for (const w of q) if (t.has(w)) s += 1;
    return s;
  }
  const t = new Set(stemAll(tokenize(unitText(unitOrText))));
  const n = new Set(stemAll(tokenize(unitNameText(unitOrText))));
  for (const w of q) {
    if (t.has(w)) s += 1;
    if (n.has(w)) s += 0.5;
  }
  return s;
}

// Does the task text look like it holds more than one task? Newlines, semicolons,
// bullets, commas separating multi-word parts, or more than 14 words.
function looksComposite(text) {
  const t = String(text || '');
  if (/[\n;\u2022]|,\s*\w+\s+\w+/.test(t)) return true;
  return t.trim().split(/\s+/).filter(Boolean).length > 14;
}

const CONNECTORS = /\s+e\s+poi\s+|\s+poi\s+|\s+inoltre\s+|\s+and\s+then\s+|\s+then\s+|\s+also\s+|\s+plus\s+/i;
const SEPARATORS = /\n+|\s*[;\u2022]\s*|(?:^|\s)[-*]\s+|\s+\d+[.)]\s+|\s+\+\s+/;

// Split a task into its parts without AI: lines, bullets, numbering, semicolons,
// " + ", the connectors ("and then", "then", "also", "plus", "e poi", "poi",
// "inoltre") and commas when every piece has at least two words.
// Returns [task] when nothing splits.
function splitTask(text) {
  const original = String(text || '').trim();
  let t = original.replace(/^\s*(feat|fix|chore|refactor|docs|style|perf|test|build|ci)(\([^)]*\))?!?:\s*/i, '');
  t = t.replace(/\b(BE|FE|Backend|Frontend|Fix|Refactor)\s*:/g, '\n');
  let parts = t.split(SEPARATORS).filter((x) => x != null).flatMap((x) => x.split(CONNECTORS));
  parts = parts.flatMap((x) => {
    const pieces = x.split(/\s*,\s*/);
    return pieces.length > 1 && pieces.every((y) => y.trim().split(/\s+/).filter(Boolean).length >= 2) ? pieces : [x];
  });
  parts = parts
    .map((x) => x.replace(/^[\s:,;\-\u2013\u2014]+|[\s.:,;]+$/g, ''))
    .filter((x) => x.length >= 8 && tokenize(x).length >= 1);
  const seen = new Set();
  parts = parts.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return parts.length > 1 ? parts.slice(0, 8) : [original];
}

module.exports = { tokenize, stem, stemAll, unitText, unitNameText, keywordScore, looksComposite, splitTask, STOP_WORDS };
