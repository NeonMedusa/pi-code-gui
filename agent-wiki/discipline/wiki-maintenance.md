# Wiki Maintenance

> **Status:** stable

> Companion to AGENTS.md §"Wiki Maintenance"

The project wiki follows the LLM Wiki pattern (Karpathy, 2025 —
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): three
layers, three operations. Every code change that touches a documented
concept must update the wiki in the same PR.

## Three-layer architecture

| Layer           | What                                                    | Location         | Updated by        |
| --------------- | ------------------------------------------------------- | ---------------- | ----------------- |
| **Raw sources** | Code, tests, schemas, CLI output, API responses         | Source tree      | Implementation    |
| **Wiki**        | LLM-readable prose, interlinked, 200-500 words per page | `agent-wiki/`    | Agent (this rule) |
| **Schema**      | Type-level truth: type definitions, DDL, validation     | Type files       | Compiler          |

The wiki sits between raw sources and schema — it explains the _why_ and
the _how they compose_ that neither code comments nor type definitions capture.
Raw sources are ground truth; the wiki is the narrative layer that makes
ground truth navigable. Schema is machine-verified; the wiki is human-verified.

## Three operations

### 1. Ingest

When new concepts enter the codebase (a new abstraction, a new pattern, a
new policy), create a wiki page:

- 200-500 words, self-contained
- First sentence names the concept + code location
- Cross-reference related pages
- Add to `agent-wiki/index.md` under the appropriate category
- Append to `agent-wiki/log.md`: `## [YYYY-MM-DD] ingest | <concept>`
- Mark as `> **Status:** evolving` until proven stable

### 2. Update

When code changes a concept the wiki documents:

- Update the affected page(s) before the change is committed
- Update the page's `> **Last updated:**` footer: `YYYY-MM-DD — <change summary>`
- Append to `agent-wiki/log.md`: `## [YYYY-MM-DD] update | <summary>`
- If the concept is removed, move its page to `agent-wiki/archive/` and
  remove from index.md

### 3. Lint

Run during any review:

**Broken links:** `grep -rn '](.*\.md)' agent-wiki/` and verify every
target exists. Fix or flag.

**Stale pages:** `find agent-wiki -name '*.md' -mtime +90` — pages
untouched for 90+ days. Review for currency.

**Orphan pages:** Pages with no inbound links from other wiki pages.
Either cross-reference them from a relevant page, merge into a parent
topic, or archive.

**Status rotation:** Pages still `evolving` after surviving a production
deployment should be promoted to `stable`.

## Page conventions

Every wiki page follows this structure:

```markdown
# Page Title

> **Status:** stable | evolving | deprecated

[Body: 200-500 words, self-contained, cross-referenced. First sentence
names the concept + code location.]

## Section headings as needed

## Related

- [Related Page A](example-page-a.md) — one-line description
- [Related Page B](example-page-b.md) — one-line description

> **Last updated:** YYYY-MM-DD — <change reference>
```

### Status meanings

| Status       | Meaning                             | When to use                                                   |
| ------------ | ----------------------------------- | ------------------------------------------------------------- |
| `stable`     | Concept is proven, page is current  | Default for long-standing primitives, patterns, and policies  |
| `evolving`   | Concept is new or actively changing | New ingest, active feature in progress, pre-production        |
| `deprecated` | Concept is retired or superseded    | Move to `agent-wiki/archive/` within 30 days                  |

## log.md format

`agent-wiki/log.md` is an append-only chronological record. Every entry:

```
## [YYYY-MM-DD] <action> | <description>
```

Actions: `ingest` (new page), `update` (existing page changed), `lint`
(quality pass), `archive` (page moved to archive).

View recent activity: `grep "^## \[" agent-wiki/log.md | tail -5`

## Archive policy

When a concept is retired:

1. Move the page to `agent-wiki/archive/<original-path>.md`
2. Remove from `agent-wiki/index.md`
3. Append to `agent-wiki/log.md`: `## [YYYY-MM-DD] archive | <concept> — moved to archive/<path>`
4. Archive pages are kept indefinitely for historical reference
5. The `agent-wiki/archive/` directory has its own `index.md` catalog

## Mechanical enforcement (optional)

If your project has a test runner, consider adding a wiki lint script.
The template includes `scripts/wiki-lint.ts` as a starting point — it
enforces:

| Check | Mode | Blocks |
|-------|------|--------|
| Broken internal `](*.md)` links | Fast (preflight) | Recommended for commits |
| Missing `Status:` or `Last updated:` footers | Fast (preflight) | Recommended for commits |
| Orphan pages (no inbound links) | Full (CI) | Recommended for deploys |
| Stale pages (90+ days untouched) | Full (CI) | Recommended for deploys |
| Status rotation (evolving for 90+ days) | Full (CI) | Recommended for deploys |

Wire it into your project: `tsx scripts/wiki-lint.ts` (fast) or
`tsx scripts/wiki-lint.ts --full` (all checks).

## Related

- [Think Before Acting](think-before-acting.md) — Phase 2 investigation includes wiki review
- [TDD](tdd.md) — wiki updates are part of the refactor phase

> **Last updated:** 2026-05-15 — extracted from NimbleTron, genericized for template
