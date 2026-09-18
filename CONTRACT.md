# jevmap: internal contract (shared by every module)

jevmap is a zero-dependency Node.js (>= 18) CLI that (1) builds a map of a codebase
as small "units" (functions, endpoints, classes, components, jobs) read from the
source without AI, and (2) asks Jev (TypeSafe AI, https://docs.typesafe.ai) which
units matter for a task written in plain language, so an AI coding agent reads ten
files instead of eighty. Reference implementation being ported (read-only, do not
modify): `/Volumes/LMZ_App/AEGEST_DEV/backend/scripts/mappa/costruisci_mappa.py`
(extractor), `trova.js` (finder), `bench-trova.js` (benchmark),
`/Volumes/LMZ_App/AEGEST_DEV/.claude/skills/aegest-mappa/SKILL.md` (agent skill).
Everything in this package is in English (code, comments, CLI output, README).

## Layout

```
jevmap/
  package.json          name jevmap, bin { "jevmap": "bin/jevmap.js" }, engines node >= 18, type commonjs, no dependencies, license MIT
  bin/jevmap.js         CLI entry (commands below), only argument parsing + printing
  src/config.js         loadConfig(root, cliOverrides) -> Config; default excludes; reads jevmap.config.json if present
  src/languages.js      per-language extraction rules (see "Extractor")
  src/extract.js        extractFile(relPath, text, lang, config) -> Unit[]
  src/build.js          build(root, config) -> Map; writeMap(map, outDir) writes map.json and map.md
  src/text.js           tokenize(text) -> string[], stem(word), keywordScore(unitText, queryTokens), stop words (English + Italian), splitTask(text) heuristic
  src/jev.js            jevRequest({ state, questions, apiKey, model, timeoutMs, maxRetry }) -> { answers, usage, model, ms }; helpers choice/score/noul
  src/llm.js            anthropicJson({ system, user, model, apiKey, maxTokens, timeoutMs }) -> parsed JSON (direct HTTPS to api.anthropic.com, no SDK)
  src/find.js           find(map, task, options) -> FindResult (full scan, prefilter, composite tasks)
  src/describe.js       describe(map, root, options) -> writes descriptions.json for units without a description (Anthropic model)
  src/bench.js          bench(root, map, options) -> BenchResult from git history
  skills/jevmap/SKILL.md  drop-in skill for Claude Code / other agents
  test/*.test.js        node:test, run with `npm test`; fixtures in test/fixtures/sample-repo (tiny JS + Python + TS repo)
  README.md, LICENSE (MIT), CHANGELOG.md, .github/workflows/ci.yml (node 18/20/22: npm test)
```

Environment variables: `TYPESAFE_API_KEY` (Jev), `ANTHROPIC_API_KEY` (describe, composite task splitting; `CLAUDE_API_KEY` accepted as alias), `JEV_MODEL` (default `jev-latest`). A `.env` in the repo root is read if present (simple KEY=VALUE parser in src/config.js, never printed).

## Config (`jevmap.config.json` in the repo root, all optional)

```json
{
  "project": "AEGEST, an ERP for a sheet-metal shop: Express backend in backend/, React frontend in frontend/src",
  "include": ["backend/**", "frontend/src/**"],
  "exclude": ["**/*.test.js", "backend/scripts/**"],
  "areas": [["email|imap|mail", "email"], ["laser", "laser"]],
  "out": ".jevmap",
  "descriptions": ".jevmap/descriptions.json",
  "batch": 60,
  "language": "en"
}
```

- `project`: one sentence used inside Jev questions ("in the project: ...").
- `include`/`exclude`: glob-like patterns (support `**`, `*`, `?`); defaults: include everything, exclude `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`, `__pycache__`, `.venv`, `venv`, `target`, `*.min.js`, `*.map`, lockfiles, binaries (by extension), files > 1 MB. `.gitignore` patterns at the root are honoured when `git` is not available; when it is, the file list comes from `git ls-files` (tracked + untracked not ignored).
- `areas`: array of [regex, name] applied to the relative path (basename first, then full path); default area = first directory segment.
- `out`: output directory for map.json and map.md (default `.jevmap`).
- `language`: language of the CLI output and of the fixed question texts (`en` default, `it` available); the task text itself can be in any language.

## Unit (one entry of `map.units`)

```json
{
  "id": "backend/routes/emails.js:120 GET /api/emails",
  "file": "backend/routes/emails.js",
  "lang": "js",
  "type": "endpoint",
  "name": "GET /api/emails",
  "start": 120,
  "end": 188,
  "comment": "List emails with filters (category, archived).",
  "description": "Same as comment, or filled from descriptions.json (key = id) or by `jevmap describe`",
  "area": "email",
  "extra": {
    "method": "GET", "path": "/api/emails",
    "tables": ["email_messages"], "calls": ["/api/emails"], "route": "/emails",
    "emits": ["email-updated"], "imports": ["../services/imap"], "middleware": ["optionalAuth"],
    "parent": "ClassName"
  }
}
```

- `type` is one of: `function`, `method`, `class`, `endpoint`, `component`, `page`, `job`, `file` (fallback: the whole file is one unit when no unit was found and the file is source code).
- `start`/`end` are 1-based line numbers. `end` is found by indentation/brace matching with a cap of 400 lines.
- `comment`: the comment block immediately above the unit (or the docstring right below `def`/`class` in Python), single line, max 240 chars, decorative lines removed.
- `extra` keys are optional; keep only what the language rule found.

`map` = `{ version: 1, generated: ISO string, root: absolute path, project, n_files, n_units, files: { [relPath]: { lines, lang, area, header, n_units } }, units: Unit[] }`.
`map.md`: one section per area, one subsection per file (`### path (N lines) — header`), one bullet per unit (`- \`start-end\` **name** — description [extra summary]`). Never edited by hand.

## Extractor rules (src/languages.js)

Detect language by extension: js/jsx/mjs/cjs -> js, ts/tsx -> ts, py -> py, go -> go, rs -> rs, java -> java, kt/kts -> kotlin, cs -> csharp, swift -> swift, rb -> ruby, php -> php, sh/bash -> sh, sql -> sql. Others: not scanned (except when `include` names them explicitly, then `file` units).

Per language, top-level (indent <= 2 for JS/TS, column 0 or inside a class for Python etc.) definitions:
- js/ts: `function name(`, `async function`, `const/let name = (async) (...) =>`, `class Name`, methods inside classes (`name(...) {` at class indent + 2, and `static`, `async`), `export default function`, Express/Koa/Fastify routes `app|router|server|fastify.(get|post|put|delete|patch|all)('path'`, NestJS decorators `@Get('path')` above a method, cron `cron.schedule('expr'`, `setInterval` named jobs; React components = capitalised function/const whose body contains JSX (`<` + capital letter or `return (`), `page` when a route table maps it (`<Route path=... component={X}` / `element={<X`); `extra.tables` from SQL keywords (FROM/JOIN/INTO/UPDATE/TABLE) with a stop list, `extra.emits` from `io.emit('x'`/`socket.emit('x'`, `extra.calls` from `fetch(`/`axios.<verb>(`/`api.<verb>(` URL literals starting with `/`, `extra.imports` from `require('./x')` and `import ... from './x'`.
- py: `def`, `async def`, `class`, methods inside classes, Flask `@app.route('/x', methods=[...])`, FastAPI/`@router.get('/x')`, Django `path('x', view)`, Celery `@task`, `@cron`; docstring as comment; tables as above.
- go: `func Name(`, `func (r *T) Name(`, `type Name struct|interface`, `r.HandleFunc("/x"`, `e.GET("/x"`.
- rs: `fn`, `pub fn`, `impl`, `struct`, `enum`, `#[get("/x")]`.
- java/kotlin/csharp/swift: `class`, `interface`, `record`, methods (`public|private|... Type name(`), Spring `@GetMapping("/x")`, ASP.NET `[HttpGet("x")]`.
- ruby: `def`, `class`, `module`, Rails routes `get 'x'`; php: `function`, `class`, Laravel `Route::get('x'`; sh: `name() {`; sql: `CREATE TABLE name` -> type `class`? no: type `file` units are fine for sql, plus one unit per `CREATE TABLE|VIEW|PROCEDURE|FUNCTION name`.

Comment extraction: consecutive `//`, `#`, `--` lines or a `/* */` `"""` block immediately above (or the docstring below for Python); strip decoration (`=-*#` only lines); join with spaces; 240 chars.

## Finder (src/find.js)

`find(map, task, { mode: 'scan'|'prefilter', split: 'llm'|'heuristic'|'none', top: 15, candidates: 40, batch: 60, jev: { apiKey, model, timeoutMs, maxRetry }, llm: { apiKey, model } , project, language })`

- `scan` (default): one `noul` question per unit ("To carry out the task in `task` in the project <project>, a developer must read or modify this code unit: <file> | <type name> | does: <description> | tables: ... | calls: ... | page ..."), batched `batch` units per request, all batches in parallel (`Promise.all`), state = `{ task }`. Probability per unit = the noul probability.
- `prefilter`: keyword score (tokens of task, with stemming, against tokens of unit id/name/path/description/extra; +0.5 when the word is in the name/path) -> top `candidates` units -> one `choice` question with criteria u1..uN (`{ file, unit, type, does, tables, calls, route }`) plus `none` ("None of these units is the right place for the task"); probabilities give the order.
- Composite tasks: if `split` is `llm` and an Anthropic key exists and the text looks composite (newlines, semicolons, bullets, commas separating multi-word parts, or > 14 words), ask the LLM for `{"tasks": [...]}` (max 8, each a self-contained sentence, ignore rationale); otherwise the heuristic `splitTask` from src/text.js (bullets, numbering, `;`, ` + `, "and then"/"e poi"/"poi"/"inoltre", commas when every part has >= 2 words); then run the search per part in parallel.
- Result:

```json
{
  "task": "...", "mode": "scan", "parts": [
    { "task": "part 1", "calls": 15, "ms": 1100, "tokens": 51000, "cost_usd": 0.0021,
      "files": [ { "file": "backend/routes/emails.js", "p": 0.93 } ],
      "units": [ { "id": "...", "file": "...", "line": 120, "name": "GET /api/emails", "p": 0.93, "description": "..." } ] }
  ]
}
```

`files` = unique files ordered by their best unit probability (top 10); `units` = top `top` units. Cost = tokens / 1e6 * 0.042 (input tokens; TypeSafe list price as of 09/2026, make it a constant `PRICE_PER_MTOKEN_USD`).

## Jev client (src/jev.js)

POST `https://api.typesafe.ai/v1/systemone` with JSON `{ state, model, questions }`, header `Authorization: Bearer <key>`; response `{ model, answers: { id: {...} }, usage: { input_tokens, output_tokens } }`. Question shapes: `{ type: 'choice', instructions, criteria: { key: { what?, not_for?, examples? } | string } }` -> answer `{ choice, probabilities, confidence }`; `{ type: 'score', instructions, criteria: [level descriptions] }` -> `{ score, probabilities, confidence }`; `{ type: 'noul', instructions }` -> `{ noul: probability }`. Question ids are not sent to the model: all meaning goes in `instructions`, state fields are cited with backticks. Retry on 408/429/5xx with 0.5 s -> 1 s -> 2 s backoff, `maxRetry` default 2, `timeoutMs` per call (default 30000), use global `fetch` with `AbortController`. Never log the key. Errors: `JevError` with `status`, `body`.

## Describe (src/describe.js)

For units whose `description` is empty: group by file (max 25 units per request), send the unit source slices (start..end, capped at 60 lines each) with the file header, ask the Anthropic model (default `claude-haiku-4-5`, override `--model`) to return `{"descriptions": {"<unit id>": "one line, what it does, imperative-free, max 160 chars"}}`, merge into `<out>/descriptions.json` (key = unit id, value = string), then rebuild the map. `--dry-run` prints what would be sent. Cost estimate printed at the end from usage.

## Bench (src/bench.js)

`git log -n <commits> --name-only --pretty=format:'@@%h|%s|%b'` -> tasks = subject + body (strip Co-Authored-By and trailers), answers = touched source files present in the map (exclude docs, lockfiles, config json, the map output dir). For each commit: run `find` in scan mode and in prefilter mode (options `--modes scan,prefilter`), record the rank of the first touched file in the proposed `files`, and per-part coverage (share of touched files inside top-3 files of any part). Print a table: top-1, top-3, top-5 hit rates per mode, average calls, tokens, cost, time; write `<out>/bench.json`.

## CLI (bin/jevmap.js)

```
jevmap build [--root .] [--out .jevmap] [--project "..."] [--include g --exclude g] [--json]
jevmap find "task" [--mode scan|prefilter] [--split llm|heuristic|none] [--top 15] [--files-only] [--json] [--batch 60] [--candidates 40]
jevmap describe [--model claude-haiku-4-5] [--dry-run] [--max-units 500]
jevmap bench [--commits 100] [--modes scan,prefilter] [--json]
jevmap --help | --version
```

Exit codes: 0 ok, 1 error (message on stderr), 2 usage. `find` prints, per part: `Task: ...`, `Scan: 15 calls in 1100 ms, 51k tokens ($0.0021)`, then `Files to read:` with `93%  path` lines, then `Units:` with `93%  path:line  name — description`. With `--files-only` only the files. Colours only when stdout is a TTY (plain ANSI, no dependency). If `map.json` is missing, `find` says to run `jevmap build` first. If `TYPESAFE_API_KEY` is missing, `find` falls back to the keyword prefilter order and says so.

## Quality rules

- Zero runtime dependencies; Node >= 18; CommonJS; `'use strict'`; no global state besides constants.
- Every module exports pure functions where possible; I/O at the edges (bin, build.writeMap, bench git calls).
- Tests with `node:test` and the fixture repo: extractor finds the expected units (JS function, arrow const, Express route, React component + page via route table, Python def/class/Flask route, TS class method), text utilities (tokenize/stem/splitTask), find in prefilter mode with an injected fake Jev client (dependency injection: `find(map, task, { jevClient })`), build writes both files. No network in tests.
- Never print or store API keys. `.env` read only for the known variables.
- README in English with: what it is, why (the 10-files-instead-of-80 idea and the measured numbers from the AEGEST benchmark: full scan top-1 76%, top-5 90% on 103 commits, about 1 s and half a cent per search), install (`npm i -g jevmap` / `npx jevmap`), quick start, commands, config, the Claude Code skill, how it works (units, noul scan, choice prefilter, composite tasks), costs, limits (regex-based extractor, not a parser; Jev needs descriptions to be good; `describe` fills them), contributing, license.
