# Pi Project Template

Drop the `agent-wiki/` folder into any project to give Pi your work style.
One self-contained folder — no scattering. The agent will think before
acting, challenge you, verify its work, research instead of guessing, and
systematically build out a wiki that represents the project.

## What's included (all inside `agent-wiki/`)

| Path | Purpose |
|------|---------|
| `bootstrap/AGENTS.md` | Project protocol skeleton — agent fills in, then copies to `./AGENTS.md` |
| `bootstrap/APPEND_SYSTEM.md` | 5 non-negotiable behavioral rules — agent copies to `.pi/APPEND_SYSTEM.md` |
| `discipline/` | 6 detailed discipline pages (think-before-acting, TDD, strong-opinions, verify, research, wiki-maintenance) |
| `index.md` | Wiki catalog — agent populates with your project's concepts |
| `log.md` | Append-only history of all wiki operations |
| `archive/index.md` | Graveyard for retired concepts |
| `scripts/wiki-lint.ts` | Mechanical wiki health checker (broken links, orphans, staleness) |

## The 5 golden rules

1. **Think before acting** — 4-phase protocol: understand, investigate,
   analyze, present for approval. Never mutate without a plan.
2. **TDD** — Red-Green-Refactor. Tests pass before work is done.
3. **Strong opinions, loosely held** — Challenge the founder and yourself.
   Change your mind with evidence.
4. **Verify, don't assume** — Confirm every operation succeeded. Never
   report "done" without checking.
5. **Research, don't guess** — Training data is a starting point, not a
   source. Read actual docs.

## How to install

### Step 1: Copy the folder

```bash
# From the template repo, copy agent-wiki into your project
cp -r /path/to/template/agent-wiki ./agent-wiki

# Commit the raw template (bootstrap files aren't installed yet)
git add agent-wiki/
git commit -m "Add agent-wiki template (bootstrap pending)"
```

### Step 2: Run the bootstrap prompt

Paste this prompt into a Pi session. The agent audits your project, fills
in all TODO blocks, creates wiki pages for every key concept, then asks
your approval before copying bootstrap files to their final homes.

```text
I've dropped the agent-wiki template into this project. I need you to audit
the project and populate everything. Follow the think-before-acting protocol.

## Phase 1–3: Investigate and analyze (no edits yet)

1. Read the entire project tree — package.json (or equivalent), build
   configs, CI files, top-level README, directory structure.

2. Identify:
   - What this project does (one paragraph)
   - The tech stack (language, framework, database, key dependencies)
   - Build, test, lint, and deploy commands
   - Storage rules — where does state live? What's ephemeral vs durable?
   - The 5-10 most important abstractions / patterns / concepts that
     someone working on this codebase needs to understand. For each: what
     it is, where it lives in the code, why it exists.
   - Any existing documentation that should be linked or subsumed

3. Present your findings as a structured audit. Include:
   - Proposed AGENTS.md content (project overview, dev workflow, storage
     rules, quick reference)
   - Proposed tdd.md fill-in (test locations, commands)
   - Proposed wiki page list — one page per key concept, with suggested
     categories and a one-line description
   - Proposed agent-wiki/index.md updates (categories + page list)

Wait for my approval before making any changes.

## Phase 4: Populate (after I approve)

1. Fill in all `<!-- TODO -->` blocks in `agent-wiki/bootstrap/AGENTS.md`
   and `agent-wiki/discipline/tdd.md`.

2. Create each wiki page following the conventions in
   `agent-wiki/discipline/wiki-maintenance.md`:
   - 200-500 words, self-contained
   - First sentence names the concept + code location
   - Cross-reference related pages
   - `> **Status:** evolving` footer
   - `> **Last updated:**` footer

3. Update `agent-wiki/index.md` with all new pages under appropriate
   categories.

4. Append an `ingest` entry to `agent-wiki/log.md` for each new page.

5. Run `tsx agent-wiki/scripts/wiki-lint.ts --full` and fix any findings.

6. Report: pages created, AGENTS.md sections filled, lint result. Then
   ask: "Bootstrap files are populated in agent-wiki/bootstrap/. Ready to
   install them to their final homes?"

## Phase 5: Install (after I approve the final copy)

1. Copy `agent-wiki/bootstrap/AGENTS.md` → `./AGENTS.md`
2. Copy `agent-wiki/bootstrap/APPEND_SYSTEM.md` → `.pi/APPEND_SYSTEM.md`

Report: files installed, paths confirmed.
```

### What the agent produces

- **`./AGENTS.md`** — project overview, dev workflow (with real commands),
  storage rules, tool discipline, quick reference table
- **`.pi/APPEND_SYSTEM.md`** — 5 golden rules, referencing your wiki pages
- **`agent-wiki/discipline/tdd.md`** — test file locations, test runner
  commands, integration test setup, preflight hooks
- **`agent-wiki/index.md`** — populated with your project's categories
  and pages
- **Wiki pages** — one per key concept (architecture, patterns, operations,
  domain models, etc.)
- **`agent-wiki/log.md`** — `ingest` entries for every new page

### Approval gates

The agent won't touch your project without permission:

| Gate | What happens |
|------|-------------|
| After audit | Agent presents findings. You approve or course-correct. |
| After populate | Agent reports what was created. You review pages before files leave `agent-wiki/bootstrap/`. |
| Final install | Agent copies bootstrap files to `./AGENTS.md` and `.pi/APPEND_SYSTEM.md` only after you say yes. |

### How long it takes

2-4 turns for a medium project. One turn to investigate and present
findings, one or two to create pages, one to install.

## How the wiki grows

The agent maintains the wiki following the Karpathy LLM Wiki pattern:

- **New concept → new page** (200-500 words, cross-referenced, added to
  index, logged, marked evolving)
- **Changed concept → updated page** (footer updated, logged)
- **Retired concept → archived** (moved to archive, removed from index)

You don't need to manage the wiki — the agent does it as part of every
change. Your role: review the wiki during PRs, same as code.

## Wiring up wiki lint (optional)

Add to your `package.json`:

```json
{
  "scripts": {
    "wiki:lint": "tsx agent-wiki/scripts/wiki-lint.ts",
    "wiki:lint:full": "tsx agent-wiki/scripts/wiki-lint.ts --full"
  }
}
```

Run manually: `pnpm wiki:lint` or `npm run wiki:lint`.

## Customizing

- **Behavioral rules:** `.pi/APPEND_SYSTEM.md` (after install) is the
  non-negotiable core. Edit only if a rule truly doesn't apply (rare).
- **Project conventions:** `./AGENTS.md` (after install) is yours. The
  template provides the skeleton; add your project's specifics.
- **Wiki categories:** `agent-wiki/index.md` starts with Discipline. Add
  Architecture, Operations, Patterns, or whatever suits your project.
- **Test conventions:** `agent-wiki/discipline/tdd.md` has a TODO block
  for your project's test locations and commands.
