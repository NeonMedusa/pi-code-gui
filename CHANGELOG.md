# Change Log

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
