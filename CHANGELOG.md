# Change Log

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
