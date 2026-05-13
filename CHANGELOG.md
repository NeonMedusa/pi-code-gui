# Change Log

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
