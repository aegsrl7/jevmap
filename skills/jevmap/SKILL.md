---
name: jevmap
description: Find right away the files and code units to work on for a task, using the jevmap map of the repository (.jevmap/map.json and map.md) and Jev's ranking, instead of grep and trial reads. Use at the start of any task on a repository that has a .jevmap directory and requires changing or understanding existing code, and whenever the user asks "where is" a function, an endpoint, a page or a component. Also explains when to rebuild the map and how to fill missing descriptions.
---

# jevmap: the map of this codebase

The repository has a map built by `jevmap` in `.jevmap/map.json` (data) and
`.jevmap/map.md` (index by area and file). Every entry is a code unit
(function, method, class, endpoint, React component, page, job) with file,
line range, description, SQL tables, API calls, socket events and route. The
map was built by reading the source, without AI. Jev (TypeSafe AI) reads the
whole map for a task and returns the files and units by probability.

## Before opening any file

1. From the task the user wrote, run:

   `jevmap find "<task>"`

   (or `npx jevmap find "<task>"` when it is not installed globally). By
   default Jev judges every unit of the map with a yes/no question in
   parallel batches (a few seconds, well under a cent) and prints the files to
   read in order of probability, with the units inside each file at their
   line numbers. Composite tasks are split into parts and searched part by
   part. Useful flags: `--files-only` for the file list alone, `--json` for
   the raw result, `--mode prefilter` for the cheaper keyword-then-choice
   mode, `--split none` to search the task as a single piece.

2. Read the result like this: the first 2 or 3 files with the units listed are
   the ones to open. Read them at the given lines (with offset and limit),
   not the whole file. If the probabilities are flat (all below about 40%)
   the task touches several places or the map does not cover it: search
   `.jevmap/map.md` by area with grep instead.

3. If the task is on a page and its backend, the map shows both: pages carry
   `calls` (the API paths they call), endpoints carry `path`. Grep the
   endpoint path in `map.md` to find who calls it.

4. Only when the map is not enough, grep the code for the names found.

## After large changes

- Rebuild the map: `jevmap build` (a few seconds, no AI, no key needed).
  Descriptions written by hand or by `jevmap describe` live in
  `.jevmap/descriptions.json` and are merged on every build.
- When you add an endpoint, a function or a component, put a one-line comment
  right above it saying what it does: the map uses it as the description.
- If `jevmap build` reports units without a description, run
  `jevmap describe` (needs `ANTHROPIC_API_KEY`) so that Jev has something to
  judge; descriptions are what makes the ranking good.
- To measure whether the map helps on this repository:
  `jevmap bench` uses the recent commits (message = task, touched files =
  answer) and prints top-1, top-3 and top-5 hit rates per mode.

## What not to do

- Do not read `.jevmap/map.json` whole: it can be hundreds of kilobytes. Use
  `jevmap find` or grep `.jevmap/map.md`.
- Do not treat Jev's probability as truth: it is an ordering. If the file you
  opened is unrelated, go back to the list.
- Do not edit `map.json` or `map.md` by hand: they are regenerated on every
  build. Put lasting descriptions in `.jevmap/descriptions.json` or in a
  comment above the unit.
- Do not print or paste the API keys; they come from the environment or from
  `.env`.
