# jevmap

jevmap builds a map of a codebase as small units (functions, endpoints, classes,
components, pages, jobs) by reading the source, without AI, and then asks Jev
(TypeSafe AI) which units matter for a task written in plain language. The
result is a short list of files, with line numbers and probabilities, that an
AI coding agent reads before touching anything. Zero runtime dependencies,
Node.js 18 or newer, MIT.

## The idea

An agent asked to change two files in a repository it does not know tends to
read eighty: it greps for words, opens candidates, follows imports, reads whole
files to find one function. That costs time, tokens and attention, and the
agent still misses the file that mattered.

jevmap turns that around. The map of the whole repository is small enough for
Jev to read in one go. Jev judges every unit against the task and hands the
agent the ten files that matter, in order. The agent opens two or three of
them at the right lines and starts working.

Measured with jevmap 0.1.0 on AEGEST, an ERP for a sheet-metal shop (Express
backend, React frontend, 302 files, 1,460 units), with the last 40 commits as
ground truth (32 usable: the commit message is the task, the touched source
files are the answer):

| Mode                           | first file right | within top 3 | within top 5 | time per search | cost per search |
| ------------------------------ | ---------------: | -----------: | -----------: | --------------- | --------------- |
| full scan (default)            |              72% |          81% |          88% | 1 to 2 s        | 0.7 US cents (25 calls, 160k tokens) |
| keyword prefilter + choice     |              72% |          84% |          94% | under 1 s       | 0.02 US cents (1 call, 4k tokens) |

The earlier internal version of this tool, measured on the same repository
with 855 coarser units and 103 commits, had the full scan at 76% / 90% (top 1 /
top 5) and the prefilter at 58% / 72%. Numbers vary by repository and by the
quality of the unit descriptions: the benchmark command below measures yours.

## Install

```sh
npm i -g jevmap
```

or straight from GitHub, or without installing:

```sh
npm i -g github:aegsrl7/jevmap
npx jevmap --help
```

You need a TypeSafe API key for the searches (`TYPESAFE_API_KEY`, see
https://docs.typesafe.ai) and, optionally, an Anthropic key
(`ANTHROPIC_API_KEY`) for the `describe` command and for splitting composite
tasks. Building the map needs no key at all.

## Quick start

```sh
cd my-repo
export TYPESAFE_API_KEY=...

jevmap build
# Map built: 258 files, 855 units in 2100 ms
#   /home/me/my-repo/.jevmap/map.json
#   /home/me/my-repo/.jevmap/map.md

jevmap find "show the customer name in the email list"
# Task: show the customer name in the email list
# Scan: 15 calls in 1100 ms, 51k tokens ($0.0021)
# Files to read:
#   93%  backend/routes/emails.js
#   81%  frontend/src/pages/EmailList.jsx
#   44%  backend/services/emailFlow.js
#   ...
# Units:
#   93%  backend/routes/emails.js:120  GET /api/emails - List emails with filters (category, archived)
#   81%  frontend/src/pages/EmailList.jsx:18  EmailList - Page with the email table and the filters bar
#   ...
```

Add `.jevmap/` to your `.gitignore` if you do not want the map in the
repository, or commit it so that every agent and teammate shares the same map.

## Commands

```
jevmap build [--root .] [--out .jevmap] [--project "..."] [--include g] [--exclude g] [--json]
jevmap find "task" [--mode scan|prefilter] [--split llm|heuristic|none] [--top 15]
                   [--files-only] [--json] [--batch 60] [--candidates 40]
jevmap describe [--model claude-haiku-4-5] [--dry-run] [--max-units 500]
jevmap bench [--commits 100] [--modes scan,prefilter] [--top 15] [--json]
jevmap --help | --version
```

### build

Scans the repository and writes `<out>/map.json` (data) and `<out>/map.md`
(a readable index, one section per area, one subsection per file, one bullet
per unit). No network, no key. Files come from `git ls-files` when git is
available (tracked plus untracked files that are not ignored), otherwise from
a directory walk that honours the root `.gitignore`.

### find

Resolves the map from `<root>/<out>/map.json`, asks Jev and prints, per part
of the task:

- `Task:` the text searched;
- `Scan: 15 calls in 1100 ms, 51k tokens ($0.0021)` (or `Prefilter: ...`);
- `Files to read:` unique files ordered by their best unit, up to ten;
- `Units:` the top units with `probability  file:line  name - description`.

With `--files-only` only the files are printed. With `--json` the raw result
is printed (shape below). Colours are used only when stdout is a terminal.

If `map.json` is missing, `find` tells you to run `jevmap build` first. If
`TYPESAFE_API_KEY` is missing, `find` prints the keyword prefilter order with
scores instead of probabilities and says so on stderr.

### describe

Fills the descriptions of units that have none, with an Anthropic model
(default `claude-haiku-4-5`). Units are grouped by file, at most 25 per
request, with their source (capped at 60 lines each). The answers are merged
into `<out>/descriptions.json` (key = unit id) and the map is rebuilt.
`--dry-run` prints what would be sent without calling the API. The cost
estimate is printed at the end.

### bench

Reads the last N commits, uses each message as a task and the touched source
files as the answer, runs `find` in every requested mode and prints a table.
See "The benchmark" below.

## Options

| Option              | Commands          | Meaning                                                                 |
| ------------------- | ----------------- | ----------------------------------------------------------------------- |
| `--root <dir>`      | all               | Repository root (default: current directory).                           |
| `--out <dir>`       | all               | Output directory relative to root (default `.jevmap`).                  |
| `--project <text>`  | build, find, bench | One sentence about the project, used inside the Jev questions.         |
| `--include <glob>`  | build             | Only scan matching paths (repeatable).                                  |
| `--exclude <glob>`  | build             | Skip matching paths (repeatable).                                       |
| `--json`            | all               | Print the raw result as JSON (progress goes to stderr).                 |
| `--mode`            | find              | `scan` (default) or `prefilter`.                                        |
| `--split`           | find              | `llm` (default when an Anthropic key exists), `heuristic` or `none`.    |
| `--top <n>`         | find, bench       | Units to print (default 15).                                            |
| `--files-only`      | find              | Print only the files to read.                                           |
| `--batch <n>`       | find, bench       | Units per Jev request in scan mode (default 60).                        |
| `--candidates <n>`  | find, bench       | Candidates sent to the choice question in prefilter mode (default 40).  |
| `--model <id>`      | describe, find    | Anthropic model for `describe` and for the `llm` splitter.              |
| `--dry-run`         | describe          | Do not call the API, print what would be sent.                          |
| `--max-units <n>`   | describe          | Stop after this many units (default 500).                               |
| `--commits <n>`     | bench             | Commits to read from `git log` (default 100).                           |
| `--modes a,b`       | bench             | Modes to measure, comma-separated (default `scan,prefilter`).           |

Exit codes: 0 ok, 1 error (message on stderr), 2 usage.

## Configuration: jevmap.config.json

Optional, in the repository root. Every field is optional. Command line
options override it.

```json
{
  "project": "AEGEST, an ERP for a sheet-metal shop: Express backend in backend/, React frontend in frontend/src",
  "include": ["backend/**", "frontend/src/**"],
  "exclude": ["**/*.test.js", "backend/scripts/**"],
  "areas": [["email|imap|mail", "email"], ["laser", "laser"]],
  "out": ".jevmap",
  "descriptions": ".jevmap/descriptions.json",
  "batch": 60
}
```

- `project`: one sentence used inside the Jev questions ("in the project:
  ..."). The more concrete, the better the ranking.
- `include`, `exclude`: glob-like patterns with `**`, `*` and `?`. Default:
  include everything; exclude `.git`, `node_modules`, `dist`, `build`, `out`,
  `coverage`, `vendor`, `__pycache__`, `.venv`, `venv`, `target`, `*.min.js`,
  `*.map`, lockfiles, binaries (by extension) and files over 1 MB.
- `areas`: list of `[regex, name]` pairs applied to the relative path (basename
  first, then the full path). The first match wins; the default area is the
  first directory segment. Areas only organise `map.md`.
- `out`: output directory for `map.json`, `map.md`, `descriptions.json` and
  `bench.json` (default `.jevmap`).
- `descriptions`: path of the descriptions file merged into the map at every
  build (default `<out>/descriptions.json`).
- `batch`: units per Jev request in scan mode (default 60).

## Environment variables

| Variable            | Used by                                | Notes                                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `TYPESAFE_API_KEY`  | find, bench                            | Jev key from https://docs.typesafe.ai. Never printed.         |
| `ANTHROPIC_API_KEY` | describe, find (`--split llm`), bench  | `CLAUDE_API_KEY` is accepted as an alias.                     |
| `JEV_MODEL`         | find, bench                            | Jev model id (default `jev-latest`).                          |
| `NO_COLOR`          | all                                    | Disables ANSI colours even on a terminal.                     |

A `.env` file in the repository root is read for these variables (simple
`KEY=VALUE` lines). Keys are never printed or written to disk by jevmap.

## The Claude Code skill

`skills/jevmap/SKILL.md` is a drop-in skill for Claude Code (and any agent
that reads skill files). Copy it into your repository:

```sh
mkdir -p .claude/skills/jevmap
cp "$(npm root -g)/jevmap/skills/jevmap/SKILL.md" .claude/skills/jevmap/
```

With the skill in place the agent, at the start of any task on a repository
that has a `.jevmap` map:

1. runs `jevmap find "<task>"` before opening files;
2. reads the top two or three files at the given lines, not whole files;
3. when the probabilities are flat, greps `.jevmap/map.md` by area;
4. rebuilds the map after large changes and runs `describe` when units have no
   description;
5. never reads `map.json` whole.

## How it works

### Units

`build` reads every source file and extracts top-level definitions with
regular expressions, per language: functions, arrow constants, classes and
their methods, Express/Koa/Fastify and NestJS routes, cron jobs, React
components (and pages when a route table maps them), Flask/FastAPI/Django
routes, Go handlers, Rust functions and attributes, Spring and ASP.NET
mappings, Rails and Laravel routes, shell functions, SQL `CREATE` statements.
Each unit records its file, line range, the comment block right above it (or
the docstring), and extras found in its body: SQL tables, API paths called,
socket events emitted, local imports, middleware, route. When a source file
yields no unit, the whole file becomes one unit.

### Full scan (default)

For every unit, one `noul` question to Jev: "To carry out the task in `task`
in the project <project>, a developer must read or modify this code unit:
file | type name | does: description | tables: ... | calls: ... | page ...".
Questions are batched, 60 per request by default, and all batches are sent in
parallel, so 855 units are 15 requests and about one second. The probability
of each unit is the answer; files are ordered by their best unit.

### Keyword prefilter

`--mode prefilter` scores every unit by the words it shares with the task
(with stemming and a bonus when the word is in the name or path), keeps the
top 40 candidates and asks Jev one `choice` question with a criterion per
candidate plus "none of these". It is cheaper (one request) and works well when
the task uses the same words as the code, worse otherwise.

### Composite tasks

A task like "add the VAT field to the customer form; recompute the totals in
the invoice job" is two tasks. When `--split llm` is active (the default when
an Anthropic key exists) and the text looks composite (newlines, semicolons,
bullets, commas between multi-word parts, or more than 14 words), a small
Anthropic model returns the list of self-contained sub-tasks (at most 8).
Without a key, a heuristic splits on bullets, numbering, semicolons, ` + `,
"and then" and commas when every part has at least two words. Each part is
searched in parallel and printed separately.

### Descriptions, and why they matter

Jev judges a unit by its one-line description, its name and its extras. A unit
with no description is judged on its name alone, which is often not enough.
`build` takes the description from the comment right above the unit; `describe`
fills the rest with an Anthropic model and stores the result in
`descriptions.json`, which is merged at every build. The single most effective
thing you can do for the ranking is to keep a one-line comment above every
endpoint, job and component.

## The benchmark

```sh
jevmap bench --commits 100
```

For each of the last 100 commits (merges, very short messages and commits that
touch only docs, lockfiles, JSON or YAML are skipped) the message is the task
and the touched source files present in the map are the answer. `find` runs
in every requested mode, and the table reports:

- `top-1`, `top-3`, `top-5`: share of commits whose first touched file is
  within the first 1, 3 or 5 proposed files (union of the parts, in order);
- `cov@3`: average share of touched files found in the top-3 files of any
  part (useful for composite commits);
- `calls`, `tokens`, `ms`: averages per commit; `cost`: total in USD.

Rows with the rank per commit are written to `<out>/bench.json`. Read the
numbers as a comparison between modes and between versions of the map (before
and after `describe`, for instance), not as an absolute score: commit messages
are a rough proxy for tasks.

## Costs

- Jev (TypeSafe) is billed on input tokens: 0.042 USD per million tokens at
  the time of writing. A full scan costs about 110 tokens per unit: 1,460
  units are 160k tokens, that is 0.007 USD per search; the prefilter is about
  4k tokens, 0.0002 USD. A composite task is searched part by part, so it
  costs one scan per part. See https://docs.typesafe.ai for current prices.
- `describe` uses an Anthropic model (default `claude-haiku-4-5`); the cost
  estimate is printed at the end of the run. Describing a few hundred units is
  usually a few cents. `--dry-run` shows what would be sent.
- `build` and the heuristic splitter are free.

## Limits

- The extractor is a set of regular expressions, not a parser. It finds
  top-level definitions and common framework patterns; it does not follow
  types, decorators it does not know, or code generated at runtime. Deeply
  nested definitions are skipped on purpose.
- Best results on JavaScript, TypeScript and Python, which were tuned on real
  repositories. The other languages have basic rules and welcome improvements.
- Large repositories: the number of Jev requests and tokens scales with the
  number of units (one batch of 60 per request). Ten thousand units are about
  170 requests and 600k tokens per search, still under three cents; use
  `include`/`exclude` to keep the map to the code that changes.
- Jev availability: `find` retries on 408, 429 and 5xx with a short backoff.
  Without a key, or when Jev is unreachable, use `--mode prefilter` with the
  keyword fallback, which needs no network.
- Ranking quality depends on descriptions. Run `describe` after the first
  build, and keep comments above new units.

## Contributing

Issues and pull requests are welcome. To work on the code:

```sh
git clone https://github.com/aegsrl7/jevmap
cd jevmap
npm test
```

Tests use `node:test` and a small fixture repository; no network is needed.
Keep the package free of runtime dependencies, keep every module in CommonJS
with `'use strict'`, and add a test with any new language rule.

## License

MIT, see [LICENSE](LICENSE).

jevmap uses Jev by TypeSafe AI for the ranking: https://docs.typesafe.ai
