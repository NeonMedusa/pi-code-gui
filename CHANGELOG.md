# Change Log

## [0.0.17] — Marked-based rendering & webview modularization

### Changed
- **Markdown rendering replaced with marked parser** 
- **Progressive block-level streaming** r
- **Webview modularized into 5 files** 
- **Thinking blocks collapsed by default** 

### Added
- **Clickable file names in tool headers** 

## [0.0.16] — Session UX polish

### Fixed
- **Model and thinking level persist when changed** — Setting them in a session now survives close and reopen.

## Changed
- **Status bar relocated to VSCode Status bar ** — Clickable settings for model, thinking levels, and session budget.

### Added
- **`/model` slash command** — opens the native VS Code model picker.
- **`/thinking` slash command** — opens the thinking level picker.
- **`/sessions` slash command** — focuses the Sessions sidebar.

## [0.0.15] — Webview debug infrastructure & bash block fixes

### Fixed
- **Bash blocks not visible or displaying contents **

### Added
- **`/debug` slash command**: Dumps structured webview state inline (chat DOM structure, tracker state, event log, DOM mutation log, duplicate/orphan analysis).

## [0.0.14] — Renderer registry & spacer fix

### Changes
- Improved internal rendering event handlers.

## [0.0.13] — Namespace migration & widget UI

### Changes
- Switched SDK dependency from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`
- Extension widget live panel: cards persist until dismissed, notifications collapse to single line
- Widget bridge: uiContext Proxy catches missing TUI methods gracefully, logs unknown calls
- Output Channel: quiet by default — only errors and unimplemented calls surface
- Devcontainer: installs `@earendil-works/pi-coding-agent`

## [0.0.12] — Widget bridge & live panel

### Changes
- Live panel: extension widgets (e.g. pi-tldr, pi-subagents) render as updating cards in chat
- Unknown slash commands forwarded to pi session so extensions can respond
- Open sessions persist across VS Code reloads
- Package marketplace: one-click install, banner images, rate-limited search
- Git URLs (git@, git+https) normalized before opening in browser

## [0.0.11] — Package manager & session fixes

### Changes
- New Packages view: install, uninstall, search, update pi packages from npm
- Scroll catches up on tab return after background streaming
- Session resume restores model/thinking on VS Code restart, not just manual open

## [0.0.10] — Default model, thinking & context budget

### Changes
- Default model & thinking level: save from picker, persist across sessions
- Context budget setting: control when auto-compaction triggers (100K–1M or model default)
- Budget shown in status bar; click to change

## [0.0.9] — UX polish

### Changes
- Auto-scroll stops when you scroll up; resumes when near bottom
- Streaming cursor changed from white square to subtle vertical bar

## [0.0.8] — Login & Logout

### Changes
- `/login` slash command — opens auth flow: pick OAuth or API key, choose provider
- `/logout` slash command — removes stored credentials for a selected provider
- OAuth providers open browser; API key providers prompt for key, saved to auth.json
- Startup install check verifies transitive dep files exist, not just the package dir
- Better error message when pi-ai can't find its bundled dependencies

## [0.0.7] — Initial Release

First public release of Pi Code Gui — a native VS Code editor experience for the Pi coding agent.

### Features
- **Chat panel** — streaming text, collapsible thinking blocks, tool call/result rendering, markdown with syntax-highlighted code blocks
- **17 VS Code bridge tools** — `vscode_get_editor_state`, `vscode_get_diagnostics`, `vscode_get_selection`, `vscode_get_hover`, `vscode_get_definitions`, `vscode_get_references`, `vscode_get_document_symbols`, `vscode_get_workspace_symbols`, `vscode_get_code_actions`, `vscode_get_open_editors`, `vscode_get_workspace_folders`, `vscode_open_file`, `vscode_check_document_dirty`, `vscode_save_document`, `vscode_apply_workspace_edit`, `vscode_format_document`
- **Multi-session support** — multiple independent chat panels, each with its own model and thinking level
- **Session tree view** — browse entries, fork from any message, reveal in chat, copy entry text
- **Past session management** — resume, delete, filter, and delete all past sessions
- **Tab indicator** — streaming/idle/init states with pulsing dot
- **Bash execution blocks** — expandable command output with exit codes
- **Code block rendering** — syntax highlighting for JS/TS, Python, Rust, HTML, CSS, Shell, JSON, Java, Go, and more, plus copy buttons
- **Truncation with show-more** — long tool results auto-truncate with expand option
- **User message history** — up-arrow recall for previously sent messages
- **Settings overlay** — toggle auto-compaction, auto-retry, and image display from the UI
- **Auto-install prompt** — prompts to install `@mariozechner/pi-coding-agent` on first launch
- **Inline quickstart guide** — shows provider links and setup instructions when no API key is configured
- **Keybindings** — `Ctrl+Alt+I` for chat, `Ctrl+L` for model picker, `Ctrl+P` for model cycling, and more
- **Custom slash commands** — `/fix-diagnostics`, `/explain-code`, `/refactor`, plus all standard Pi commands
