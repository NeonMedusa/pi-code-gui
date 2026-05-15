# Webview Frontend

> **Status:** evolving

The Webview Frontend (`media/` directory — `app.js`, `core.js`, `tools.js`,
`morphdom.js`, `marked.min.js`) is the chat UI running inside each VS Code
webview panel. It renders streaming responses, thinking blocks, tool execution
results, bash output, code blocks, and extension widgets in real time.

## Why it exists

The Pi webview is not a static HTML page — it's a live application that
handles streaming token-diffs, collapsible thinking blocks, expandable tool
results, syntax-highlighted code blocks, slash command autocomplete, user
message history recall, settings toggles, and queue/steer UI. This complexity
demands a modular client-side architecture.

## Module breakdown

| File | Purpose |
|------|---------|
| `morphdom.js` | Efficient DOM diffing/patching library. Used to re-render only changed elements during streaming instead of rebuilding the entire chat container. |
| `marked.min.js` | GFM-compliant Markdown parser. Replaced custom regex rendering to correctly handle tables, nested lists, blockquotes, and code blocks. |
| `core.js` | Core chat logic: message rendering (user/assistant/custom), thinking blocks with collapse/expand and gradient fade, token-diff streaming, auto-scroll with pause-on-manual-scroll, quickstart guide, welcome screen, live panel rendering, batch replay mode. |
| `tools.js` | Tool execution rendering: tool blocks with headers (name, status, duration), collapsible results with show-more overflow, code block rendering with syntax highlighting and line numbers, diff rendering (added/removed lines), edit previews, bash execution blocks with output, file-path clickability that opens the file in VS Code, and compact labels for read operations. |
| `app.js` | Application glue: VS Code API binding (`acquireVsCodeApi`), message dispatch, input handling (Enter/Shift+Enter, up-arrow history, slash command autocomplete), attachment bar, settings overlay, user message selector modal, status bar rendering (model, thinking, effort, usage, budget), queue/steer split button, abort button, and live panel card management. |

## Key rendering patterns

- **Token-diff streaming:** During streaming, only the last assistant message
  block is morph-dom updated — the rest is static. This avoids full re-renders
  on every token delta.
- **Batch replay:** On initial load, the chat container gets a `.no-animate`
  class so history messages render instantly without fade-in animations.
- **Thinking collapse:** Thinking blocks show a 10-line scrollable preview
  with a gradient fade. A "Show full thinking" button expands them.
- **Tool result collapse:** Long tool results get a `max-height` with a
  gradient overlay. "Show more" expands them; "Show less" collapses back.
- **Code syntax highlighting:** Code blocks are rendered with token-based
  CSS classes (`tok-kw`, `tok-str`, `tok-fn`, etc.) for VS Code theme-aligned
  colors.

## Related

- [Webview Panel](webview-panel.md) — the extension-host side that loads these files
- [Bridge Tools](bridge-tools.md) — tools whose results render here
- [Extension UI Bridge](extension-ui-bridge.md) — widgets that render as live cards

> **Last updated:** 2026-05-15 — initial documentation
