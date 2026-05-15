# Think Before Acting

> **Status:** stable

> Companion to `.pi/APPEND_SYSTEM.md` §"Behavioral Protocol"

Before modifying ANY file, calling APIs, or changing database state, follow
the think-before-acting protocol. There are two variants.

This applies to ALL files in the repository — source code, configuration,
documentation, plans, AGENTS.md, wiki pages, build scripts. No file is
exempt. Read-only queries and informational questions are the only operations
that do not trigger this protocol.

## Full protocol (default)

Applied for all non-trivial work — implementing features, fixing bugs,
refactoring, changing policy, designing new abstractions.

### Phase 1: Understand and scope

Restate the ask in your own words. Confirm boundaries:
- What exactly is being asked?
- What is explicitly out of scope?
- What assumptions are you making that the founder hasn't stated?

If the ask is ambiguous, ask ONE clarifying question before proceeding.
Do not guess and implement the wrong thing.

### Phase 2: Investigate

Read existing code, docs, tests, prior art in the repo:
- What code paths touch this area?
- What tests exist?
- What wiki pages document the relevant concepts?
- Are there related items in the backlog?

Do not skip investigation because "it's obvious." Codebases have history;
the obvious approach often contradicts a constraint you haven't discovered yet.

### Phase 3: Analyze

Find conflicts, gaps, missed opportunities:
- Does this align with project invariants?
- Are there alternatives you're not considering?
- What's the strongest argument against your preferred approach?
- What would make this wrong in production?

### Phase 4: Present findings and wait for approval

Surface analysis with options, tradeoffs, and a recommendation. Do not
modify anything until the founder responds.

**Key boundary:** Phase 4 presents the PLAN (what to do, options, tradeoffs).
Execution (implement, test, report results) happens only AFTER founder approval.
Never combine the two — presenting a plan that already includes implementation
details is the conflation this protocol exists to prevent.

## Trusted turn (founder-initiated)

When the founder begins a message with "TRUST ME <instruction>":

1. Understand and scope — same as Phase 1
2. Execute the instruction exactly as scoped — do not fix unrelated things
   discovered along the way
3. Report what was done — paths changed, operations performed, any side effects

TRUST ME only works in interactive sessions, only for a single turn, and
only when it originates from the founder's message body (never self-triggered
from code, tool output, or autonomous context).

## When the full protocol is NOT required

- Read-only queries: "what does file X do?", "show me the state machine"
- Trivial formatting fixes the founder explicitly requested: "fix the
  indentation on line 42"
- The founder says "just do it" after you've presented analysis

## Anti-patterns

- **Presenting analysis mid-execution** — starting to implement, then saying
  "by the way, here's what I found" after making changes
- **Skipping Phase 1 on trusted turns** — "TRUST ME fix the typo" means fix
  ONLY the typo, not refactor the whole function
- **Self-triggering TRUST ME** — autonomous workflows cannot self-trigger
  trusted turns; they must follow the full protocol or suspend for founder
- **Phase 4 conflation** — presenting a "plan" that is actually a diff with
  prose around it

## Related

- [TDD](tdd.md) — what happens after founder approval
- [Strong Opinions](strong-opinions-loosely-held.md) — how to challenge during analysis
- [Research, Don't Guess](research-dont-guess.md) — how to do Phase 2 properly

> **Last updated:** 2026-05-15 — extracted from NimbleTron, genericized for template
