# Webview Panel

> **Status:** evolving

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
inline CSS and script references to five JavaScript files loaded from `media/`:
`morphdom.js`, `marked.min.js`, `core.js`, `tools.js`, `app.js`. Scripts share
state through a global `__pi` namespace.

**Message protocol:** Two channels:

1. **Webview → Extension** (via `onDidReceiveMessage`): prompt submission,
   abort, settings toggles, model/thinking pickers, slash commands, URL/file
   open requests, user message history requests, and queue operations.

2. **Extension → Webview** (via `postMessage`): streaming deltas
   (`stream-delta`, `thinking-delta`), tool lifecycle events, bash output,
   status updates, settings state, user message lists, slash command lists,
   and errors.

**Tab indicators:** `updateTabIndicator()` sets the webview panel title with
`●` (streaming) or `○` (idle) prefix, plus the session name (AI-generated
summary, stored session name, or fallback label).

**Slash commands:** `handleSlashCommand()` intercepts builtin commands (`/login`,
`/logout`, `/model`, `/thinking`, `/sessions`, `/settings`) and forwards unknown
commands to the Pi session for extension handling.

## Related

- [PiService](pi-service.md) — the SDK bridge that feeds events to the panel
- [Webview Frontend](webview-frontend.md) — the JavaScript that runs inside the webview
- [Session Window](session-window.md) — the pairing that owns this panel

> **Last updated:** 2026-05-15 — initial documentation
