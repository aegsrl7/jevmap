'use strict';

// Per-language extraction rules, data-driven. src/extract.js walks the lines of a
// file and applies `patterns` in order; the first matching pattern wins for a line.
//
// Pattern kinds:
//   def        a definition: { regex, type, nameGroup | name(m), container?, insideOnly?, parentGroup?, kind? }
//              type is 'function' | 'class'; a 'function' found at the member level of
//              a container becomes a 'method'. `container: true` makes the unit a scope
//              whose direct members become methods (classes, Rust impl blocks).
//              `insideOnly: true` matches only at the member level of a container
//              (method syntax without a keyword, e.g. `name(...) {` in a JS class).
//              `unit: false` opens a scope without producing a unit (namespaces, mods).
//   route      an explicit route line: { regex, methodGroup | method, pathGroup, restGroup? }
//   decorator  an annotation above a definition: { regex, methodGroup | method, pathGroup, job? }
//              consecutive decorators merge; the next def becomes an 'endpoint' (or a 'job').
//              When the next def is a container the path becomes a prefix for its members.
//   prefix     a class-level route prefix: { regex, pathGroup }
//   job        a scheduled job anywhere in the file: { regex, name(m) }
//
// Other fields: comment { line: [...prefixes], block: [[open, close], ...] },
// decorator (RegExp for lines to skip when looking for the comment above),
// docstringBelow, block ('brace' | 'indent' | 'end' | 'semicolon'), maxIndent
// (top-level tolerance in characters), jsx, imports, sql.

const EXT_TO_LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  py: 'py', pyw: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp',
  swift: 'swift',
  rb: 'ruby', rake: 'ruby',
  php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  sql: 'sql',
};

const LANGS = ['js', 'ts', 'py', 'go', 'rs', 'java', 'kotlin', 'csharp', 'swift', 'ruby', 'php', 'sh', 'sql'];

function detectLang(relPath) {
  const base = String(relPath || '').replace(/\\/g, '/').split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] || null;
}

const C_COMMENT = { line: ['//'], block: [['/*', '*/']] };
const HASH_COMMENT = { line: ['#'], block: [] };

const HTTP = 'get|post|put|delete|patch|all|options|head';
const JS_ID = '[A-Za-z_$][\\w$]*';

function upper(s) { return String(s || '').toUpperCase(); }

// ---------------------------------------------------------------- JavaScript / TypeScript
function jsPatterns(ts) {
  const list = [
    // Express / Koa / Fastify style: app.get('/path', mw..., handler)
    {
      kind: 'route',
      regex: new RegExp(`^(\\s*)(?:[\\w$]+\\.)*(?:\\w*[Rr]outer|app|server|fastify|api|routes)\\.(${HTTP})\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*(.*)$`),
      methodGroup: 2, pathGroup: 3, restGroup: 4,
    },
    // NestJS
    { kind: 'prefix', regex: /^(\s*)@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/, pathGroup: 2 },
    { kind: 'decorator', regex: /^(\s*)@(Get|Post|Put|Delete|Patch|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?[^)]*\)/, methodGroup: 2, pathGroup: 3 },
    { kind: 'decorator', regex: /^(\s*)@Cron\(/, job: true },
    // definitions
    { kind: 'def', type: 'function', regex: new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*(${JS_ID})\\s*(?:<[^>]*>)?\\s*\\(`), nameGroup: 2 },
    { kind: 'def', type: 'function', regex: /^(\s*)export\s+default\s+(?:async\s+)?function\s*\*?\s*\(/, name: () => 'default' },
    {
      kind: 'def', type: 'function',
      regex: new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+(${JS_ID})\\s*(?::\\s*[^=]+?)?\\s*=\\s*(?:(?:React\\.)?(?:memo|forwardRef|observer)\\(\\s*)?(?:async\\s*)?(?:function\\b|(?:\\([^)]*\\)|${JS_ID})\\s*(?::\\s*[^=]+?)?=>)`),
      nameGroup: 2,
    },
    { kind: 'def', type: 'class', container: true, regex: new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(${JS_ID})`), nameGroup: 2 },
  ];
  if (ts) {
    list.push({ kind: 'def', type: 'class', extraKind: 'interface', regex: new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?interface\\s+(${JS_ID})`), nameGroup: 2 });
    list.push({ kind: 'def', type: 'class', extraKind: 'enum', regex: new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:const\\s+)?enum\\s+(${JS_ID})`), nameGroup: 2 });
  }
  list.push(
    // methods inside classes: [modifiers] name(...) {   or   name = () =>
    {
      kind: 'def', type: 'function', insideOnly: true,
      regex: new RegExp(`^(\\s*)(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set|declare)\\s+)*\\*?\\s*(#?${JS_ID})\\s*(?:<[^>]*>)?\\s*\\(`),
      nameGroup: 2, notNames: ['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'await', 'super', 'else', 'function', 'do', 'import', 'require'],
    },
    {
      kind: 'def', type: 'function', insideOnly: true,
      regex: new RegExp(`^(\\s*)(?:(?:public|private|protected|static|readonly|override)\\s+)*(#?${JS_ID})\\s*(?::\\s*[^=]+?)?\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${JS_ID})\\s*(?::\\s*[^=]+?)?=>`),
      nameGroup: 2,
    },
    // scheduled jobs
    { kind: 'job', regex: /\bcron\.schedule\(\s*['"`]([^'"`]+)['"`]/, name: (m) => `cron ${m[1]}` },
    { kind: 'job', regex: /\bnew\s+CronJob\(\s*['"`]([^'"`]+)['"`]/, name: (m) => `cron ${m[1]}` },
    { kind: 'job', regex: /\bschedule\.scheduleJob\(\s*['"`]([^'"`]+)['"`]/, name: (m) => `cron ${m[1]}` },
    { kind: 'job', regex: new RegExp(`\\bsetInterval\\(\\s*(${JS_ID})\\s*,`), name: (m) => `interval ${m[1]}` },
  );
  return list;
}

// ---------------------------------------------------------------- Python
const PY_PATTERNS = [
  { kind: 'decorator', regex: /^(\s*)@[\w.]+\.route\(\s*['"]([^'"]+)['"](?:.*?methods\s*=\s*[[(]([^\])]*)[\])])?/, pathGroup: 2, method: (m) => (m[3] ? m[3].replace(/['"\s]/g, '').split(',').filter(Boolean).map(upper).join(',') : 'GET') },
  { kind: 'decorator', regex: /^(\s*)@[\w.]+\.(get|post|put|delete|patch|head|options|websocket)\(\s*['"]([^'"]+)['"]/, methodGroup: 2, pathGroup: 3 },
  { kind: 'decorator', regex: /^(\s*)@[\w.]+\.api_route\(\s*['"]([^'"]+)['"]/, pathGroup: 2, method: () => 'ANY' },
  { kind: 'decorator', regex: /^(\s*)@(?:[\w.]+\.)?(?:task|shared_task|periodic_task|cron|scheduled_job|job|repeat_every)\b/, job: true },
  { kind: 'route', regex: /^(\s*)(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/, method: () => 'ANY', pathGroup: 2, handlerGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/, nameGroup: 2 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)class\s+(\w+)/, nameGroup: 2 },
];

// ---------------------------------------------------------------- Go
const GO_PATTERNS = [
  { kind: 'route', regex: /^(\s*)[\w.]+\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/, method: () => 'ANY', pathGroup: 2 },
  { kind: 'route', regex: /^(\s*)[\w.]+\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options)\(\s*"([^"]+)"/, methodGroup: 2, pathGroup: 3 },
  { kind: 'def', type: 'method', regex: /^(\s*)func\s*\(\s*\w+\s+\*?(\w+)(?:\[[^\]]*\])?\s*\)\s+(\w+)\s*\(/, nameGroup: 3, parentGroup: 2 },
  { kind: 'def', type: 'function', regex: /^(\s*)func\s+(\w+)\s*[([]/, nameGroup: 2 },
  { kind: 'def', type: 'class', regex: /^(\s*)type\s+(\w+)\s+(?:struct|interface)\b/, nameGroup: 2 },
];

// ---------------------------------------------------------------- Rust
const RS_PATTERNS = [
  { kind: 'decorator', regex: /^(\s*)#\[(get|post|put|delete|patch|head|options)\(\s*"([^"]+)"/, methodGroup: 2, pathGroup: 3 },
  { kind: 'route', anyIndent: true, regex: /^(\s*)\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\(/, pathGroup: 2, methodGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, nameGroup: 2 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/, nameGroup: 2, extraKind: 'trait' },
  { kind: 'def', type: 'class', regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(struct|enum|union)\s+(\w+)/, nameGroup: 3 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:(\w+)(?:<[^>]*>)?\s+for\s+)?(\w+)/, name: (m) => (m[2] ? `impl ${m[2]} for ${m[3]}` : `impl ${m[3]}`), extraKind: 'impl' },
  { kind: 'def', unit: false, container: true, regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/, nameGroup: 2 },
];

// ---------------------------------------------------------------- Java / Kotlin / C# / Swift
const JAVA_MODS = '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed|transient|volatile)\\s+)*';
const JAVA_NOT = '(?!(?:return|new|else|throw|if|for|while|switch|catch|case|do|try|super|this|import|package|assert|break|continue)\\b)';
const JAVA_PATTERNS = [
  { kind: 'decorator', regex: /^(\s*)@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?['"]([^'"]*)['"]/, method: (m) => (m[2] === 'Request' ? 'ANY' : upper(m[2])), pathGroup: 3 },
  { kind: 'decorator', regex: /^(\s*)@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*$/, methodGroup: 2 },
  { kind: 'decorator', regex: /^(\s*)@Path\(\s*['"]([^'"]*)['"]/, pathGroup: 2 },
  { kind: 'decorator', regex: /^(\s*)@Scheduled\(/, job: true },
  { kind: 'def', type: 'class', container: true, regex: new RegExp(`^(\\s*)${JAVA_MODS}(class|interface|enum|record|@interface)\\s+(\\w+)`), nameGroup: 3 },
  {
    kind: 'def', type: 'function', insideOnly: true,
    regex: new RegExp(`^(\\s*)${JAVA_MODS}(?:<[^>]+>\\s+)?${JAVA_NOT}[\\w<>\\[\\],?.]+\\s+(\\w+)\\s*\\([^)]*\\)?\\s*(?:throws\\s+[\\w.,\\s]+)?\\s*(?:\\{|$|;)`),
    nameGroup: 2,
  },
];

const KT_PATTERNS = [
  { kind: 'decorator', regex: /^(\s*)@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\[?['"]([^'"]*)['"]/, method: (m) => (m[2] === 'Request' ? 'ANY' : upper(m[2])), pathGroup: 3 },
  { kind: 'decorator', regex: /^(\s*)@Scheduled\(/, job: true },
  { kind: 'route', anyIndent: true, regex: /^(\s*)(get|post|put|delete|patch|head|options)\(\s*"([^"]+)"\s*\)\s*\{/, methodGroup: 2, pathGroup: 3 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(?:(?:public|private|protected|internal|abstract|open|final|sealed|data|enum|annotation|inner|value|companion)\s+)*(class|interface|object)\s+(\w+)/, nameGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)(?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>]*>\s+)?(?:[\w.<>?]+\.)?(\w+)\s*\(/, nameGroup: 2 },
];

const CS_MODS = '(?:(?:public|private|protected|internal|static|abstract|sealed|virtual|override|async|partial|extern|unsafe|new|readonly)\\s+)*';
const CS_NOT = '(?!(?:return|new|else|throw|if|for|foreach|while|switch|catch|case|do|try|using|lock|await|yield|var|get|set|add|remove|base|this|namespace)\\b)';
const CS_PATTERNS = [
  { kind: 'decorator', regex: /^(\s*)\[Http(Get|Post|Put|Delete|Patch|Head|Options)\(\s*"([^"]+)"\s*\)\]/, methodGroup: 2, pathGroup: 3 },
  { kind: 'decorator', regex: /^(\s*)\[Http(Get|Post|Put|Delete|Patch|Head|Options)\]/, methodGroup: 2 },
  { kind: 'decorator', regex: /^(\s*)\[Route\(\s*"([^"]+)"\s*\)\]/, pathGroup: 2 },
  { kind: 'route', anyIndent: true, regex: /^(\s*)[\w.]+\.Map(Get|Post|Put|Delete|Patch)\(\s*"([^"]+)"/, methodGroup: 2, pathGroup: 3 },
  { kind: 'def', unit: false, container: true, regex: /^(\s*)namespace\s+([\w.]+)\s*\{?\s*$/, nameGroup: 2 },
  { kind: 'def', type: 'class', container: true, regex: new RegExp(`^(\\s*)${CS_MODS}(?:(?:readonly|ref)\\s+)?(class|interface|struct|enum|record(?:\\s+struct|\\s+class)?)\\s+(\\w+)`), nameGroup: 3 },
  {
    kind: 'def', type: 'function', insideOnly: true,
    regex: new RegExp(`^(\\s*)${CS_MODS}${CS_NOT}[\\w<>\\[\\],?.]+\\s+(\\w+)\\s*\\([^)]*\\)?\\s*(?:where\\s+[^{]+)?(?:\\{|$|;|=>)`),
    nameGroup: 2,
  },
];

const SWIFT_PATTERNS = [
  { kind: 'route', anyIndent: true, regex: /^(\s*)[\w.]+\.(get|post|put|delete|patch)\(\s*"([^"]+)"/, methodGroup: 2, pathGroup: 3 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor)\s+([\w.]+)/, nameGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|final|convenience|required|@objc|@discardableResult|@MainActor|nonisolated)\s+)*func\s+(\w+)/, nameGroup: 2 },
  { kind: 'def', type: 'function', insideOnly: true, regex: /^(\s*)(?:(?:public|private|internal|fileprivate|required|convenience|override)\s+)*(init)\s*[(?!]/, nameGroup: 2 },
];

// ---------------------------------------------------------------- Ruby / PHP / shell / SQL
const RUBY_PATTERNS = [
  { kind: 'route', regex: /^(\s*)(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/, methodGroup: 2, pathGroup: 3 },
  { kind: 'route', regex: /^(\s*)(resources?)\s+:(\w+)/, method: () => 'RESOURCE', name: (m) => `RESOURCE /${m[3]}`, pathGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)def\s+(?:self\.)?([\w?!=]+)/, nameGroup: 2 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(class|module)\s+([\w:]+)/, nameGroup: 3 },
];

const PHP_PATTERNS = [
  { kind: 'route', regex: /^(\s*)Route::(get|post|put|patch|delete|any|match)\(\s*['"]([^'"]+)['"]/, methodGroup: 2, pathGroup: 3 },
  { kind: 'route', regex: /^(\s*)\$(?:app|router|r|group)->(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]/, methodGroup: 2, pathGroup: 3 },
  { kind: 'def', type: 'function', regex: /^(\s*)(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)\s*\(/, nameGroup: 2 },
  { kind: 'def', type: 'class', container: true, regex: /^(\s*)(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/, nameGroup: 3 },
];

const SH_PATTERNS = [
  { kind: 'def', type: 'function', regex: /^(\s*)(?:function\s+)?([\w.:-]+)\s*\(\s*\)\s*\{?/, nameGroup: 2 },
  { kind: 'def', type: 'function', regex: /^(\s*)function\s+([\w.:-]+)\b/, nameGroup: 2 },
];

const SQL_PATTERNS = [
  {
    kind: 'def', type: 'class',
    regex: /^(\s*)CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|MATERIALIZED)\s+)*(TABLE|VIEW|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)/i,
    name: (m) => `${m[2].toLowerCase()} ${m[3]}`, extraKind: (m) => m[2].toLowerCase(),
  },
  {
    kind: 'def', type: 'function',
    regex: /^(\s*)CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)/i,
    name: (m) => `${m[2].toLowerCase()} ${m[3]}`, extraKind: (m) => m[2].toLowerCase(),
  },
];

const RULES = {
  js: { patterns: jsPatterns(false), comment: C_COMMENT, decorator: /^\s*@\w/, docstringBelow: false, block: 'brace', maxIndent: 2, jsx: true, imports: true, sql: true },
  ts: { patterns: jsPatterns(true), comment: C_COMMENT, decorator: /^\s*@\w/, docstringBelow: false, block: 'brace', maxIndent: 2, jsx: true, imports: true, sql: true },
  py: { patterns: PY_PATTERNS, comment: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] }, decorator: /^\s*@\w/, docstringBelow: true, block: 'indent', maxIndent: 0, jsx: false, imports: false, sql: true },
  go: { patterns: GO_PATTERNS, comment: C_COMMENT, decorator: null, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  rs: { patterns: RS_PATTERNS, comment: C_COMMENT, decorator: /^\s*#\[/, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  java: { patterns: JAVA_PATTERNS, comment: C_COMMENT, decorator: /^\s*@\w/, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  kotlin: { patterns: KT_PATTERNS, comment: C_COMMENT, decorator: /^\s*@\w/, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  csharp: { patterns: CS_PATTERNS, comment: C_COMMENT, decorator: /^\s*\[\w/, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  swift: { patterns: SWIFT_PATTERNS, comment: C_COMMENT, decorator: /^\s*@\w/, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  ruby: { patterns: RUBY_PATTERNS, comment: { line: ['#'], block: [['=begin', '=end']] }, decorator: null, docstringBelow: false, block: 'end', maxIndent: 0, jsx: false, imports: false, sql: true },
  php: { patterns: PHP_PATTERNS, comment: { line: ['//', '#'], block: [['/*', '*/']] }, decorator: /^\s*#\[/, docstringBelow: false, block: 'brace', maxIndent: 4, jsx: false, imports: false, sql: true },
  sh: { patterns: SH_PATTERNS, comment: HASH_COMMENT, decorator: null, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: true },
  sql: { patterns: SQL_PATTERNS, comment: { line: ['--'], block: [['/*', '*/']] }, decorator: null, docstringBelow: false, block: 'semicolon', maxIndent: 0, jsx: false, imports: false, sql: true },
};

// Files with an unknown language (explicitly included) get a generic rule set:
// no definitions, generic comment syntax for the file header.
const GENERIC_RULES = {
  patterns: [],
  comment: { line: ['//', '#', '--'], block: [['/*', '*/'], ['"""', '"""'], ['<!--', '-->']] },
  decorator: null, docstringBelow: false, block: 'brace', maxIndent: 0, jsx: false, imports: false, sql: false,
};

function rulesFor(lang) {
  return RULES[lang] || GENERIC_RULES;
}

module.exports = { detectLang, rulesFor, LANGS, EXT_TO_LANG };
