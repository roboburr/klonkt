# Beads - AI-Native Issue Tracking

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

Welcome to Beads! This repository uses **Beads** for issue tracking - a modern, AI-native tool designed to live directly in your codebase alongside your code.

## What is Beads?

Beads is issue tracking that lives in your repo, making it perfect for AI coding agents and developers who want their issues close to their code. No web UI required - everything works through the CLI and integrates seamlessly with git.

**Learn more:** [github.com/steveyegge/beads](https://github.com/steveyegge/beads)

## Quick Start

### Essential Commands

```bash
# Create new issues
bd create "Add user authentication"

# View all issues
bd list

# View issue details
bd show <issue-id>

# Update issue status
bd update <issue-id> --claim
bd update <issue-id> --status done

# Sync with Dolt remote
bd dolt push
```

### Working with Issues

Issues in Beads are:
- **Git-native**: Stored in Dolt database with version control and branching
- **AI-friendly**: CLI-first design works perfectly with AI coding agents
- **Branch-aware**: Issues can follow your branch workflow
- **Always in sync**: Auto-syncs with your commits

## Why Beads?

✨ **AI-Native Design**
- Built specifically for AI-assisted development workflows
- CLI-first interface works seamlessly with AI coding agents
- No context switching to web UIs

🚀 **Developer Focused**
- Issues live in your repo, right next to your code
- Works offline, syncs when you push
- Fast, lightweight, and stays out of your way

🔧 **Git Integration**
- Automatic sync with git commits
- Branch-aware issue tracking
- Dolt-native three-way merge resolution

## Get Started with Beads

Try Beads in your own projects:

```bash
# Install Beads
curl -sSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# Initialize in your repo
bd init

# Create your first issue
bd create "Try out Beads"
```

## Learn More

- **Documentation**: [github.com/steveyegge/beads/docs](https://github.com/steveyegge/beads/tree/main/docs)
- **Quick Start Guide**: Run `bd quickstart`
- **Examples**: [github.com/steveyegge/beads/examples](https://github.com/steveyegge/beads/tree/main/examples)

---

*Beads: Issue tracking that moves at the speed of thought* ⚡
