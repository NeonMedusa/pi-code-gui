# Pi Code Gui for VS Code

A native VS Code editor experience for the [Pi coding agent](https://pi.dev). Runs Pi directly inside VS Code — not in a terminal — while maintaining the familiar Pi Code workflow. Most of it was built under my direction, using the Pi coding agent against DeepSeek v4 Pro model - for less than $1 in token costs.

## Why?

This was built by a grumpy old guy who spent the first 10 years of his tech career programming on 80×24 green screen dumb terminals. Beloved editors like `vi` and `emacs` were the IDEs of then, and knowing 100s of keystrokes was a badge of honour. Then I got a PC with a mouse and it could do all of that without the cognitive load and distractions. If you feel equally grumpy about the 2020s fascination to regress to CLI, then this extension is for you.

## Architecture

![Architecture](media/architecture.png)

### Key design decisions

- **Pi SDK in-process**: Uses the `@mariozechner/pi-coding-agent` SDK directly inside the extension. The SDK resolves from the user's global npm install at runtime, so `pi update --self` picks up new versions without an extension update.
- **Event-driven communication**: Same pattern as Pi's own interactive TUI. `PiWebviewPanel` subscribes to `AgentSession` events (agent_start, text_delta, tool_execution, etc.) and renders them in the webview chat UI.
- **Native VS Code bridge tools**: 17 tools that call VS Code APIs directly (editor state, diagnostics, symbols, definitions, hover, references, code actions, formatting). The AI sees and interacts with your editor natively.
- **Webview chat UI**: Replaces the terminal TUI with a native webview panel that renders streaming text, thinking blocks, and tool execution in real-time.

## What Works (Phase 4)

| Feature | Status |
|---------|--------|
| Chat panel with streaming responses | ✅ |
| Thinking block display (collapsible) | ✅ |
| Tool call/result blocks | ✅ |
| Send/abort prompts | ✅ |
| Status bar (model, thinking level) | ✅ |
| VS Code bridge tools (17 tools) | ✅ |
| Install detection + one-click install | ✅ |
| Official pixel-art Pi logo | ✅ |
| Activity bar icon + session tree view | ✅ |
| Model picker (`Ctrl+L` / `Cmd+L`) | ✅ |
| Cycle model (`Ctrl+P` / `Cmd+P`) | ✅ |
| Thinking level picker (`Ctrl+Shift+Tab`) | ✅ |
| Slash command picker (`Ctrl+/` / `Cmd+/`) | ✅ |
| File reference picker (`Ctrl+Shift+@`) | ✅ |
| Fork session from message | ✅ |
| Export session to HTML | ✅ |
| `/login` API key setup UI | ✅ |
| Session browser (list & resume) | ✅ |
| Manual compaction + auto-compaction toggle | ✅ |
| Auto-retry toggle | ✅ |
| Context file reload (`/reload`) | ✅ |

## Keybindings

These mirror Pi Code shortcuts, translated to VS Code:

| Pi Code | VS Code | Action |
|---------|---------|--------|
| `Ctrl+L` | `Ctrl+L` / `Cmd+L` | Switch model |
| `Ctrl+P` | `Ctrl+P` / `Cmd+P` | Cycle model |
| `Shift+Tab` | `Ctrl+Shift+Tab` | Pick thinking level |
| `/` | `Ctrl+/` / `Cmd+/` | Slash command picker |
| `@` | `Ctrl+Shift+@` | File reference picker |
| — | `Ctrl+Alt+I` / `Cmd+Alt+I` | Open chat panel |

> **Note:** `Ctrl+P` is commonly bound to VS Code's "Go to File" and `Ctrl+L` to "Expand Line Selection". When the Pi Code chat panel is focused, these shortcuts trigger Pi commands. Outside the chat, they retain default VS Code behavior.

## Commands

All commands available via the palette (`Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `PiGui: Code Agent` | Open the Pi Code chat panel |
| `PiGui: Switch Model` | Pick a model from available providers |
| `PiGui: Cycle Model` | Cycle to the next available model |
| `PiGui: Set Thinking Level` | Pick a thinking/reasoning level |
| `PiGui: Cycle Thinking Level` | Cycle through thinking levels |
| `PiGui: Slash Command Picker` | Pick a slash command (`/login`, `/new`, etc.) |
| `PiGui: Pick File to Reference` | Fuzzy-search and reference a file (`@`) |
| `PiGui: ` | Start a fresh session |
| `PiGui: Fork Session from Message` | Branch from a previous message |
| `PiGui: Export Session to HTML` | Save session as HTML file |
| `PiGui: Set Up API Key / Login` | Configure a provider API key or OAuth |
| `PiGui: Resume Session` | Browse and resume a past session |
| `PiGui: Compact Context` | Manually compact conversation context |
| `PiGui: Toggle Auto-Compaction` | Enable/disable automatic compaction |
| `PiGui: Toggle Auto-Retry` | Enable/disable automatic retry on errors |
| `PiGui: Reload Context Files` | Reload AGENTS.md and context files |
| `PiGui: Abort` | Abort the current agent operation |
| `PiGui: Install Pi Coding Agent` | Install pi via npm |

## VS Code Bridge Tools

The AI agent has access to these VS Code capabilities:

| Tool | Description |
|------|-------------|
| `vscode_get_editor_state` | Active editor, selection, open editors, workspace folders |
| `vscode_get_selection` | Current selection with text and coordinates |
| `vscode_get_diagnostics` | LSP/lint/type errors for a file or workspace |
| `vscode_get_open_editors` | All open editors with dirty state |
| `vscode_get_workspace_folders` | Workspace folder listing |
| `vscode_open_file` | Open file with optional selection range |
| `vscode_check_document_dirty` | Check if a file has unsaved changes |
| `vscode_save_document` | Save a document via VS Code |
| `vscode_get_document_symbols` | Document outline symbols |
| `vscode_get_definitions` | Go-to-definition |
| `vscode_get_hover` | Type info and docs on hover |
| `vscode_get_references` | Find all references |
| `vscode_get_workspace_symbols` | Search workspace symbols |
| `vscode_get_code_actions` | Quick fixes and refactorings |
| `vscode_apply_workspace_edit` | Apply range-based text edits |
| `vscode_format_document` | Format document with VS Code formatter |
| `vscode_show_notification` | Show info/warning/error notifications |

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.118+
- [Pi coding agent](https://pi.dev) installed (`npm install -g @mariozechner/pi-coding-agent`)
- At least one API key configured (Anthropic, OpenAI, DeepSeek, etc.)

The extension auto-detects the `pi` binary from common global install paths or workspace `node_modules/.bin/pi`. Use **PiGui: Set Up API Key / Login** to configure authentication.

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pi-code-gui.promptToInstall` | boolean | `true` | Prompt to install Pi if not found |

## Development

```bash
pnpm install          # Install dependencies
pnpm run compile      # Type-check + lint + build
pnpm run watch        # Watch mode for development
```

Press `F5` in VS Code to launch the Extension Development Host. The extension is loaded from your workspace, so it has access to the workspace `node_modules` and can find the `pi` binary.

To package for distribution:
```bash
pnpm run vsix         # Creates pi-code-gui-x.x.x.vsix
```

**Architecture notes:** This extension loads the pi SDK (`@mariozechner/pi-coding-agent`) at runtime from the user's global npm install. All tools call VS Code APIs directly. The SDK resolves from common global install paths and falls back to Node module resolution.

## License

MIT — see the LICENSE file for details.

The Pi logo is from [pi.dev](https://pi.dev) and is used under the MIT license of the [pi-mono](https://github.com/badlogic/pi-mono) project.
