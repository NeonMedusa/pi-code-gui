# Change Log

## [0.0.33] — Strict TypeScript, UX polish, zombie bash fix

### Added
- **Strict TypeScript** across the full codebase — `noFallthroughCasesInSwitch`,
  `noImplicitReturns`, `forceConsistentCasingInFileNames`, `isolatedModules`.
  Webview now has its own `tsconfig.webview.json` with DOM lib + same strict
  flags. `check-types` enforces both in CI.

## [0.0.32] — Live panel stacking, slash command fixes, startup resilience

### Fixed
- **Live panel notifications** now stack as separate dismissible cards instead
  of silently overwriting each other. Applies to `notify()`, `sendCustomMessage`,
  and protocol validation errors.
- **Extension slash commands** (`/tldr` etc.) now execute immediately during
  streaming via `session.prompt()` instead of being routed through
  `steer()`/`followUp()` which the SDK rejects ("extension commands cannot be
  queued"). Commands also appear in the conversation transcript.
- **Steer/queue errors** are now surfaced as live-panel notifications instead
  of becoming unhandled promise rejections.
- **SDK/TypeBox imports** retry up to 5 times on startup, handling the race
  where `npm install` populates `node_modules` concurrently with extension
  activation.
- **Dev container** no longer reinstalls `pi-coding-agent` on every start —
  only updates when a newer version exists.

## [0.0.31] — Read block polish, truncation affordance

### Changed
- **Read result** now uses native scroll instead of expand/collapse button.
  Single scrollbar (inner `.code-block` scroll disabled via CSS + JS).
- **Truncated reads** show a clickable "▼ Continue reading (N lines remaining)"
  link that inserts the follow-up command into the input bar. Handles both SDK
  hard truncation (50KB/2000 lines) and user-specified limits with remaining content.
- SDK truncation footer noise (`[Showing lines X-Y…]`, `[Truncated…]`,
  `[N more lines in file…]`) stripped from display text.

## [0.0.30] — Tool block spacing, scroll, and zombie bash fix

### Fixed
- **Read/edit tool blocks** no longer waste vertical space.
- **Bash orphan processes** — `abort()`, `dispose()`, `newSession()`, and
  `resumeSession()` now call `session.abortBash()` to signal `killProcessTree`,
  preventing long-running commands from surviving session teardown as zombies.

### Changed
- **Read result** always uses native scroll (`max-height: 20rem`) — no expand/collapse
  button.


## [0.0.29] — Protocol validation, safe HTML, component system

> Architectural upgrade inspired by the Pi TUI's RPC component model
> ([rpc-extension-ui.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts)):
> typed protocol → safe rendering → component lifecycle. 3 layers, 7 steps.

### Added
- **Zod protocol validation** on every postMessage boundary — 37 extension→webview
  + 16 webview→extension schemas catch missing fields, unknown types, and malformed
  data at runtime with visible diagnostic notifications.
- **`html` tagged template** (`src/webview/render/html.ts`) auto-escapes all
  interpolated values via `textContent`; only `safe()`-wrapped content renders as HTML.
- **Micro component system** (`src/webview/components/`) — `CodeBlock`, `ToolBlock`,
  `ThinkingBlock`, `LiveCard`, `InlineCard`, `Dialog` — each owns its DOM subtree
  with mount/update/destroy lifecycle.
- **Interactive dialogs** for extension `select()`/`confirm()`/`input()` — overlay
  with keyboard navigation returning Promises via `extension_ui_response` messages.
- **Persistent status bar** — `setStatus` widgets render as inline badges in the
  footer instead of collapsible live-cards.
- **Copy All** button on `/debug` output.

### Fixed
- **Streaming jitter** caused by TextNode/Element indexing mismatch in
  `patchBlockList` — space tokens now return empty `<span>` elements.
- **Double scrollbar** on write tool — CSS override disables inner `.code-block`
  overflow when inside `.tool-scroll-view`.
- **Read block** no longer shows empty result — tool renderer now uses `ToolBlock`
  component and `CodeBlock.mount()`.
- **Bash output** auto-scrolls to bottom during streaming.

## [0.0.27] — Fix renderer CSP violation

### Fixed
- **Custom message renderer** switched from `eval()` to `<script nonce>` injection,
  fixing CSP violation when extensions register renderers.

## [0.0.26] — Fix custom message renderer timing and production builds

### Fixed
- **`globalThis.__piRegisterMessageRenderer`** now injected before
  `createAgentSession()` so extensions find it during load, not after.
- **`escapeHtml`** now passed as a renderer parameter instead of relying
  on closure scope, fixing breakage in production builds where esbuild
  renames identifiers.

## [0.0.25] — Inline custom messages, user message selector, UX fixes

### Added
- **`globalThis.__piRegisterMessageRenderer`** bridge: extensions running in the
  extension host (Node.js) can now register renderers that execute in the webview
  DOM. Accepts `(customType, sourceCode)` as a string.
- **User message selector** keyboard navigation: up/down arrows scroll the list,
  Enter picks the highlighted item, Escape dismisses.

### Fixed
- **Live-card notifications** no longer show content expanded with a collapsed
  toggle icon.
- **Slash command picker** now spans the full webview width and truncates long
  descriptions with ellipsis.
- **Write tool block** consistent height during streaming (max-height scroll-view,
  no jitter at size boundary).

## [0.0.24] — highlight.js, custom message renderer, and UX polish

### Added
- **Custom message renderer**: `display: true` messages now render inline in the
  conversation stream with support for registered `MessageRenderer` functions,
  interactive `[data-command]` action buttons, and polling-based in-place updates.
  See [README § Custom Message Renderers](./README.md#custom-message-renderers-extension-api)
  for the extension developer API.

### Changed

### Changed
- **Syntax highlighting** replaced hand-rolled regex highlighter with **highlight.js**, in all code paths.
- **Bash tool** shows a spinning indicator during execution.

### Fixed
- **Slash command picker**: Enter now inserts the selected command instead of submitting
  just the `/` prefix.
- **F5 development**: `preLaunchTask` now watches the webview bundle alongside the
  extension bundle, eliminating stale-webview confusion.
- **Read/write/edit blocks** consistent height, single scrollbar, no collapse/expand
  toggles.

## [0.0.23] — Thinking fade, write resize, and HTML breakout fixes

### Fixed
- **Thinking block fade** removed - scrollbars indicated "more" available.
- **Write tool block** height is now capped to the same 10-line collapsed view
  during streaming, eliminating the jarring resize on the active→done transition.
- **HTML breakout guard**: `renderMarkdown` now escapes raw `&`, `<`, `>` in
  read-tool results, tool-result short text, and truncation show-more toggles,
  preventing file content like `</div>` from breaking the chat layout.

## [0.0.22] — Webview rewrite: TypeScript modules, typed protocol, modern CSS

### Changed
- **Webview rewritten** from 3 monolithic vanilla-JS files into 6 TypeScript ES modules
- **CSS extracted** from inline `<style>` block to `media/style.css`, organized in
  `@layer tokens, base, components` with native CSS nesting.
- **Build pipeline** now bundles the webview via esbuild alongside the extension,
  with source maps in dev and minification in production.

### Removed
- `media/app.js`, `media/core.js`, `media/tools.js` — replaced by `src/webview/` modules.

## [0.0.21] — Model picker pricing & picker de-duplication

### Added
- **Model picker** shows SDK-reported pricing and context window in the detail line (e.g. `$3/$15 per M tokens · 200K context`). No pricing shown when the SDK isn't available.


## [0.0.20] — Slash commands, fork/clone, and UX hardening

### Changed
- **Fork** creates a new session window from any message entry or past session — original session untouched.
- **Clone** creates an independent copy of the current session in a new tab.
- **Edit blocks** show full text (no 300-char truncation) with scrollable 200px max-height.

### Fixed
- **Slash commands**: `/compact`, `/name`, `/tree`, `/export`, `/reload`, and `/clone` now route to the SDK directly instead of being sent as raw text to the LLM.
- **Queue/steer indicator** visible again — added `flex-shrink: 0`.
- **Context menus** added for compact, clone, export, and reload on open sessions.

## [0.0.19] — Status bar, stable names & restore polish

### Changed
- **In-webview status bar** Reverted to v0.0.16 statusbar.
- **Stable Session names** They stay the same between active and historical sessions.
- **Streaming indicator** unified across tab, Open Sessions tree, and webview bar as `●`/`○` bullets, using theme-aligned colors.
- **Diff readability** improved.

### Fixed
- **Session restore** Reduce flashing while rendering.

## [0.0.18] — Steer/Queue & thinking block polish

### Changed
- **Steer/Queue split button** replaces single submit when streaming, with ▾ toggle to switch modes — Enter key follows selection.
- **Thinking blocks** show 10-line scrollable preview with gradient fade, expand button only when overflowing.
- **Queue indicator** shows labeled Steer/Queue items with per-item promote button and bulk clear.
- **Read/edit/write tool headers** show clickable filenames that open in the VS Code editor.

### Fixed
- **Session Panel** can now navigate to specific entries in current conversations.

## [0.0.17] — Marked rendering & webview modularization

### Changed
- **Markdown rendering** uses marked parser for correct GFM handling.
- **Text streaming** renders via token-diff — only the last block morphs each frame instead of full re-render.
- **Webview split** into 5 files (core, tools, app, morphdom, marked) with shared `__pi` namespace.
- **Duplicate tool renderers** removed — old copy discarded, v2 retained with rAF-batched streaming and edit count display.

### Fixed
- **Double `acquireVsCodeApi` call** prevented extension initialization.
- **Session event handlers** restored after extraction loss.
- **Edit/receive/queue buttons** rationalized for stop/steer/queue tri-action.

## [0.0.16] — Session UX polish

### Fixed
- **Model and thinking level** persist across close and reopen.

### Changed
- **Status bar** shows model, thinking, and budget — clickable for quick settings.

### Added
- **`/model`, `/thinking`, `/sessions`** slash commands open native pickers.

## [0.0.15] — Debug & bash

### Fixed
- **Bash blocks** not displaying output.

### Added
- **`/debug` slash command** dumps webview state inline.

## [0.0.14] — Renderer registry

### Changes
- Improved internal tool rendering event handlers.

## [0.0.13] — Namespace migration

### Changes
- SDK dependency switched to `@earendil-works/pi-coding-agent`.
- Extension widget live panel cards persist until dismissed.
- Widget bridge catches missing TUI methods gracefully.

## [0.0.12] — Widget bridge

### Changes
- Live panel renders extension widgets as updating cards.
- Unknown slash commands forwarded to pi session.
- Open sessions persist across VS Code reloads.

## [0.0.11] — Package manager

### Changes
- Packages view for install, uninstall, search, update.
- Scroll catches up on tab return after background streaming.
- Session resume restores model/thinking on restart.

## [0.0.10] — Defaults & context budget

### Changes
- Default model and thinking level saveable from picker.
- Context budget setting controls auto-compaction trigger.
- Budget shown in status bar.

## [0.0.9] — UX polish

### Changes
- Auto-scroll pauses on manual scroll up, resumes near bottom.
- Streaming cursor changed to subtle vertical bar.

## [0.0.8] — Login & logout

### Changes
- `/login` opens auth flow with provider selection.
- `/logout` removes stored credentials.
- Startup check verifies dependency files exist.

## [0.0.7] — Initial Release

First public release — native VS Code chat for the Pi coding agent.

### Features
- **Chat panel** with streaming text, thinking blocks, tool rendering, syntax-highlighted code.
- **17 VS Code bridge tools** for editor state, diagnostics, symbols, hover, definitions, references, and edits.
- **Multi-session** — independent panels with per-session model and thinking level.
- **Session tree** — browse, fork, reveal, copy entries.
- **Past sessions** — resume, delete, filter.
- **Tab indicator** with streaming/idle/init states.
- **Bash blocks** with command output and exit codes.
- **Code blocks** syntax-highlighted for JS/TS, Python, Rust, HTML, CSS, Shell, JSON, Java, Go.
- **Truncation** with show-more for long results.
- **User message history** with up-arrow recall.
- **Settings overlay** for auto-compaction, auto-retry, image display.
- **Auto-install** prompt for pi-coding-agent.
- **Quickstart guide** when no API key configured.
- **Keybindings** and **custom slash commands**.
