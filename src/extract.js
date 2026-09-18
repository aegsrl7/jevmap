'use strict';

// Extractor: turns one source file into units (functions, methods, classes,
// endpoints, components, pages, jobs) by reading the text with the per-language
// rules of src/languages.js. No AI, no parser: line-based regexes, brace or
// indentation matching for the block end, and the comment right above (or the
// docstring right below for Python) as the description.

const { rulesFor } = require('./languages');

const MAX_BLOCK = 400;
const COMMENT_MAX = 240;
const MAX_DECORATOR_DISTANCE = 8;

const RX_TABLES = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE\s+IF\s+NOT\s+EXISTS|TABLE)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)\b/gi;
const SQL_STOP = new Set(('sui select where and or set values on as if not exists dual information_schema the a an this that ' +
  'table tables only each all it with to your our my clause statement of in into from join update delete insert then ' +
  'when which what here there another any some these those its also above below be is by for one two view index ' +
  'function procedure trigger type schema database temp temporary').split(/\s+/));

const RX_EMITS = /\b(?:io|socket|sockets|ws)(?:\.(?:to|in|of|broadcast|volatile|local|except)(?:\([^()]*\))?)*\.emit\(\s*['"`]([^'"`]+)['"`]/g;
const RX_CALLS = /\b(?:fetch|(?:axios|api|http|client|request|apiClient|axiosInstance|instance|\$http|ky|got)\.(?:get|post|put|delete|patch|head|request))\(\s*(['"`])([^'"`\n]*)\1/g;
const RX_REQUIRE = /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const RX_IMPORT_FROM = /\bimport\s+(?:[^'";]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
const RX_IMPORT_DYN = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const RX_JSX = /<[A-Z][\w.]*[\s/>]|<>|return\s*\(\s*$|return\s*\(\s*</m;
const RX_REACT_CLASS = /extends\s+(?:React\.)?(?:Pure)?Component\b/;
const RX_DECORATION = /^[\s=\-*#/~_+|:.]*$/;
const RX_TAG_LINE = /^(@\w|eslint-|prettier-|noqa|type:\s|pylint:|istanbul\s|ts-ignore|ts-expect-error|@ts-)/;
const RX_BRACKET_LINE = /^[{}()[\];,]*$|^end[;.]?$/;

function leadingWs(line) {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

function uniqSorted(list) {
  return Array.from(new Set(list)).sort();
}

function all(re, text, group = 1) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
  return out;
}

// ----------------------------------------------------------------- comments

function isDecoration(s) {
  return RX_DECORATION.test(s);
}

function stripLinePrefix(t, prefix) {
  return t.slice(prefix.length).replace(/^[/#!\-]*/, '').trim();
}

function stripBlockLine(t, open, close, first, last) {
  let s = t.trim();
  if (first && s.startsWith(open)) s = s.slice(open.length);
  if (last && s.endsWith(close)) s = s.slice(0, s.length - close.length);
  s = s.replace(/^\*+\s?/, '').replace(/^!+\s?/, '');
  if (s.trim().endsWith(close)) s = s.trim().slice(0, -close.length);
  return s.trim();
}

function joinComment(parts) {
  const kept = parts.map((x) => x.trim()).filter((x) => x && !isDecoration(x) && !RX_TAG_LINE.test(x));
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, COMMENT_MAX);
}

function isCommentLine(t, rules) {
  return rules.comment.line.some((p) => t.startsWith(p));
}

// Lines of a block comment that ends at line j (inclusive), or null.
function blockEndingAt(lines, j, open, close) {
  const t = lines[j].trim();
  if (!t.endsWith(close)) return null;
  const singleLine = t.startsWith(open) && t.length >= open.length + close.length && (open !== close || t.length > open.length);
  let k = j;
  if (!singleLine) {
    k = j - 1;
    while (k >= 0 && j - k < 60 && !lines[k].trim().startsWith(open)) k--;
    if (k < 0 || j - k >= 60) return null;
  }
  const out = [];
  for (let x = k; x <= j; x++) out.push(stripBlockLine(lines[x], open, close, x === k, x === j));
  return out;
}

// Comment block immediately above line i (0-based): consecutive line comments,
// or a block comment whose closing line is right above. Decorator lines are skipped.
function commentAbove(lines, i, rules) {
  let j = i - 1;
  if (rules.decorator) while (j >= 0 && rules.decorator.test(lines[j])) j--;
  const out = [];
  while (j >= 0) {
    const t = lines[j].trim();
    const p = rules.comment.line.find((x) => t.startsWith(x));
    if (!p || t.startsWith('#!')) break;
    out.unshift(stripLinePrefix(t, p));
    j--;
  }
  if (out.length) return joinComment(out);
  if (j < 0) return '';
  for (const [open, close] of rules.comment.block) {
    const block = blockEndingAt(lines, j, open, close);
    if (block) return joinComment(block);
  }
  return '';
}

// Python docstring right below the signature that starts at line i.
function docstringBelow(lines, i, rules) {
  let j = i;
  const limit = Math.min(lines.length - 1, i + 12);
  while (j <= limit && !/:\s*(#.*)?$/.test(lines[j])) j++;
  if (j > limit) return '';
  j++;
  while (j <= limit && !lines[j].trim()) j++;
  if (j > limit) return '';
  const t = lines[j].trim();
  for (const [open, close] of rules.comment.block) {
    if (!t.startsWith(open)) continue;
    const rest = t.slice(open.length);
    if (rest.endsWith(close) && rest.length >= close.length) {
      return joinComment([rest.slice(0, rest.length - close.length)]);
    }
    const parts = [rest];
    for (let k = j + 1; k <= Math.min(lines.length - 1, j + 30); k++) {
      const s = lines[k].trim();
      if (s.endsWith(close)) { parts.push(s.slice(0, s.length - close.length)); break; }
      parts.push(s);
    }
    return joinComment(parts);
  }
  return '';
}

function commentFor(lines, i, rules) {
  if (rules.docstringBelow) {
    const doc = docstringBelow(lines, i, rules);
    if (doc) return doc;
  }
  return commentAbove(lines, i, rules);
}

// Header comment of a file: the comment block at the very top (after a shebang).
function fileHeader(lines, rules) {
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || lines[i].startsWith('#!'))) i++;
  if (i >= lines.length) return '';
  const t = lines[i].trim();
  const p = rules.comment.line.find((x) => t.startsWith(x));
  if (p) {
    const out = [];
    while (i < lines.length) {
      const s = lines[i].trim();
      const q = rules.comment.line.find((x) => s.startsWith(x));
      if (!q) break;
      out.push(stripLinePrefix(s, q));
      i++;
    }
    return joinComment(out);
  }
  for (const [open, close] of rules.comment.block) {
    if (!t.startsWith(open)) continue;
    let j = i;
    const singleLine = t.length > open.length && t.endsWith(close) && t.length >= open.length + close.length;
    if (!singleLine) {
      j = i + 1;
      while (j < lines.length && j - i < 60 && !lines[j].trim().endsWith(close)) j++;
      if (j >= lines.length || j - i >= 60) return '';
    }
    const block = [];
    for (let x = i; x <= j; x++) block.push(stripBlockLine(lines[x], open, close, x === i, x === j));
    return joinComment(block);
  }
  return '';
}

// ----------------------------------------------------------------- block end

function stripLiterals(line, hashComments) {
  let s = line
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, '""')
    .replace(/\/\/.*$/, '');
  if (hashComments) s = s.replace(/#.*$/, '');
  return s;
}

function nextNonBlank(lines, from) {
  for (let j = from; j < lines.length; j++) if (lines[j].trim()) return j;
  return -1;
}

// Last line of the block that starts at line i, by indentation: everything more
// indented than the start line belongs to it.
function indentEnd(lines, i, indent) {
  let last = i;
  const limit = Math.min(lines.length - 1, i + MAX_BLOCK);
  for (let j = i + 1; j <= limit; j++) {
    if (!lines[j].trim()) continue;
    if (leadingWs(lines[j]) <= indent) break;
    last = j;
  }
  return last;
}

const RX_CONTINUES = /(=>|[=(,.+\-*/&|?:]|&&|\|\|)\s*$/;

function braceEnd(lines, i, indent, hashComments) {
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length - 1, i + MAX_BLOCK);
  for (let j = i; j <= limit; j++) {
    const s = stripLiterals(lines[j], hashComments);
    for (const ch of s) {
      if (ch === '{' || ch === '(' || ch === '[') { depth++; opened = true; } else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    if (opened && depth <= 0) {
      if (RX_CONTINUES.test(s.trim())) continue;
      const nb = nextNonBlank(lines, j + 1);
      if (nb >= 0 && j === i && /^\s*\{/.test(lines[nb])) continue;
      return j;
    }
    if (!opened && j > i && lines[j].trim() && !/^\s*\{/.test(lines[j])) return i;
  }
  return indentEnd(lines, i, indent);
}

function endKeywordEnd(lines, i, indent) {
  const t = lines[i].trim();
  if (/\bend\s*$/.test(t) || /^def\s+[\w?!=.]+\s*=/.test(t)) return i;
  const limit = Math.min(lines.length - 1, i + MAX_BLOCK);
  for (let j = i + 1; j <= limit; j++) {
    if (!lines[j].trim()) continue;
    const ind = leadingWs(lines[j]);
    if (ind === indent && /^\s*end\b/.test(lines[j])) return j;
    if (ind < indent) return j - 1;
  }
  return indentEnd(lines, i, indent);
}

function semicolonEnd(lines, i) {
  const limit = Math.min(lines.length - 1, i + MAX_BLOCK);
  for (let j = i; j <= limit; j++) if (stripLiterals(lines[j], false).replace(/--.*$/, '').includes(';')) return j;
  return Math.min(lines.length - 1, i + MAX_BLOCK);
}

function blockEnd(lines, i, indent, rules) {
  switch (rules.block) {
    case 'indent': return indentEnd(lines, i, indent);
    case 'end': return endKeywordEnd(lines, i, indent);
    case 'semicolon': return semicolonEnd(lines, i);
    default: return braceEnd(lines, i, indent, rules.comment.line.includes('#'));
  }
}

// Indentation of the direct members of a container that starts at line i.
function memberIndent(lines, i, end, indent) {
  for (let j = i + 1; j <= end; j++) {
    const t = lines[j].trim();
    if (!t || t === '{') continue;
    const ind = leadingWs(lines[j]);
    if (ind > indent) return ind;
  }
  return indent + 1;
}

// ----------------------------------------------------------------- extras

function tablesIn(body, rules) {
  const text = rules.imports || rules.docstringBelow ? body.replace(/^\s*(?:import|from)\s.*$/gm, '') : body;
  const out = [];
  for (const t of all(RX_TABLES, text)) {
    const l = t.toLowerCase();
    if (l.length > 2 && !SQL_STOP.has(l)) out.push(l);
  }
  return uniqSorted(out);
}

function callsIn(body) {
  const out = [];
  RX_CALLS.lastIndex = 0;
  let m;
  while ((m = RX_CALLS.exec(body)) !== null) {
    let url = m[2].trim();
    while (/^\$\{[^}]*\}/.test(url)) url = url.replace(/^\$\{[^}]*\}/, '');
    if (url.startsWith('/')) out.push(url);
  }
  return uniqSorted(out);
}

function importsIn(body) {
  return uniqSorted([...all(RX_REQUIRE, body), ...all(RX_IMPORT_FROM, body), ...all(RX_IMPORT_DYN, body)]);
}

function emitsIn(body) {
  return uniqSorted(all(RX_EMITS, body));
}

// Middleware names on an Express route line: identifiers (or calls) between the
// path and the handler. A trailing identifier with no inline handler is the handler.
function parseMiddleware(rest) {
  let s = String(rest || '').replace(/^\s*,/, '');
  const parts = [];
  let depth = 0;
  let cur = '';
  let closed = false;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { closed = true; break; }
      depth--;
    }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const out = [];
  let handlerSeen = false;
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    if (/^(async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(p) || p.includes('=>')) { handlerSeen = true; break; }
    if (/^[A-Za-z_$][\w$.]*(\(.*\))?$/.test(p)) out.push(p);
    else break;
  }
  if (!handlerSeen && closed && out.length && !/\(.*\)$/.test(out[out.length - 1])) out.pop();
  return out;
}

function joinPath(prefix, p) {
  let a = String(prefix || '').replace(/\/+$/, '');
  let b = String(p || '');
  if (a && !a.startsWith('/')) a = '/' + a;
  if (!a) return b || '/';
  if (!b || b === '/') return a || '/';
  if (!b.startsWith('/')) b = '/' + b;
  return a + b;
}

function bodyExtras(body, rules, unit) {
  const extra = unit.extra || {};
  if (rules.sql) {
    const tables = tablesIn(body, rules);
    if (tables.length) extra.tables = tables;
  }
  if (rules.imports) {
    const emits = emitsIn(body);
    if (emits.length) extra.emits = emits;
    const calls = callsIn(body);
    if (calls.length) extra.calls = calls;
    const imports = importsIn(body);
    if (imports.length) extra.imports = imports;
  }
  return extra;
}

// ----------------------------------------------------------------- areas

const areaCache = new Map();

function areaRegex(src) {
  let re = areaCache.get(src);
  if (!re) {
    try { re = new RegExp(src, 'i'); } catch (_) { re = null; }
    areaCache.set(src, re);
  }
  return re;
}

// Functional area of a file: config.areas ([regex, name] pairs) tested on the
// basename first, then on the full path; default = first directory segment.
function areaOf(relPath, config = {}) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  const base = rel.split('/').pop();
  const areas = (config && config.areas) || [];
  for (const [src, name] of areas) {
    const re = areaRegex(src);
    if (re && re.test(base)) return name;
  }
  for (const [src, name] of areas) {
    const re = areaRegex(src);
    if (re && re.test(rel)) return name;
  }
  const idx = rel.indexOf('/');
  return idx > 0 ? rel.slice(0, idx) : 'root';
}

// ----------------------------------------------------------------- route table

const RX_ROUTE_TAG = /<Route\b/g;
const RX_ROUTE_OBJ = /\{[^{}]*?\bpath\s*:\s*['"`]([^'"`]+)['"`][^{}]*?\b(?:element\s*:\s*<(\w+)|(?:component|Component)\s*:\s*(\w+))/g;
const RX_ROUTE_OBJ_REV = /\{[^{}]*?\b(?:element\s*:\s*<(\w+)[^{}]*?|(?:component|Component)\s*:\s*(\w+)[^{}]*?)\bpath\s*:\s*['"`]([^'"`]+)['"`]/g;

function routeTagAttrs(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth <= 0) return text.slice(from, i);
  }
  return text.slice(from, Math.min(text.length, from + 500));
}

// React Router table: component name -> route path, from every file text.
// Handles <Route path="/x" component={X} />, <Route path="/x" element={<X />} />
// and route objects { path: '/x', element: <X /> }.
function findRouteTable(filesText) {
  const table = {};
  const entries = filesText instanceof Map ? filesText.entries() : Object.entries(filesText || {});
  for (const [, text] of entries) {
    if (typeof text !== 'string' || !/<Route\b|\bpath\s*:/.test(text)) continue;
    RX_ROUTE_TAG.lastIndex = 0;
    let m;
    while ((m = RX_ROUTE_TAG.exec(text)) !== null) {
      const attrs = routeTagAttrs(text, m.index + m[0].length);
      const p = /\bpath=(?:["']([^"']+)["']|\{\s*["'`]([^"'`]+)["'`]\s*\})/.exec(attrs);
      if (!p) continue;
      const routePath = p[1] || p[2];
      const c = /\bcomponent=\{\s*(\w+)\s*\}/.exec(attrs) || /\belement=\{\s*<(\w+)/.exec(attrs) || /\brender=\{[^<]*<(\w+)/.exec(attrs);
      if (c && c[1] && !(c[1] in table)) table[c[1]] = routePath;
    }
    for (const re of [RX_ROUTE_OBJ, RX_ROUTE_OBJ_REV]) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const name = re === RX_ROUTE_OBJ ? (m[2] || m[3]) : (m[1] || m[2]);
        const routePath = re === RX_ROUTE_OBJ ? m[1] : m[3];
        if (name && routePath && !(name in table)) table[name] = routePath;
      }
    }
  }
  return table;
}

// ----------------------------------------------------------------- main

function makeUnit(relPath, lang, type, name, start, end, comment, area, extra) {
  const unit = {
    id: `${relPath}:${start + 1} ${name}`,
    file: relPath,
    lang,
    type,
    name,
    start: start + 1,
    end: end + 1,
    comment: comment || '',
    description: comment || '',
    area,
    extra: extra || {},
  };
  return unit;
}

function ruleMethod(rule, m) {
  if (typeof rule.method === 'function') return rule.method(m);
  if (typeof rule.method === 'string') return rule.method;
  if (rule.methodGroup) return (m[rule.methodGroup] || 'ANY').toUpperCase();
  return null;
}

function rulePath(rule, m) {
  if (rule.pathGroup == null) return null;
  const v = m[rule.pathGroup];
  return v == null ? null : v;
}

function ruleName(rule, m) {
  if (typeof rule.name === 'function') return rule.name(m);
  if (typeof rule.name === 'string') return rule.name;
  return m[rule.nameGroup];
}

function extractFile(relPath, text, lang, config = {}, routeTable = {}) {
  const rules = rulesFor(lang);
  const rel = String(relPath).replace(/\\/g, '/');
  const lines = String(text || '').split(/\r?\n/);
  const area = areaOf(rel, config);
  const units = [];
  const containers = [];
  let pending = null;
  let prefix = '';
  let lastTopEnd = -1;

  const top = () => containers[containers.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = leadingWs(line);
    while (containers.length && (i > top().end || (indent <= top().indent && i > top().start && !RX_BRACKET_LINE.test(trimmed)))) {
      containers.pop();
      if (!containers.length) prefix = '';
    }
    if (pending && i - pending.line > MAX_DECORATOR_DISTANCE) pending = null;

    let matched = false;
    for (const rule of rules.patterns) {
      const m = rule.regex.exec(line);
      if (!m) continue;

      if (rule.kind === 'prefix') {
        prefix = rulePath(rule, m) || '';
        matched = true;
        break;
      }

      if (rule.kind === 'decorator') {
        const method = ruleMethod(rule, m);
        const p = rulePath(rule, m);
        pending = Object.assign({}, pending || {}, { line: i });
        if (rule.job) pending.job = true;
        if (method) pending.method = method;
        if (p != null) pending.path = p;
        matched = true;
        break;
      }

      if (rule.kind === 'job') {
        const end = blockEnd(lines, i, indent, rules);
        const unit = makeUnit(rel, lang, 'job', ruleName(rule, m), i, end, commentAbove(lines, i, rules), area, {});
        unit.extra = bodyExtras(lines.slice(i, end + 1).join('\n'), rules, unit);
        units.push(unit);
        matched = true;
        break;
      }

      if (rule.kind === 'route') {
        const method = ruleMethod(rule, m) || 'ANY';
        const p = rulePath(rule, m) || '/';
        const end = blockEnd(lines, i, indent, rules);
        const name = typeof rule.name === 'function' ? rule.name(m) : `${method} ${p}`;
        const extra = { method, path: p };
        if (rule.restGroup != null) {
          const mw = parseMiddleware(m[rule.restGroup]);
          if (mw.length) extra.middleware = mw;
        }
        if (rule.handlerGroup != null && m[rule.handlerGroup]) extra.handler = m[rule.handlerGroup];
        const unit = makeUnit(rel, lang, 'endpoint', name, i, end, commentAbove(lines, i, rules), area, extra);
        unit.extra = bodyExtras(lines.slice(i, end + 1).join('\n'), rules, unit);
        units.push(unit);
        matched = true;
        break;
      }

      // kind === 'def'
      const c = top();
      let member = false;
      if (c && i > c.start && i <= c.end && indent > c.indent) {
        if (indent !== c.memberIndent) continue;
        member = true;
      } else {
        if (rule.insideOnly) continue;
        if (indent > rules.maxIndent) continue;
        if (indent > 0 && i <= lastTopEnd) continue;
      }
      if (rule.notNames && rule.notNames.includes(m[rule.nameGroup])) continue;

      const defName = ruleName(rule, m);
      if (!defName) continue;
      const end = blockEnd(lines, i, indent, rules);

      if (rule.unit === false) {
        containers.push({ name: defName, indent, start: i, end, memberIndent: memberIndent(lines, i, end, indent) });
        matched = true;
        break;
      }

      let type = rule.type;
      if (member && type === 'function') type = 'method';
      const extra = {};
      if (member && c) extra.parent = c.name;
      if (rule.parentGroup && m[rule.parentGroup]) extra.parent = m[rule.parentGroup];
      const kind = typeof rule.extraKind === 'function' ? rule.extraKind(m) : rule.extraKind;
      if (kind) extra.kind = kind;

      let name = defName;
      if (pending) {
        if (rule.container) {
          if (pending.path != null) prefix = pending.path;
        } else if (pending.job) {
          type = 'job';
        } else if (pending.method || pending.path != null) {
          type = 'endpoint';
          const method = pending.method || 'ANY';
          const p = joinPath(prefix, pending.path == null ? '' : pending.path);
          name = `${method} ${p}`;
          extra.method = method;
          extra.path = p;
          extra.handler = defName;
        }
        pending = null;
      }

      const body = lines.slice(i, end + 1).join('\n');
      if (rules.jsx && type !== 'endpoint' && type !== 'job' && /^[A-Z]/.test(defName)) {
        const isComponent = (type === 'function' && RX_JSX.test(body)) || (type === 'class' && RX_REACT_CLASS.test(line));
        if (isComponent) {
          type = routeTable && routeTable[defName] ? 'page' : 'component';
          if (type === 'page') extra.route = routeTable[defName];
        }
      }

      const unit = makeUnit(rel, lang, type, name, i, end, commentFor(lines, i, rules), area, extra);
      unit.extra = bodyExtras(body, rules, unit);
      units.push(unit);
      if (rule.container) {
        containers.push({ name: defName, indent, start: i, end, memberIndent: memberIndent(lines, i, end, indent) });
      } else if (!member && end > lastTopEnd) {
        lastTopEnd = end;
      }
      if (rule.container && !member && end > lastTopEnd) lastTopEnd = end;
      matched = true;
      break;
    }

    if (!matched && pending) {
      const isDecorator = rules.decorator && rules.decorator.test(line);
      if (!isDecorator && !isCommentLine(trimmed, rules)) pending = null;
    }
  }

  if (!units.length) {
    const base = rel.split('/').pop();
    const unit = makeUnit(rel, lang, 'file', base, 0, Math.max(0, lines.length - 1), fileHeader(lines, rules), area, {});
    unit.extra = bodyExtras(lines.join('\n'), rules, unit);
    units.push(unit);
  }
  return units;
}

module.exports = {
  extractFile,
  findRouteTable,
  areaOf,
  fileHeader,
  commentAbove,
  parseMiddleware,
  tablesIn,
  callsIn,
  importsIn,
  emitsIn,
  blockEnd,
};
