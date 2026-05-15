# Verify, Don't Assume

> **Status:** stable

> Companion to `.pi/APPEND_SYSTEM.md` §"Verify, Don't Assume"

Before presenting any operation as successful, confirm it actually succeeded.
Never assume — always check.

## Verify your operations

### Bash commands
- Check exit code 0 AND no unexpected error text
- Don't skip stderr because stdout looks right
- Don't parse success from a response that also contains a failure

### API calls
- Check HTTP 2xx AND the success field in the response body
- Many APIs return 200 with an error payload — always check the success
  indicator before consuming the data
- Know your API's error convention: `{ok: false}`, `{error: ...}`, status
  codes, etc.

### File operations
- After writing, read back the critical section
- Don't assume a file write succeeded without reading it back
- Check file size is non-zero before consuming

### Git operations
- Verify the expected SHA or branch state after commits/pushes
- `git log --oneline -1` to confirm the commit landed
- After push, verify the remote accepted it

### State changes
- Confirm the new state matches expectations
- Read back any persisted state after writing it
- Don't rely on the write operation's return value alone

## Error handling in code you write

Every function touching external systems (API, filesystem, DB) must handle
both expected and unexpected errors:

### Expected errors
Network timeouts, API 4xx, file-not-found, validation failures. Catch, log,
surface to caller with a typed error. Use typed error conventions where
available.

### Unexpected errors
Catch-all at module boundaries. Never let an unhandled exception crash silently.
Log with diagnostic context (what operation, what inputs, what state).

### Never swallow
Do not catch and return `null`/`undefined` without logging. Do not replace a
specific error with a generic "something went wrong." The original error
carries diagnostic information that the caller needs.

### Fail loudly
If you can't handle it, propagate the original error intact. Silent failures
are the hardest bugs to find. An unhandled exception that crashes with a
stack trace is better than a swallowed error that produces subtly wrong results.

## API response verification recipe

```typescript
const res = await fetch(url, { ... });
if (!res.ok) {
  // HTTP-level failure (4xx, 5xx)
  throw new Error(`Request failed: ${res.status}`);
}
const body = await res.json();
if (!body.ok) {
  // Application-level failure — check your API's convention
  throw new Error(`Request denied: ${body.error.kind} - ${body.error.message}`);
}
// body.data is the typed success payload
```

## Common failure modes

- **`{ok: false}` in API responses** — the API returned 200 but the operation
  was denied. Always check the success indicator before consuming `data`.
- **Mixed stdout/stderr** — a bash command succeeded (exit 0) but stderr
  contains warnings that indicate partial failure.
- **Silent file truncation** — the file was written but disk full / quota
  hit mid-write. The file exists but is incomplete.
- **Git push rejected** — `git push` exit code 0 but the remote rejected
  the push (non-fast-forward). Check the output for `[rejected]`.

## Related

- [TDD](tdd.md) — tests as the primary verification mechanism
- [Research, Don't Guess](research-dont-guess.md) — verification vs assumption in research

> **Last updated:** 2026-05-15 — extracted from NimbleTron, genericized for template
