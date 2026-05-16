# Webview Frontend

> **Status:** stable

The Webview Frontend is the chat UI running inside each VS Code webview panel.
It renders streaming responses, thinking blocks, tool execution results, bash
output, code blocks, and extension widgets in real time.

## Architecture

The frontend was rewritten from 3 monolithic vanilla-JS IIFE files into 6
TypeScript ES modules in `src/webview/`, bundled via esbuild to a single
`media/bundle.js`. CSS is in `media/style.css`, organized in `@layer tokens,
base, components` with native CSS nesting.

| File | Purpose |
|------|---------|
| `state.ts` | Single source of truth for all mutable state (DOM refs, boolean flags, tool tracking, overlays, slash commands). Auto-initializes DOM refs on import. |
| `debug.ts` | Debug logging infrastructure: event log, DOM mutation observer, `/debug` command. Exposes `window.__piDebug` for DevTools inspection. |
| `render/engine.ts` | All rendering functions: markdown parsing (marked), syntax highlighting (JS/Python/Rust/HTML/CSS/Shell/JSON/Java/Go), diff viewing, code block wrappers with line numbers and copy buttons, block-level streaming, tool result expandable display, DOM helpers (escapeHtml, createMessageEl, createThinkingBlock, createToolBlock, morphRender). |
| `tools/index.ts` | Tool renderers for write/edit/read/bash operations. Each renderer handles the create→update→finalize lifecycle. Registers itself with the tool renderer registry on import. |
| `handlers/index.ts` | Message router (window.addEventListener) dispatching 30+ event types: agent lifecycle, stream deltas, thinking deltas, tool execution, status updates, batch replay, compaction, auto-retry, slash commands, widget bridge, errors, user commands. Also contains all UI wiring (input area, status bar, settings overlay, slash autocomplete). |
| `main.ts` | Entry point. Acquires VS Code API, initializes debug observer, sets up code block handlers, scroll tracking. |

## Build pipeline

```
src/webview/*.ts  ──esbuild──►  media/bundle.js  ──<script>──►  webview HTML
     ↑                              ↑
     └── imports from state.ts,     └── loaded by webview-panel.ts
         debug.ts, engine.ts            via getWebviewContent()
```

`media/entry.js` is a 3-line shim that imports `morphdom.js`, `marked.min.js`,
and `main.ts` in order. esbuild bundles everything into a single IIFE.

## External dependencies

- **morphdom** (`media/lib/morphdom.js`) — efficient DOM diffing/patching.
- **marked** (`media/marked.min.js`) — GFM-compliant Markdown parser.
  Both are loaded as globals before the app bundle.

## Type safety

Message types are defined in `src/shared/protocol.ts` as discriminated unions:
- `ExtensionToWebview` — 30+ event types from extension to webview
- `WebviewToExtension` — 16 command types from webview to extension

The `postMessage` bridge in `webview-panel.ts` is typed as
`ExtensionToWebview | WebviewToExtension`, catching shape mismatches at
compile time.

## Key rendering patterns

- **Token-diff streaming:** During streaming, only the last assistant message
  block is morphdom-updated — the rest is static. This avoids full re-renders
  on every token delta.
- **Batch replay:** On initial load, the chat container gets a `.no-animate`
  class so history messages render instantly without fade-in animations.
- **Thinking collapse:** Thinking blocks show a scrollable preview with a
  gradient fade. A "Show more" button expands them.
- **Tool result collapse:** Long tool results get a `max-height` with a
  gradient overlay. "Show more" expands them; "Show less" collapses back.
- **Code syntax highlighting:** Code blocks are rendered with token-based
  CSS classes (`tok-kw`, `tok-str`, `tok-fn`, etc.) for VS Code theme-aligned
  colors.

## Related

- [Webview Panel](webview-panel.md) — the extension-host side that loads the bundle
- [Bridge Tools](bridge-tools.md) — tools whose results render here
- [Extension UI Bridge](extension-ui-bridge.md) — widgets that render as live cards
- [Webview Rewrite Plan](../archive/webview-rewrite-plan.md) — the 5-step migration plan (completed, archived)

> **Last updated:** 2026-05-16 — update for TS module rewrite
