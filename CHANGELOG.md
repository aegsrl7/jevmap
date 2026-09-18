# Changelog

All notable changes to jevmap are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-18

First public release, ported from the internal AEGEST tooling.

### Added

- `jevmap build`: scans a repository and writes `.jevmap/map.json` and
  `.jevmap/map.md`, one entry per code unit (function, method, class, endpoint,
  component, page, job), read from the source with regular expressions and no AI.
- `jevmap find "<task>"`: asks Jev (TypeSafe AI) which units matter for a task.
  Full scan mode (one yes/no question per unit, batched and run in parallel) and
  keyword prefilter mode (keyword score, then one choice question on the
  candidates). Composite tasks are split by an Anthropic model or by a
  heuristic and searched part by part.
- `jevmap describe`: fills missing unit descriptions with an Anthropic model and
  merges them into `descriptions.json`.
- `jevmap bench`: measures the finder on the git history (commit message as
  the task, touched files as the answer) and prints top-1, top-3 and top-5 hit
  rates per mode.
- Language rules for JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin,
  C#, Swift, Ruby, PHP, shell and SQL.
- `jevmap.config.json` with `project`, `include`, `exclude`, `areas`, `out`,
  `descriptions` and `batch`; `--descriptions <file>` on the command line.
- Minified or bundled files (any line over 2000 chars, or an average line over
  300) are skipped at build time and listed in the output.
- A drop-in skill for Claude Code in `skills/jevmap/SKILL.md`.
- Zero runtime dependencies, Node.js 18 or newer.
