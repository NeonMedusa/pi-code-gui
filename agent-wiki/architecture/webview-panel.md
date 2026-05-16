# Webview Panel

> **Status:** stable

PiWebviewPanel (`src/webview-panel.ts`) manages a single VS Code webview chat
panel — the visual UI that the user interacts with. Each `SessionWindow` owns
one PiWebviewPanel, which renders streaming responses, thinking blocks, tool
execution results, bash output, and custom messages.

## Why it exists

The webview panel is the entire user-facing chat experience. It handles HTML/CSS/JS
rendering, bidirectional messaging with the extension host, tab title indicators
(streaming/idle/init), and user interactions (send prompt, abort, settings toggles,
model/thinking pickers). Separating panel logic from PiService keeps rendering
concerns out of the SDK bridge.

## Architecture

**Content delivery:** `getWebviewContent()` builds a complete HTML document with
a `<link>` to `media/style.css` and a single script reference to `media/bundle.js`. The bundle is
built by esbuild from the TypeScript modules in `src/webview/` (state, debug,
render engine, tools, handlers, and main entry).

**Message protocol:** Two typed channels:

1. **Webview → Extension** (via `onDidReceiveMessage`): prompt submission,
   abort, settings toggles, model/thinking pickers, slash commands, URL/file
   open requests, user message history requests, and queue operations.
   Typed as `WebviewToExtension` from `src/shared/protocol.ts`.

2. **Extension → Webview** (via `postMessage`): streaming deltas
   (`stream-delta`, `thinking-delta`), tool lifecycle events, bash output,
   status updates, settings state, user message lists, slash command lists,
   and errors.
   Typed as `ExtensionToWebview` from `src/shared/protocol.ts`.

**Tab indicators:** `updateTabIndicator()` sets the webview panel title with
`●` (streaming) or `○` (idle) prefix, plus the session name (AI-generated
summary, stored session name, or fallback label).

**Slash commands:** `handleSlashCommand()` intercepts builtin commands (`/login`,
`/logout`, `/model`, `/thinking`, `/sessions`, `/settings`) and forwards unknown
commands to the Pi session for extension handling.

## Related

- [PiService](pi-service.md) — the SDK bridge that feeds events to the panel
- [Webview Frontend](webview-frontend.md) — the TypeScript modules that run inside the webview
- [Session Window](session-window.md) — the pairing that owns this panel

> **Last updated:** 2026-05-16 — update for single-bundle loading and typed protocol
