# TDD (Test-Driven Development)

> **Status:** stable

> Companion to `.pi/APPEND_SYSTEM.md` §"TDD"

After the founder approves your implementation plan, follow TDD.

## Red-Green-Refactor

1. **Red** — write tests for the behavior you're about to add or change.
   The test should fail because the behavior doesn't exist yet.

2. **Green** — implement the change. Run the project's test suite and
   fix failures. The new test + all existing tests must pass.

3. **Refactor** — clean up while tests stay green. Improve naming, extract
   helpers, reduce duplication. Tests protect against regressions.

Before presenting work as done, the project's test suite must pass.

## Project test conventions

- **Test locations:** `src/test/**/*.test.ts` — currently a single skeleton test
  (`src/test/extension.test.ts`). Tests compile to `out/test/`.
- **Test runner:** `@vscode/test-cli` + `@vscode/test-electron` (`pnpm test`).
  Launches the Extension Development Host to run tests in a VS Code environment.
- **Running a single file:** Not configured — `vscode-test` runs all files matching
  `out/test/**/*.test.js` (set in `.vscode-test.mjs`).
- **Integration tests:** VS Code Extension Dev Host is the integration environment.
  Tests interact with real VS Code APIs. `@vscode/test-electron` downloads a
  portable VS Code for CI.
- **Preflight:** `pnpm run pretest` → compile-tests + compile + lint. Runs before
  `pnpm test` and in CI (`publish.yml`).
- **Coverage note:** Current test coverage is minimal (boilerplate only). The
  extension is validated primarily through manual testing in the Extension Dev
  Host (`F5`) and production usage. When adding test coverage, prefer:
  - Unit tests for PiService event translation logic
  - Integration tests for bridge tool execution
  - Webview tests via the VS Code webview test framework

## Untested code

If the code you're changing has no existing test coverage, stop and present
the founder with two options:

- **BUILD inline** — add tests for the changed behavior as part of this change.
  Scope tests to the changed behavior only.
- **TRACK it later** — proceed without tests now; create a follow-up task
  for test coverage.

Wait for the founder to choose. Do not silently skip tests, and do not
silently add full module coverage beyond the scope of the change.

## When to stop and ask

- **No existing test file** — the module has zero test coverage
- **Fixture complexity** — the test needs complex setup that's non-trivial
- **Flaky test investigation** — a pre-existing test fails intermittently
  and you're not sure if your change caused it

## Related

- [Think Before Acting](think-before-acting.md) — the plan phase before TDD
- [Verify, Don't Assume](verify-dont-assume.md) — what "tests pass" actually means

> **Last updated:** 2026-05-15 — extracted from NimbleTron, genericized for template
