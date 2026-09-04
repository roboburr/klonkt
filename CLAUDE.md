# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

> **The beads database in this repository is retired. Do not write to it, and
> do not read it either: it is no longer the truth about anything.**
>
> Klonkt's issues live in `~/work/shaer-frontend/.beads` (Dolt database
> `shaer`). All 34 of them are there, keeping their original `prutfolio-src-*`
> ids, so `bd show prutfolio-src-7cz` works from that repository and means the
> issue it always did.
>
> Create, update and close Klonkt issues from `~/work/shaer-frontend`. The `bd`
> commands below apply there, not here.
>
> Why: this repository has no `core.hooksPath`, so the beads hooks in
> `.beads/hooks/` never ran. The Dolt database is gitignored and the one tracked
> artefact, `.beads/issues.jsonl`, is only refreshed by those hooks — it had
> drifted four days and two issues behind before anyone noticed. shaer-frontend
> has the hooks wired, so its export stays current.
>
> **That drift bit once more.** The move of 2026-08-23 carried the 32 issues in
> the stale JSONL, not the 34 in the database beside it, so `prutfolio-src-uj9`
> (open) and `prutfolio-src-ap6` (closed) stayed behind where nobody would look
> for them. Folded in on 2026-08-26; the count above is the whole set. The
> mirror image is also true and explains the arithmetic: `prutfolio-src-086` and
> `prutfolio-src-da7` live only in that JSONL and never existed in this
> database.
>
> The local database is left in place as a historical artefact only. Nothing
> enforces any of this: a `bd create` run here will succeed and be lost.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->



## Build & Test

```bash
npm start          # production: node src/server.js
npm run dev        # watch mode
npm test           # unit tests (built-in node:test runner, no extra deps)
```

Tests live in `test/*.test.js` and run against an in-memory SQLite
(`DATABASE_PATH=':memory:'`), so they never touch real data. Cover new
permission logic with tests — `PermissionsService.canAdminSite` was once
silently broken; see `test/site-permissions.test.js`.

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

- **Bump `MOD_V` whenever you change anything in `src/assets/js/mod/`.** It sits
  at the top of the module loader in `src/views/shell.ejs` and is the
  cache-buster for every page module. `/assets` is served `max-age=1y` outside
  development, so without a bump a browser that visited before keeps running the
  old module for a year — meaning a fix reaches everyone *except* the people who
  already have the bug. Same discipline as `audio-player.js?v=N` a few hundred
  lines up. One number for the whole directory: bumping too often costs one
  download, bumping too rarely costs a bugfix that never arrives.

- **Comments and commit messages in Dutch, identifiers in English.** The modules
  in `assets/js/mod` read `setIcon`, `uploadOne`, `applyAccent`; the comments
  around them are Dutch prose. Both halves matter — a Dutch identifier in an
  English file is the same wrong note as an English comment in a Dutch one. This
  extends to anything long-lived and outward-facing: URL paths and CSS class
  names are English (`/read`, `.read-end`), never a Dutch verb form.
