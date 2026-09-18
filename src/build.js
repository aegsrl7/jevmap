'use strict';

// Build: list the files of a repository, extract their units, merge the
// descriptions file, and write map.json + map.md.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DEFAULT_EXCLUDES, MAX_FILE_BYTES, matchGlob } = require('./config');
const { detectLang } = require('./languages');
const { rulesFor } = require('./languages');
const { extractFile, findRouteTable, areaOf, fileHeader } = require('./extract');

const MAP_VERSION = 1;

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// Files listed by git: tracked plus untracked-not-ignored, relative to root.
// Returns null when git is not available or root is not inside a work tree.
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    const list = out.split('\0').filter(Boolean).map(toPosix);
    return list.filter((rel) => !rel.startsWith('../'));
  } catch (_) {
    return null;
  }
}

// Parse a .gitignore into { pattern, negate } entries (simple subset).
function parseGitignore(text) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/(^|[^\\])#.*$/, '$1').trim();
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    line = line.replace(/\\([# !])/g, '$1');
    if (line) out.push({ pattern: line, negate });
  }
  return out;
}

function ignoredBy(entries, rel, isDir) {
  let ignored = false;
  for (const { pattern, negate } of entries) {
    const dirOnly = pattern.endsWith('/');
    const hit = matchGlob(pattern, rel) || (isDir && matchGlob(pattern, rel + '/_')) || (dirOnly && matchGlob(pattern, rel + '/_'));
    if (hit) ignored = !negate;
  }
  return ignored;
}

function excludedDir(rel, patterns) {
  return patterns.some((p) => matchGlob(p, rel) || matchGlob(p, rel + '/_'));
}

// Walk the tree when git is not available, honouring the root .gitignore.
function walkFiles(root, excludes) {
  const ignorePath = path.join(root, '.gitignore');
  const ignore = fs.existsSync(ignorePath) ? parseGitignore(fs.readFileSync(ignorePath, 'utf8')) : [];
  const out = [];
  const visit = (dirRel) => {
    const abs = dirRel ? path.join(root, dirRel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (excludedDir(rel, excludes) || ignoredBy(ignore, rel, true)) continue;
        visit(rel);
      } else if (e.isFile()) {
        if (ignoredBy(ignore, rel, false)) continue;
        out.push(rel);
      }
    }
  };
  visit('');
  return out;
}

function explicitlyIncluded(rel, include) {
  return include.some((p) => matchGlob(p, rel) && !/(^|\/)\*\*?$/.test(p));
}

// Relative paths of the files to scan, sorted.
function listFiles(root, config) {
  const absRoot = path.resolve(root || (config && config.root) || '.');
  const cfg = config || {};
  const include = cfg.include || [];
  const excludes = [...DEFAULT_EXCLUDES, ...(cfg.exclude || [])];
  if (cfg.out && !path.isAbsolute(cfg.out)) excludes.push(toPosix(cfg.out).replace(/\/+$/, ''));
  let candidates = gitFiles(absRoot);
  if (!candidates) candidates = walkFiles(absRoot, excludes);
  const out = [];
  const seen = new Set();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (excludes.some((p) => matchGlob(p, rel))) continue;
    if (include.length && !include.some((p) => matchGlob(p, rel))) continue;
    if (!detectLang(rel) && !explicitlyIncluded(rel, include)) continue;
    let st;
    try { st = fs.statSync(path.join(absRoot, rel)); } catch (_) { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    out.push(rel);
  }
  return out.sort();
}

// Descriptions written by hand or by `jevmap describe`: key = unit id, with the
// older "file::name" key accepted for compatibility.
function loadDescriptions(root, config) {
  if (!config || !config.descriptions) return {};
  const file = path.resolve(root, config.descriptions);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

// Minified or bundled files (workers, vendored builds) are not source code: a
// regex extractor would turn one of them into hundreds of one-letter "units".
// Heuristic: any line longer than 2000 chars, or an average line longer than 300.
function looksMinified(text) {
  if (!text) return false;
  const lines = text.split('\n');
  let total = 0;
  for (const l of lines) {
    if (l.length > 2000) return true;
    total += l.length;
  }
  return lines.length > 0 && total / lines.length > 300;
}

function build(root, config, { log } = {}) {
  const absRoot = path.resolve(root || (config && config.root) || '.');
  const cfg = config || {};
  const say = typeof log === 'function' ? log : () => {};
  const rels = listFiles(absRoot, cfg);
  const texts = new Map();
  const minified = [];
  for (const rel of rels) {
    let text;
    try { text = fs.readFileSync(path.join(absRoot, rel), 'utf8'); } catch (_) { continue; /* unreadable: skipped */ }
    if (looksMinified(text)) { minified.push(rel); continue; }
    texts.set(rel, text);
  }
  if (minified.length) say(`Skipped ${minified.length} minified file(s): ${minified.slice(0, 3).join(', ')}${minified.length > 3 ? ', ...' : ''}`);
  const routeTable = findRouteTable(texts);
  const descriptions = loadDescriptions(absRoot, cfg);
  const files = {};
  const units = [];
  for (const rel of rels) {
    const text = texts.get(rel);
    if (text == null) continue;
    const lang = detectLang(rel);
    const lines = text.split(/\r?\n/);
    const fileUnits = extractFile(rel, text, lang, cfg, routeTable);
    for (const u of fileUnits) {
      const d = descriptions[u.id] || descriptions[`${u.file}::${u.name}`];
      if (typeof d === 'string' && d.trim()) u.description = d.trim();
      else if (!u.description) u.description = u.comment || '';
      units.push(u);
    }
    files[rel] = {
      lines: lines.length,
      lang,
      area: areaOf(rel, cfg),
      header: fileHeader(lines, rulesFor(lang)),
      n_units: fileUnits.length,
    };
  }
  const map = {
    version: MAP_VERSION,
    generated: new Date().toISOString(),
    root: absRoot,
    project: cfg.project || '',
    n_files: Object.keys(files).length,
    n_units: units.length,
    files,
    units,
  };
  const counts = {};
  for (const u of units) counts[u.type] = (counts[u.type] || 0) + 1;
  const missing = units.filter((u) => !u.description).length;
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ');
  say(`${map.n_files} files, ${map.n_units} units (${summary}); without description: ${missing}`);
  return map;
}

function extraSummary(u) {
  const e = u.extra || {};
  const parts = [];
  if (e.tables && e.tables.length) parts.push('tables: ' + e.tables.slice(0, 8).join(', '));
  if (e.emits && e.emits.length) parts.push('socket: ' + e.emits.slice(0, 8).join(', '));
  if (e.calls && e.calls.length) parts.push('api: ' + e.calls.slice(0, 8).join(', '));
  if (e.route) parts.push('route: ' + e.route);
  if (e.middleware && e.middleware.length) parts.push('auth: ' + e.middleware.join(', '));
  if (e.parent) parts.push('in: ' + e.parent);
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

// Human-readable index: one section per area, one subsection per file, one
// bullet per unit. Regenerated by `jevmap build`, never edited by hand.
function renderMarkdown(map) {
  const lines = [];
  lines.push('# Codebase map');
  if (map.project) lines.push(`Project: ${map.project}`);
  lines.push(`Generated ${map.generated} by jevmap: ${map.n_files} files, ${map.n_units} units. Do not edit by hand: run \`jevmap build\` again.`);
  lines.push('');
  const byArea = {};
  for (const u of map.units || []) {
    if (!byArea[u.area]) byArea[u.area] = {};
    if (!byArea[u.area][u.file]) byArea[u.area][u.file] = [];
    byArea[u.area][u.file].push(u);
  }
  for (const area of Object.keys(byArea).sort()) {
    lines.push('');
    lines.push(`## Area: ${area}`);
    for (const file of Object.keys(byArea[area]).sort()) {
      const info = (map.files && map.files[file]) || {};
      const header = info.header ? ` - ${info.header.slice(0, 160)}` : '';
      lines.push('');
      lines.push(`### ${file} (${info.lines || 0} lines)${header}`);
      for (const u of byArea[area][file]) {
        const desc = (u.description || '').slice(0, 200) || '(no description)';
        lines.push(`- \`${u.start}-${u.end}\` **${u.name}** - ${desc}${extraSummary(u)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function resolveOut(outDir, base) {
  const dir = outDir || '.jevmap';
  return path.isAbsolute(dir) ? dir : path.resolve(base || process.cwd(), dir);
}

function writeMap(map, outDir) {
  const dir = resolveOut(outDir, map && map.root);
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'map.json');
  const mdPath = path.join(dir, 'map.md');
  fs.writeFileSync(jsonPath, JSON.stringify(map, null, 1) + '\n', 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(map), 'utf8');
  return { jsonPath, mdPath };
}

function loadMap(outDir) {
  const file = path.join(resolveOut(outDir), 'map.json');
  if (!fs.existsSync(file)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    return map && Array.isArray(map.units) ? map : null;
  } catch (_) {
    return null;
  }
}

module.exports = { listFiles, build, renderMarkdown, writeMap, loadMap, loadDescriptions, parseGitignore, looksMinified, MAP_VERSION };
