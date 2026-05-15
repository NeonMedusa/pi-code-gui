import * as vscode from "vscode";
import { PiService } from "./pi-service.js";
import type { PiServiceEvent, PromptMessage } from "./types.js";

export type PanelDisposeCallback = (piService: PiService) => void;

export class PiWebviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private piService: PiService;
  private disposables: vscode.Disposable[] = [];
  /** Cleanup function returned by piService.onEvent() */
  private piCleanup: (() => void) | null = null;

  // Tab indicator state
  private _tabInitialized = false;
  private _tabStreaming = false;
  private _tabSummary: string | null = null;

  /** Callback invoked when the panel is disposed (VS Code tab closed) */
  private _onDispose: PanelDisposeCallback | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    piService: PiService
  ) {
    this.piService = piService;
  }

  /** Register a callback that fires when the panel/webview is closed. */
  set onDispose(cb: PanelDisposeCallback | null) { this._onDispose = cb; }

  /** Register a callback that fires when this panel/view becomes active. */
  set onActivate(cb: (() => void) | null) { this._onActivateCb = cb; }
  private _onActivateCb: (() => void) | null = null;

  async show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    // Use a unique viewType per webview to prevent VS Code from restoring
    // stale webviews that reference old extension versions. The randomId is
    // regenerated on every createWebviewPanel call.
    var randomId = Math.random().toString(36).slice(2, 8);
    this.panel = vscode.window.createWebviewPanel(
      "pi-chat-" + randomId,
      "Pi Code Gui",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      }
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-dark.svg"),
    };

    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupWebviewHandlers();
    this.setupServiceHandlers();

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active && this._onActivateCb) {
        this._onActivateCb();
      }
    });

    this.panel.onDidDispose(() => {
      // Notify the owner (extension.ts) so it can save and remove from open sessions
      if (this._onDispose) {
        this._onDispose(this.piService);
      }
      this.panel = null;
      this.disposables.forEach((d) => d.dispose());
      this.disposables = [];
      this.cleanupPiListener();
    });
  }

  private setupWebviewHandlers() {
    if (!this.panel) {
      console.error("[pi-gui] setupWebviewHandlers called with no panel — webview messages will be lost");
      return;
    }

    // Proactively send status every 500ms until pi is ready
    // This avoids the webview-to-extension 'ready' handshake entirely
    let statusInterval: any = null;
    const startPolling = () => {
      if (statusInterval) {return;}
      statusInterval = setInterval(() => {
        const model = this.piService.model;
        this.postMessage({
          type: "status",
          data: {
            model: model?.id ?? "loading...",
            thinkingLevel: this.piService.thinkingLevel,
            effort: this.piService.effort,
            ready: model !== null,
          },
        });
        if (model !== null && statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
          this._tabInitialized = true;
          this.updateTabIndicator();
        }
      }, 500);
    };
    startPolling();
    this.disposables.push({ dispose: () => { if (statusInterval) {clearInterval(statusInterval);} } });

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "prompt": {
              const msg = message as any;
              this.piService.sendPrompt(msg.text, msg.images, msg.mode).catch((error: any) => {
                let errMsg = error.message ?? String(error);
                if (/api.?key|login|authenticate|provider/i.test(errMsg)) {
                  errMsg += "\n\n[Set up an API key →](https://pi.dev/docs/latest/quickstart)";
                }
                this.postMessage({ type: "error", data: { message: errMsg } });
              });
            }
            break;

          case "abort":
            await this.piService.abort();
            break;

          case "cycleModel":
            await this.piService.cycleModel();
            break;

          case "setThinkingLevel":
            await this.piService.setThinkingLevel(message.level);
            break;

          case "setEffort":
            await this.piService.setEffort(message.effort);
            break;

          case "pickModel":
            this.triggerModelPicker();
            break;

          case "pickThinkingLevel":
            this.triggerThinkingPicker();
            break;

          case "pickEffort":
            this.triggerEffortPicker();
            break;

          case "openUrl":
            vscode.env.openExternal(vscode.Uri.parse(message.url));
            break;

          case "openFile":
            vscode.window.showTextDocument(vscode.Uri.file(message.path));
            break;

          // Slash commands intercepted locally (not sent to LLM)
          case "slashCommand":
            this.handleSlashCommand(message.command);
            break;

          // Settings toggle messages from webview (#3)
          case "toggleAutoCompaction":
            await this.piService.toggleAutoCompaction();
            break;

          case "toggleAutoRetry":
            await this.piService.toggleAutoRetry();
            break;

          case "toggleShowImages":
            await this.piService.toggleShowImages();
            break;

          // Request user messages list (#2)
          case "getUserMessages":
            this.postMessage({
              type: "user-messages-list",
              data: { messages: this.piService.userMessages.slice(-20) },
            });
            break;

          // Request settings state (#3)
          case "getSettings":
            this.piService.emitSettings();
            this.piService.emitScopedModels();
            break;

          // Context budget picker
          case "pickContextBudget":
            this.triggerContextBudgetPicker();
            break;

          // Request settings state (#2, #8)
          case "resendUserMessage":
            if (message.text) {
              await this.piService.sendPrompt(message.text);
            }
            break;

          case "promoteToSteer":
            if (message.text) {
              await this.piService.promoteToSteer(message.text);
            }
            break;

          case "clearQueue":
            await this.piService.clearQueue();
            break;
        }
      },
      undefined,
      this.disposables
    );
  }

  private setupServiceHandlers() {
    // Remove any stale listener before adding a new one (prevents duplicates on panel reopen)
    this.cleanupPiListener();
    this.piCleanup = this.piService.onEvent((event: PiServiceEvent) => {
      this.postMessage(event);

      // Capture first user input for tab title summary.
      // Only generate if the session does NOT already have a stored name
      // (avoids overwriting a prior AI name or manual rename on reopen).
      if (event.type === "chat-message" && event.data?.role === "user" && !this._tabSummary && !this.piService.sessionName) {
        const text: string = event.data?.content ?? "";
        if (text.trim()) {
          // Persist a fallback name immediately so the session survives even
          // if the AI call times out or the tab closes before the model responds.
          const fallback = text.replace(/\s+/g, " ").trim().slice(0, 50);
          this._tabSummary = fallback;
          this.updateTabIndicator();
          this.piService.setSessionName(fallback);

          // Then try to upgrade to a concise AI-generated summary
          this.piService.generateTabSummary(text).then((summary) => {
            if (summary && summary !== fallback) {
              this._tabSummary = summary;
              this.updateTabIndicator();
              this.piService.setSessionName(summary);
            }
          }).catch(() => {});
        }
      }

      // When the SDK updates the session name/label, update the tab title
      if (event.type === "status-update" && event.data) {
        const sessionName = this.piService.sessionName;
        if (sessionName && sessionName !== this._tabSummary) {
          this._tabSummary = sessionName;
          this._tabInitialized = true;
          this.updateTabIndicator();
        }
      }

      // Track streaming state for the tab indicator
      if (event.type === "agent-start") {
        this._tabStreaming = true;
        this.updateTabIndicator();
      } else if (event.type === "agent-end") {
        this._tabStreaming = false;
        this.updateTabIndicator();
      } else if (event.type === "status-update" && event.data) {
        const wasStreaming = this._tabStreaming;
        this._tabStreaming = !!event.data.isStreaming;
        if (!event.data.ready && event.data.ready !== undefined) {
          this._tabInitialized = false;
        }
        if (this._tabStreaming !== wasStreaming) {
          this.updateTabIndicator();
        }
      }
    });
  }

  /** Update the tab title to indicate streaming / idle / init state.
   *  The in-webview status bar handles the visual color indicator;
   *  the tab uses a text suffix for streaming so it stays theme-consistent. */
  private updateTabIndicator() {
    if (!this.panel) { return; }

    // Static icon — no colour coding (SVGs can't adapt to theme variables)
    const piIcon = (name: string) =>
      vscode.Uri.joinPath(this.context.extensionUri, "media", name);
    this.panel.iconPath = {
      light: piIcon("pi-icon-light.svg"),
      dark: piIcon("pi-icon-dark.svg"),
    };

    if (!this._tabInitialized) {
      this.panel.title = "Pi Code Gui";
      return;
    }

    const label = this._tabSummary ?? "Pi";
    // Bullet prefix: ● busy, ○ idle — consistent with status bar
    this.panel.title = (this._tabStreaming ? "\u25CF " : "\u25CB ") + label;
  }

  private cleanupPiListener() {
    if (this.piCleanup) {
      this.piCleanup();
      this.piCleanup = null;
    }
  }

  get summary(): string | null { return this._tabSummary; }

  postMessage(message: any) {
    this.panel?.webview.postMessage(message);
  }

  /** Insert a command or file reference into the chat input */
  postCommand(command: string) {
    this.panel?.webview.postMessage({ type: "insertCommand", command });
  }

  /** Handle a locally-intercepted slash command (not sent to LLM) */
  private async handleSlashCommand(command: string) {
    switch (command) {
      case "login":
        await this.piService.login();
        break;
      case "logout":
        await this.piService.logout();
        break;
      case "model":
        await this.triggerModelPicker();
        break;
      case "thinking":
        await this.triggerThinkingPicker();
        break;
      case "sessions":
        await vscode.commands.executeCommand("pi-code-gui.sessions.focus");
        break;
      case "settings":
        await this.triggerSettingsPicker();
        break;
      default:
        // Forward to pi session so extension command handlers (e.g. /tldr) can respond
        try {
          await this.piService.sendPrompt(`/${command}`);
        } catch (e: any) {
          this.postMessage({
            type: "error",
            data: { message: e.message ?? String(e) },
          });
        }
        break;
    }
  }

  private getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const morphdomUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "lib", "morphdom.js"),
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "marked.min.js"),
    );
    const coreUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "core.js"),
    );
    const toolsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "tools.js"),
    );
    const appUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "app.js"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi Code Gui</title>
  <style>
    :root {
      --bg-primary: var(--vscode-editor-background);
      --bg-secondary: var(--vscode-sideBar-background);
      --bg-input: var(--vscode-input-background);
      --fg-primary: var(--vscode-editor-foreground);
      --fg-secondary: var(--vscode-descriptionForeground);
      --border-color: var(--vscode-panel-border);
      --accent: var(--vscode-focusBorder);
      --error: var(--vscode-errorForeground);
      --warning: var(--vscode-editorWarning-foreground);
      --success: var(--vscode-terminal-ansiGreen);
      --thinking-bg: var(--vscode-textBlockQuote-background);
      --tool-bg: var(--vscode-textCodeBlock-background);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      color: var(--fg-primary);
      background: var(--bg-primary);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      max-width: 100%;
      animation: fadeIn 0.2s ease-in;
    }

    /* Batch replay mode: hide all chat children except welcome
       so only the loading screen is visible while history renders. */
    .no-animate #chat-container > :not(#welcome) {
      opacity: 0;
    }
    .no-animate *,
    .no-animate *::before,
    .no-animate *::after {
      animation: none !important;
      transition: none !important;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      align-self: flex-start;
      margin-top: 8px;
    }

    .message.user .message-content {
      background: var(--vscode-input-background);
      color: var(--fg-primary);
      border: 1px solid var(--border-color);
      padding: 8px 14px;
      border-radius: 8px;
      max-width: 80%;
      font-weight: 400;
      display: inline-block;
    }

    .message.assistant {
      align-self: flex-start;
      width: 100%;
    }

    .message.assistant .message-content {
      padding: 4px 0;
      line-height: 1.6;
    }

    .message.assistant .message-content p {
      margin: 4px 0;
    }

    .message.assistant .message-content ol,
    .message.assistant .message-content ul {
      padding-left: 2em;
      margin: 4px 0;
    }

    .message.assistant .message-content li {
      margin-bottom: 2px;
    }

    .message.assistant .message-content h1,
    .message.assistant .message-content h2,
    .message.assistant .message-content h3 {
      margin: 12px 0 4px 0;
      font-weight: 600;
    }
    .message.assistant .message-content h4,
    .message.assistant .message-content h5,
    .message.assistant .message-content h6 {
      margin: 8px 0 4px 0;
      font-weight: 600;
    }
    .message.assistant .message-content h1 { font-size: 1.3em; }
    .message.assistant .message-content h2 { font-size: 1.15em; }
    .message.assistant .message-content h3 { font-size: 1.05em; }

    .message.assistant .message-content blockquote {
      border-left: 3px solid var(--fg-secondary);
      margin: 8px 0;
      padding: 4px 14px;
      color: var(--fg-secondary);
      background: var(--thinking-bg);
      border-radius: 0 4px 4px 0;
    }

    .message.assistant .message-content hr {
      border: none;
      border-top: 1px solid var(--border-color);
      margin: 12px 0;
    }

    .message.assistant .message-content a {
      color: var(--accent);
      text-decoration: none;
    }
    .message.assistant .message-content a:hover {
      text-decoration: underline;
    }

    .message.assistant .message-content del {
      opacity: 0.6;
      text-decoration: line-through;
    }

    /* ── Code blocks (rich) ───────────────────────────── */

    .code-block-wrapper {
      margin: 8px 0;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
    }

    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--border-color);
      font-size: 0.8em;
    }

    .code-lang-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .code-copy-btn {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 2px 10px;
      cursor: pointer;
      font-size: 0.85em;
      font-family: inherit;
    }

    .code-copy-btn:hover {
      background: var(--vscode-button-hoverBackground);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }

    .code-block {
      margin: 0;
      padding: 12px 0 12px 12px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      line-height: 1.55;
      white-space: pre;
      tab-size: 2;
    }

    .code-block code {
      display: block;
      font-family: inherit;
      font-size: inherit;
      background: none !important;
      padding: 0 !important;
    }

    .code-block .code-ln {
      display: inline-block;
      width: 2.5em;
      text-align: right;
      padding-right: 1em;
      color: var(--vscode-editorLineNumber-foreground);
      opacity: 0.4;
      user-select: none;
      pointer-events: none;
    }

    .code-block .code-text {
      display: inline;
    }

    /* ── Syntax highlight tokens ─────────────────────── */

    .tok-kw     { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .tok-str    { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .tok-num    { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .tok-cm     { color: var(--vscode-symbolIcon-constantForeground, #6a9955); font-style: italic; }
    .tok-fn     { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .tok-type   { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .tok-prop   { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .tok-op     { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }
    .tok-builtin { color: var(--vscode-symbolIcon-constantForeground, #569cd6); }
    .tok-punct  { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }

    /* ── Fallback inline code ────────────────────────── */

    .message.assistant .message-content code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .message.assistant .message-content pre {
      background: var(--tool-bg);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
      white-space: pre;
    }

    .message.assistant .message-content pre code {
      background: none;
      padding: 0;
      font-size: 0.85em;
      line-height: 1.55;
    }

    .thinking-block {
      background: var(--thinking-bg);
      border-left: 3px solid var(--fg-secondary);
      padding: 10px 14px;
      margin: 8px 0;
      border-radius: 0 6px 6px 0;
      font-size: 0.9em;
      color: var(--fg-secondary);
    }

    .thinking-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-weight: 600;
      color: var(--fg-secondary);
      cursor: default;
    }

    .thinking-label {
      font-weight: 700;
    }

    .thinking-line-count {
      font-weight: 400;
      opacity: 0.6;
      font-size: 0.85em;
    }

    .thinking-block .thinking-content {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.5;
      color: var(--fg-secondary);
    }

    .thinking-collapsed .thinking-content {
      max-height: 200px;
      overflow-y: auto;
    }

    .thinking-collapsed .thinking-content.overflowing {
      position: relative;
    }

    .thinking-collapsed .thinking-content.overflowing::after {
      content: "";
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 30px;
      background: linear-gradient(transparent, var(--thinking-bg));
      pointer-events: none;
    }

    .thinking-block .thinking-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--fg-secondary);
      border-top-color: transparent;
      border-radius: 50%;
      animation: think-spin 0.8s linear infinite;
      vertical-align: middle;
    }

    .thinking-expand-btn {
      display: block;
      width: 100%;
      text-align: center;
      padding: 4px;
      margin-top: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      font-family: inherit;
    }

    .thinking-expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    @keyframes think-spin {
      to { transform: rotate(360deg); }
    }

    /* Inline quickstart guide */
    .quickstart-content {
      font-size: 0.9em;
      line-height: 1.6;
      color: var(--fg-primary);
      margin-top: 8px;
    }
    .quickstart-content h2 {
      font-size: 1.1em;
      margin: 16px 0 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border-color);
    }
    .quickstart-content h3 {
      font-size: 1em;
      margin: 12px 0 4px;
    }
    .quickstart-content p { margin: 6px 0; }
    .quickstart-content ul, .quickstart-content ol { padding-left: 1.5em; margin: 4px 0; }
    .quickstart-content li { margin-bottom: 2px; }
    .quickstart-content a { color: var(--accent); }
    .quickstart-content pre {
      background: var(--tool-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 8px 12px;
      overflow-x: auto;
      font-size: 0.85em;
      margin: 6px 0;
    }
    .quickstart-content code {
      background: var(--tool-bg);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .quickstart-content pre code {
      background: none;
      padding: 0;
      font-size: inherit;
    }
    .quickstart-content hr { margin: 12px 0; border: none; border-top: 1px solid var(--border-color); }

    .tool-block {
      flex-shrink: 0;
      background: var(--tool-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 10px 14px;
      margin: 8px 0;
    }

    .tool-block .tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 0.9em;
    }

    .tool-block .tool-name {
      color: var(--accent);
    }

    .tool-block .tool-status {
      font-size: 0.8em;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .tool-block .tool-status.running {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .tool-block .tool-status.success {
      background: rgba(0, 200, 0, 0.1);
      color: var(--success);
    }

    .tool-block .tool-status.error {
      background: rgba(255, 0, 0, 0.1);
      color: var(--error);
    }

    .tool-block .tool-status.pending {
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-descriptionForeground);
    }

    .tool-block .tool-args {
      margin-top: 6px;
      font-size: 0.85em;
      opacity: 0.7;
      max-height: 100px;
      overflow-y: auto;
    }

    .tool-block .tool-args code {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-block .tool-result {
      margin-top: 8px;
      font-size: 0.9em;
      max-height: 420px;
      overflow-y: auto;
    }

    /* When tool result contains rendered code blocks (from read/write/edit),
       inherit proper spacing and avoid double-scroll. */
    .tool-block .tool-result .code-block-wrapper {
      margin: 4px 0;
    }

    .tool-block .tool-result .code-block {
      max-height: 500px;
      overflow-y: auto;
    }

    .tool-block .tool-result p {
      margin: 4px 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-block .tool-result ul,
    .tool-block .tool-result ol {
      padding-left: 2em;
      margin: 4px 0;
    }

    .tool-block .tool-result li {
      margin-bottom: 2px;
    }

    .tool-block .tool-result h1,
    .tool-block .tool-result h2,
    .tool-block .tool-result h3,
    .tool-block .tool-result h4 {
      margin: 8px 0 4px;
      font-weight: 600;
    }

    .tool-block .tool-result strong {
      font-weight: 700;
    }

    .tool-block .tool-result code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }

    /* ── Tool content area (write/edit inline display) ── */

    .tool-block .tool-content {
      margin-top: 8px;
      font-size: 0.85em;
    }

    .tool-block .tool-content .code-block-wrapper {
      margin: 4px 0;
    }

    .tool-block .tool-content .code-block {
      max-height: 500px;
      overflow-y: auto;
    }

    .tool-block .tool-header .tool-path {
      font-weight: 400;
    }

    .tool-block .tool-header .tool-path[data-path] {
      cursor: pointer;
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 2px;
    }

    .tool-block .tool-header .tool-path[data-path]:hover {
      color: var(--accent);
    }

    /* ── Edit change preview (per-edit diff in call block) ── */

    .tool-block .edit-change {
      margin: 8px 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-block .edit-change .edit-header {
      font-weight: 600;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }

    .tool-block .edit-change .edit-old {
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.12));
      padding: 2px 8px;
      border-radius: 2px;
      margin: 1px 0;
      max-height: 100px;
      overflow-y: auto;
    }

    .tool-block .edit-change .edit-new {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.10));
      padding: 2px 8px;
      border-radius: 2px;
      margin: 1px 0;
      max-height: 100px;
      overflow-y: auto;
    }

    /* While streaming, use a taller max so edits grow then scroll, but always show the bottom */
    .tool-block[data-status="running"] .edit-change .edit-old,
    .tool-block[data-status="running"] .edit-change .edit-new {
      max-height: 100px;
      overflow-y: auto;
    }

    /* ── Tool result expand/collapse ── */

    .tool-block .tool-result.tool-result-collapsed {
      max-height: 200px;
      overflow-y: auto;
      position: relative;
    }

    .tool-block .tool-result.tool-result-collapsed::after {
      content: "";
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: linear-gradient(transparent, var(--tool-bg));
    }

    .tool-block .tool-expand-btn {
      display: block;
      width: 100%;
      text-align: center;
      padding: 4px;
      margin-top: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      font-family: inherit;
    }

    .tool-block .tool-expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* ── Compact read label (skills/docs/resources) ── */

    .tool-block .compact-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin-top: 4px;
    }

    .streaming-cursor::after {
      content: "|";
      animation: blink 0.8s step-end infinite;
      font-weight: 100;
      opacity: 0.5;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    .working-spinner {
      display: inline-block;
      width: 1.2em;
      text-align: center;
    }

    /* ── Live panel (extension TUI components, e.g. tldr) ── */

    #live-panel {
      display: none;
      flex-shrink: 0;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
      padding: 0;
      max-height: 160px;
      overflow-y: auto;
    }

    #live-panel.visible {
      display: block;
    }

    .live-card {
      padding: 8px 14px;
      border-bottom: 1px solid var(--border-color);
      font-size: 0.85em;
      animation: fadeIn 0.15s ease-in;
      position: relative;
    }

    .live-card:last-child {
      border-bottom: none;
    }

    /* ── In-webview status bar ────────────────────── */
    #pi-status-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 5px 12px;
      background: var(--bg-secondary, var(--vscode-sideBar-background));
      border-top: 1px solid var(--border-color, var(--vscode-sideBar-border));
      font-size: 0.8em;
      color: var(--fg-secondary, var(--vscode-descriptionForeground));
      min-height: 30px;
      flex-shrink: 0;
      user-select: none;
    }

    /* Status dot: inherits bar text colour; shape (●/○) signals state */
    #pi-sb-dot { font-size: 0.9em; flex-shrink: 0; }

    #pi-status-bar .pi-sb-item {
      display: flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      padding: 1px 5px;
      border-radius: 3px;
      white-space: nowrap;
    }
    #pi-status-bar .pi-sb-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    #pi-status-bar .pi-sb-item.spacer {
      flex: 1;
      cursor: default;
      pointer-events: none;
    }
    #pi-status-bar .pi-sb-item.spacer:hover {
      background: none;
    }

    .live-card .live-card-close {
      position: absolute;
      top: 4px;
      right: 8px;
      background: none;
      border: none;
      color: var(--fg-secondary);
      font-size: 1.1em;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      opacity: 0.5;
    }
    .live-card .live-card-close:hover {
      opacity: 1;
      color: var(--fg-primary);
    }

    .live-card .live-card-label {
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      font-size: 0.75em;
      letter-spacing: 0.5px;
      cursor: pointer;
      user-select: none;
    }

    .live-card .live-card-label .live-card-expando {
      display: inline-block;
      width: 12px;
      font-size: 0.9em;
    }

    .live-card.live-card-collapsed {
      padding: 4px 14px;
    }
    .live-card.live-card-collapsed .live-card-label {
      margin-bottom: 0;
    }
    .live-card.live-card-collapsed .live-card-close {
      top: 2px;
    }

    .live-card .live-card-content {
      color: var(--fg-primary);
      line-height: 1.4;
    }

    .live-card .live-card-content p {
      margin: 2px 0;
    }

    .live-card .live-card-content code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }

    /* ── Attachment bar ──────────────────────────── */

    #attachment-bar {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 16px 4px 16px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    #attachment-bar.visible {
      display: flex;
    }

    .attachment-item {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 3px 6px 3px 4px;
      font-size: 0.8em;
      max-width: 200px;
    }

    .attachment-item .att-preview {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      object-fit: cover;
      flex-shrink: 0;
    }

    .attachment-item .att-icon {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--thinking-bg);
      flex-shrink: 0;
      font-size: 1.1em;
    }

    .attachment-item .att-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fg-primary);
      max-width: 120px;
    }

    .attachment-item .att-remove {
      cursor: pointer;
      color: var(--fg-secondary);
      padding: 0 2px;
      line-height: 1;
      font-size: 1.1em;
      flex-shrink: 0;
    }

    .attachment-item .att-remove:hover {
      color: var(--error);
    }

    #input-area {
      display: flex;
      gap: 8px;
      padding: 10px 16px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    #prompt-input {
      flex: 1;
      background: var(--bg-input);
      color: var(--fg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      resize: none;
      min-height: 40px;
      max-height: 100px;
      outline: none;
      overflow-y: hidden;
    }

    #prompt-input:focus {
      border-color: var(--accent);
    }

    #send-button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 8px 0 0 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 1em;
      font-weight: 600;
      line-height: 1;
      align-self: flex-end;
    }

    #send-button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    #send-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    #steer-dropdown {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-left: 1px solid rgba(255,255,255,0.2);
      border-radius: 0 8px 8px 0;
      padding: 8px 8px;
      cursor: pointer;
      font-size: 1em;
      font-weight: 600;
      line-height: 1;
      align-self: flex-end;
      opacity: 0.8;
    }

    #steer-dropdown:hover {
      background: var(--vscode-button-hoverBackground);
      opacity: 1;
    }

    #steer-split {
      display: flex;
      align-self: flex-end;
    }

    #steer-split.hidden {
      display: none;
    }

    #prompt-input:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    #abort-button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 0.9em;
      align-self: flex-end;
    }

    #abort-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    #queue-button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 0.9em;
      align-self: flex-end;
    }

    #queue-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .hidden {
      display: none !important;
    }

    .welcome-message {
      text-align: center;
      padding: 40px 20px;
      color: var(--fg-secondary);
    }

    .welcome-message h2 {
      font-size: 1.4em;
      margin-bottom: 8px;
      color: var(--fg-primary);
    }

    .welcome-message p {
      font-size: 0.9em;
      line-height: 1.6;
    }

    .welcome-message a {
      color: var(--accent);
      text-decoration: none;
    }

    .welcome-message a:hover {
      text-decoration: underline;
    }

    /* ── Compaction summary message (#1) ─────────── */

    .compaction-summary {
      flex-shrink: 0;
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 10px 14px;
      margin: 8px 0;
    }

    .compaction-summary .cs-header {
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .compaction-summary .cs-preview {
      font-size: 0.9em;
      color: var(--fg-secondary);
      cursor: pointer;
    }

    .compaction-summary .cs-content {
      font-size: 0.9em;
      color: var(--fg-secondary);
      margin-top: 6px;
      white-space: pre-wrap;
      max-height: 300px;
      overflow-y: auto;
    }

    /* ── User message selector modal (#2) ────────── */

    .user-msg-selector-overlay {
      display: none;
      position: fixed;
      bottom: 60px;
      left: 16px;
      right: 16px;
      max-height: 260px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--accent);
      border-radius: 8px;
      overflow-y: auto;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }

    .user-msg-selector-overlay.visible {
      display: block;
    }

    .user-msg-item {
      padding: 8px 14px;
      cursor: pointer;
      border-bottom: 1px solid var(--border-color);
      font-size: 0.85em;
      color: var(--fg-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .user-msg-item:last-child {
      border-bottom: none;
    }

    .user-msg-item:hover,
    .user-msg-item.selected {
      background: var(--vscode-list-hoverBackground);
      color: var(--accent);
    }

    .user-msg-item .msg-idx {
      display: inline-block;
      width: 24px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.75em;
      opacity: 0.6;
    }

    /* ── Settings panel modal (#3) ───────────────── */

    .settings-overlay {
      display: none;
      position: fixed;
      bottom: 50px;
      right: 16px;
      width: 280px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--accent);
      border-radius: 8px;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      padding: 12px;
    }

    .settings-overlay.visible {
      display: block;
    }

    .settings-overlay .settings-title {
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--fg-primary);
      font-size: 0.9em;
    }

    .settings-overlay .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-color);
      font-size: 0.85em;
      color: var(--fg-secondary);
    }

    .settings-overlay .settings-row:last-child {
      border-bottom: none;
    }

    .settings-overlay .settings-toggle {
      width: 32px;
      height: 18px;
      border-radius: 9px;
      background: var(--vscode-descriptionForeground);
      cursor: pointer;
      position: relative;
      transition: background 0.15s;
    }

    .settings-overlay .settings-toggle.on {
      background: var(--accent);
    }

    .settings-overlay .settings-toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: white;
      transition: left 0.15s;
    }

    .settings-overlay .settings-toggle.on::after {
      left: 16px;
    }


    /* ── Diff rendering (#5) ──────────────────────── */
    /* Text inherits normal foreground; only background signals the diff.
       Matches how VS Code's own diff editor works. */

    .diff-line-removed {
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.12));
    }

    .diff-line-added {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.10));
    }

    .diff-line-context {
      color: var(--fg-secondary);
      opacity: 0.7;
    }

    .diff-word-removed {
      background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.25));
      border-radius: 2px;
      padding: 0 1px;
    }

    .diff-word-added {
      background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,255,0,0.20));
      border-radius: 2px;
      padding: 0 1px;
    }

    /* ── Tool result expanded (#6) ────────────────── */

    .tool-result-truncated {
      position: relative;
    }

    .tool-result-truncated .show-more-btn {
      display: block;
      width: 100%;
      text-align: center;
      padding: 4px;
      margin-top: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      font-family: inherit;
    }

    .tool-result-truncated .show-more-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* ── Bash execution block (#10) ──────────────── */

    .bash-execution {
      flex-shrink: 0;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      margin: 8px 0;
      background: var(--vscode-textCodeBlock-background);
    }

    .bash-execution .bash-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--border-color);
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      color: var(--accent);
    }

    .bash-execution .bash-output {
      padding: 8px 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
      color: var(--fg-secondary);
    }

    .bash-execution .bash-output.expanded {
      max-height: none;
    }

    .bash-execution .bash-footer {
      padding: 4px 12px;
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--border-color);
      background: var(--vscode-sideBar-background);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .bash-execution .bash-footer .exit-code {
      font-weight: 600;
    }

    .bash-execution .bash-footer .exit-code.error {
      color: var(--vscode-errorForeground);
    }

    .bash-execution .bash-footer .cancel-hint {
      opacity: 0.6;
    }

    /* ── Custom message (#7) ──────────────────────── */

    .custom-message {
      flex-shrink: 0;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      padding: 10px 14px;
      margin: 8px 0;
    }

    .custom-message .custom-label {
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .custom-message .custom-content {
      font-size: 0.9em;
      color: var(--fg-secondary);
    }

    .custom-message .custom-content p {
      margin: 4px 0;
    }

    /* ── Turn separator (removed) ─────────────────── */

    /* ── Slash command autocomplete (#8) ──────────── */

    .slash-autocomplete {
      display: none;
      position: fixed;
      bottom: 110px;
      left: 16px;
      max-width: 320px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--accent);
      border-radius: 8px;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      max-height: 200px;
      overflow-y: auto;
    }

    .slash-autocomplete.visible {
      display: block;
    }

    .slash-autocomplete .slash-item {
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85em;
      cursor: pointer;
      border-bottom: 1px solid var(--border-color);
    }

    .slash-autocomplete .slash-item:last-child {
      border-bottom: none;
    }

    .slash-autocomplete .slash-item:hover,
    .slash-autocomplete .slash-item.selected {
      background: var(--vscode-list-hoverBackground);
    }

    .slash-autocomplete .slash-cmd {
      font-weight: 600;
      color: var(--accent);
      min-width: 80px;
    }

    .slash-autocomplete .slash-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }

    /* ── Tables ───────────────────────────────────── */

    .message.assistant .message-content table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 0.9em;
      width: 100%;
      overflow-x: auto;
      display: block;
    }

    .message.assistant .message-content thead {
      border-bottom: 2px solid var(--border-color);
    }

    .message.assistant .message-content th {
      padding: 8px 12px;
      font-weight: 600;
      color: var(--fg-primary);
      background: var(--vscode-sideBar-background);
      white-space: nowrap;
    }

    .message.assistant .message-content td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-color);
      color: var(--fg-primary);
      vertical-align: top;
    }

    .message.assistant .message-content tbody tr:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .message.assistant .message-content tbody tr:last-child td {
      border-bottom: none;
    }

  </style>
</head>
<body>
  <div id="chat-container">
    <div id="welcome" class="welcome-message">
      <h2>Pi coding agent</h2>
    </div>
  </div>

  <div id="live-panel"></div>

  <div id="attachment-bar"></div>

  <div id="input-area">
    <textarea id="prompt-input" placeholder="Ask pi to do something..." rows="1" disabled></textarea>
    <div id="steer-split">
      <button id="send-button" disabled title="Submit (Enter)">↵</button>
      <button id="steer-dropdown" class="hidden" title="Switch to Queue">▾</button>
    </div>
    <button id="abort-button" class="hidden">■ Stop</button>
  </div>

  <div id="pi-status-bar">
    <span id="pi-sb-dot" style="flex-shrink:0; font-weight:700;">○</span>
    <div class="pi-sb-item" id="pi-sb-model" title="Click to change model">π Pi</div>
    <div class="pi-sb-item" id="pi-sb-thinking" title="Click to change thinking level">thinking: off</div>
    <div class="pi-sb-item" id="pi-sb-effort" title="Click to change effort">effort: auto</div>
    <div class="pi-sb-item spacer"></div>
    <div class="pi-sb-item" id="pi-sb-usage" title="Click to set context budget">0%</div>
    <div class="pi-sb-item" id="pi-sb-settings" title="Settings">⚙</div>
  </div>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="settings-overlay" id="settings-overlay"></div>
  <div class="slash-autocomplete" id="slash-autocomplete"></div>

  <script nonce="${nonce}" src="${morphdomUri}"></script>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${coreUri}"></script>
  <script nonce="${nonce}" src="${toolsUri}"></script>
  <script nonce="${nonce}" src="${appUri}"></script>

</body>
</html>`;
  }

  /** Open VS Code quick pick to pick a model for the current session */
  private async triggerModelPicker() {
    await this.piService.pickModel();
  }

  /** Open VS Code quick pick to pick thinking level */
  private async triggerThinkingPicker() {
    await this.piService.pickThinkingLevel();
  }

  /** Open VS Code quick pick to set context budget */
  async triggerContextBudgetPicker() {
    const ps = this.piService;
    const current = ps.getContextBudget();
    const budgets = [
      { label: "Model default", value: 0, description: "Use the model's built-in context window" },
      { label: "100K tokens", value: 100000, description: "Compact at ~0.1M" },
      { label: "200K tokens", value: 200000, description: "Compact at ~0.2M" },
      { label: "500K tokens", value: 500000, description: "Compact at ~0.5M" },
      { label: "1M tokens", value: 1000000, description: "Compact at ~1M" },
    ];
    const items = budgets.map((b) => ({
      label: `${b.label}${b.value === current ? " $(check)" : ""}`,
      description: b.description,
      value: b.value,
    }));
    const picked = await vscode.window.showQuickPick(items,
      { placeHolder: "Select per-session token budget. Takes effect on next session." },
    );
    if (!picked) { return; }
    await ps.setContextBudget(picked.value);
    vscode.window.showInformationMessage(
      picked.value === 0
        ? "Context budget: model default. Restart session to apply."
        : `Context budget set to ${formatBudget(picked.value)}. Restart session to apply.`,
    );
  }

  /** Open VS Code quick pick to pick effort */
  async triggerEffortPicker() {
    const ps = this.piService;
    const levels = [
      { label: "auto", description: "Let the model decide" },
      { label: "none", description: "No effort" },
      { label: "low", description: "Low effort" },
      { label: "medium", description: "Medium effort" },
      { label: "high", description: "High effort" },
    ];
    const currentEffort = ps.effort || "auto";
    const items = levels.map((l) => ({
      label: `${l.label === currentEffort ? "$(check) " : ""}${l.label}`,
      description: l.description,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select effort level" });
    if (!picked) { return; }
    await ps.setEffort(picked.label);
  }

  /** Open VS Code quick pick for settings */
  private async triggerSettingsPicker() {
    const ps = this.piService;
    const makeToggleLabel = (name: string, on: boolean) =>
      `${on ? "$(check)" : "$(circle-outline)"} ${name}`;

    const items: vscode.QuickPickItem[] = [
      {
        label: makeToggleLabel("Auto-compaction", ps.autoCompactionEnabled),
        description: "Automatically compact context when limit is hit",
      },
      {
        label: makeToggleLabel("Auto-retry", ps.autoRetryEnabled),
        description: "Automatically retry on recoverable errors",
      },
      {
        label: makeToggleLabel("Show images", ps.showImages),
        description: "Display image attachments in chat",
      },
      {
        label: "$(graph) Context budget",
        description: `Current: ${ps.getContextBudget() === 0 ? "model default" : formatBudget(ps.getContextBudget())}`,
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Pi settings — select to toggle or change",
    });
    if (!picked) { return; }

    if (picked.label.includes("Auto-compaction")) {
      await ps.toggleAutoCompaction();
    } else if (picked.label.includes("Auto-retry")) {
      await ps.toggleAutoRetry();
    } else if (picked.label.includes("Show images")) {
      await ps.toggleShowImages();
    } else if (picked.label.includes("Context budget")) {
      await this.triggerContextBudgetPicker();
    }
  }

  dispose() {
    this.cleanupPiListener();
    this.disposables.forEach((d) => d.dispose());
    this.panel?.dispose();
  }
}

function formatBudget(tokens: number): string {
  if (tokens < 1000) { return tokens.toString(); }
  if (tokens < 1000000) { return (tokens / 1000).toFixed(0) + "K"; }
  return (tokens / 1000000).toFixed(1) + "M";
}
