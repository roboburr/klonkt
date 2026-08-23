# Agent Instructions

> **The beads database in this repository is retired. Do not write to it.**
>
> Klonkt's issues live in `~/Sources/shaer-frontend/.beads` (Dolt database
> `shaer`). All 32 of them were migrated there on 2026-08-23 keeping their
> original `prutfolio-src-*` ids, so `bd show prutfolio-src-7cz` works from that
> repository and means the same issue it always did.
>
> Create, update and close Klonkt issues from `~/Sources/shaer-frontend`. The
> `bd` commands below apply there, not here.
>
> Why: this repository has no `core.hooksPath`, so the beads hooks in
> `.beads/hooks/` never ran. The Dolt database is gitignored and the one tracked
> artefact, `.beads/issues.jsonl`, is only refreshed by those hooks — it had
> drifted four days and two issues behind before anyone noticed. shaer-frontend
> has the hooks wired, so its export stays current.
>
> The local database is left in place and still readable for history. Nothing
> enforces this: it is a convention, and a `bd create` run here will succeed and
> be lost.

This project uses **bd** (beads) for issue tracking, from the shaer-frontend
repository. Run `bd prime` there for full workflow context.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

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

