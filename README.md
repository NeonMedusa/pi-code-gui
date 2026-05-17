# Pi Code Gui

[![Version](https://badgen.net/vs-marketplace/v/NimbleTron.pi-code-gui?label=VS%20Code&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=NimbleTron.pi-code-gui)
[![Downloads](https://badgen.net/vs-marketplace/d/NimbleTron.pi-code-gui?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=NimbleTron.pi-code-gui)
[![Rating](https://badgen.net/vs-marketplace/rating/NimbleTron.pi-code-gui?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=NimbleTron.pi-code-gui)
[![Open VSX Version](https://badgen.net/open-vsx/v/NimbleTron/pi-code-gui?label=Open%20VSX&color=a160e4)](https://open-vsx.org/extension/NimbleTron/pi-code-gui)
[![Open VSX Downloads](https://badgen.net/open-vsx/d/NimbleTron/pi-code-gui?color=a160e4)](https://open-vsx.org/extension/NimbleTron/pi-code-gui)
[![Publish](https://github.com/NimbleTronAI/pi-code-gui/actions/workflows/publish.yml/badge.svg)](https://github.com/NimbleTronAI/pi-code-gui/actions/workflows/publish.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A native VS Code editor experience for the [Pi coding agent](https://pi.dev). Runs Pi inside VS Code — not in a terminal — with full access to your editor state, diagnostics, symbols, and more.

<p align="center">
  <img src="https://raw.githubusercontent.com/NimbleTronAI/pi-code-gui/main/media/pi-code-gui-readme.png" alt="Pi Code GUI">
</p>

## Quick Start

1. **Install Pi**: `npm install -g @earendil-works/pi-coding-agent`
2. **Set an API key**: Run **PiGui: Set Up API Key / Login** from the command palette (`Ctrl+Shift+P`), or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your environment.
3. **Open the chat**: Click the Pi icon in the activity bar, or run **PiGui: Code Agent** from the command palette.
4. **Start prompting**: The agent can see your editor, check diagnostics, read files, and make edits.

## Why Pi Code Gui?

The Pi coding agent is a powerful AI pair programmer, with an exceptional terminal (TUI) implementation. 

For people who prefer a GUI experience, this extension embeds Pi directly in VS Code's native UI:

- **In-editor chat** — streaming responses, thinking blocks, and tool execution results rendered in a webview panel, not a terminal buffer.
- **Native VS Code bridge** — 17 tools that call VS Code APIs directly. The agent can inspect your active editor, check diagnostics, find symbols, look up types, apply edits, and format code, all through the same APIs VS Code uses.
- **Session persistence** — conversation history survives VS Code restarts. Sessions are stored in Pi's standard `.jsonl` format alongside your project.
- **Multi-session support** — multiple chat sessions in separate panels, each with independent model and thinking level settings.

## Features

| Feature | Description |
|---------|-------------|
| 💬 **Chat panel** | Streaming text, collapsible thinking blocks, tool call/result rendering, markdown with syntax-highlighted code blocks |
| 🧰 **Editor bridge** | Agent reads open editors, checks diagnostics, inspects symbols/types, applies edits, formats code — all through VS Code APIs |
| 🔄 **Session history** | Auto-saved conversations can be resumed or deleted. Find with text search |
| 🪟 **Multi-session** | Multiple independent chat panels, each with its own model, thinking level, and conversation tree |
| 🔐 **Flexible auth** | Runtime API key overrides via VS Code settings, env vars, or the built-in auth config |
| 🔧 **Settings** | Toggle auto-compaction, auto-retry, skills loading, context files, and prompt templates from the UI |

## Gotchas

- Not all TUI behaviours map well into VSCode's UX. For instance, having new UI widgets spawned by extension packages. I did a best effort implementation, but there is definitely room for improvement.

## Custom Message Renderers (Extension API)

Pi extensions can send custom messages that render **inline in the conversation stream** with interactive elements (buttons, status indicators, etc.). This is the webview equivalent of Pi's TUI `MessageRenderer`.

### Registering a renderer

Extensions call `globalThis.__piRegisterMessageRenderer(customType, sourceCode)` with the renderer's JavaScript source code as a string. Pi Code GUI forwards it to the webview where it runs in the DOM:

```js
globalThis.__piRegisterMessageRenderer("my-extension", `
  var items = data.details?.items || [];
  var html = "<ul>";
  items.forEach(function (item) {
    html += '<li>' + escapeHtml(item.title) +
      ' <button data-command="/my_attach ' + item.id + '">Attach</button></li>';
  });
  html += "</ul>";
  containerEl.innerHTML = html;
`);
```

> **Important:** The second argument is **source code as a string**, not a function.
> It runs in the webview DOM context and receives `(data, containerEl)`:
> - `data` — the full custom message payload
> - `containerEl` — an empty `<div>` to populate with the card's DOM
> - `escapeHtml` — utility function, passed as third parameter (safe across builds)

### Sending a message

From the extension (Node.js side), call `pi.sendMessage()` with `display: true` and `details` containing your payload. Register the renderer first (see above):

```typescript
// 1. Register renderer on load
globalThis.__piRegisterMessageRenderer("my-extension", `
  containerEl.innerHTML = '<ul>' +
    data.details.items.map(function(i) {
      return '<li>' + escapeHtml(i.title) + ' <button data-command="/my_attach ' + i.id + '">Attach</button></li>';
    }).join('') + '</ul>';
`);

// 2. Send message to display
pi.sendMessage({
  customType: "my-extension",
  display: true,           // true = inline, false/undefined = notification
  content: "Fallback markdown if no renderer registered",
  details: {               // passed to your renderer as data.details
    items: [{ id: "abc", title: "Fix login bug" }]
  }
});
```

### Action buttons

Buttons with `data-command` attributes automatically execute the slash command when clicked:

```html
<button data-command="/my_attach abc123">Attach</button>
<button data-command="/my_approve abc123">✓ Approve</button>
```

The framework listens for `click` events on `[data-command]` elements and posts `{ type: "slashCommand", command }` to the extension host.

### Polling updates

To refresh a card (e.g., work-item status changes), call `pi.sendMessage()` again with the same `customType` and updated `details`. The webview finds the existing inline card and re-runs the renderer in-place:

```typescript
setInterval(async () => {
  const items = await fetchWorkItems();
  pi.sendMessage({
    customType: "nimble-pick-list",
    display: true,
    content: "Work items updated",
    details: { items }
  });
}, 5000);
```

### No renderer registered?

If no renderer is registered for a `customType`, the message's `content` is rendered as markdown inside a bordered card. This provides a graceful fallback for extensions that don't ship a webview renderer.

## Architecture

Pi Code Gui loads the `@earendil-works/pi-coding-agent` SDK at runtime from your global npm install. This means `pi update --self` picks up new SDK versions without an extension update.

- **PiService** manages the agent lifecycle: creates the SDK session, subscribes to events, translates them into chat UI messages, handles model/thinking/settings changes, and tracks usage stats.
- **PiWebviewPanel** renders a webview chat UI. It subscribes to PiService events and re-renders streaming text, thinking blocks, tool execution, bash output, compaction summaries, and custom messages in real time.
- **Bridge tools** are registered as SDK `customTools` constructed with `defineTool()` and Typebox schemas, the same way the SDK's own built-in tools are defined.

![Architecture](https://raw.githubusercontent.com/NimbleTronAI/pi-code-gui/main/media/architecture.png)

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pi-code-gui.promptToInstall` | boolean | `true` | Prompt to install Pi if not found |
| `pi-code-gui.anthropicApiKey` | string | `""` | Runtime Anthropic API key (overrides env var, not persisted to disk) |
| `pi-code-gui.openaiApiKey` | string | `""` | Runtime OpenAI API key (overrides env var, not persisted to disk) |
| `pi-code-gui.systemPromptAppend` | string | `""` | Additional instructions appended to the system prompt |
| `pi-code-gui.enableSkills` | boolean | `true` | Load project and global pi skills |
| `pi-code-gui.enableContextFiles` | boolean | `true` | Inject project context files |
| `pi-code-gui.enablePromptTemplates` | boolean | `true` | Register custom slash commands |
| `pi-code-gui.defaultModelProvider` | string | `""` | Default model provider (e.g. `anthropic`). Empty = auto-detect |
| `pi-code-gui.defaultModelId` | string | `""` | Default model ID (e.g. `claude-sonnet-4-5`). Requires provider set |
| `pi-code-gui.defaultThinkingLevel` | string | `"off"` | Default thinking level for new sessions |
| `pi-code-gui.contextBudget` | number | `0` | Per-session token budget. 0 = model default |
| `pi-code-gui.sessionDir` | string | `""` | Custom directory for session `.jsonl` files. Empty = pi SDK default (`~/.pi/agent/sessions/`) |

## Requirements

- VS Code 1.118+
- **No manual Pi install required** — the extension prompts you to install `@earendil-works/pi-coding-agent` automatically on first launch
- At least one API key (Anthropic, OpenAI, DeepSeek, Gemini, etc.) — run **PiGui: Set Up API Key / Login** or see the [Pi quickstart](https://pi.dev/docs/latest/quickstart)

## Development

```bash
pnpm install          # Install dev dependencies
pnpm run compile      # Type-check, lint, and build with esbuild
pnpm run watch        # Watch mode for development
```

Press `F5` in VS Code to launch the Extension Development Host.

To package a `.vsix`:

```bash
pnpm run vsix         # Creates pi-code-gui-x.x.x.vsix
```

## License

MIT — see [LICENSE](LICENSE) for details.

