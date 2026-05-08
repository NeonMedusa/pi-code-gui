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
  private _tabPulseOn = false;
  private _tabPulseInterval: any = null;
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

  async show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "pi-chat",
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
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-init-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-init-dark.svg"),
    };

    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupWebviewHandlers();
    this.setupServiceHandlers();

    this.panel.onDidDispose(() => {
      this.stopTabPulse();
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
    if (!this.panel) {return;}

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
          case "prompt":
            try {
              const msg = message as any;
              await this.piService.sendPrompt(msg.text, msg.images);
            } catch (error: any) {
              let errMsg = error.message ?? String(error);
              if (/api.?key|login|authenticate|provider/i.test(errMsg)) {
                errMsg += "\n\n[Set up an API key →](https://pi.dev/docs/latest/quickstart)";
              }
              this.postMessage({
                type: "error",
                data: { message: errMsg },
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

      // Capture first user input for tab title summary
      if (event.type === "chat-message" && event.data?.role === "user" && !this._tabSummary) {
        const text: string = event.data?.content ?? "";
        if (text.trim()) {
          this.piService.generateTabSummary(text).then((summary) => {
            if (summary) {
              this._tabSummary = summary;
              this.updateTabIndicator();
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

  /** Update the tab icon and title to indicate streaming / idle / init state. */
  private updateTabIndicator() {
    if (!this.panel) { return; }

    const media = (uri: string) =>
      vscode.Uri.joinPath(this.context.extensionUri, "media", uri);

    if (!this._tabInitialized) {
      this.panel.iconPath = {
        light: media("pi-dot-init-light.svg"),
        dark: media("pi-dot-init-dark.svg"),
      };
      this.panel.title = "Pi Code Gui";
      this.stopTabPulse();
      return;
    }

    const label = this._tabSummary ?? "Pi";

    if (this._tabStreaming) {
      // Start pulsing the dot (slow flash)
      this.startTabPulse();
      this.panel.title = label;
    } else {
      this.stopTabPulse();
      // Green dot = idle / ready
      this.panel.iconPath = {
        light: media("pi-dot-idle-light.svg"),
        dark: media("pi-dot-idle-dark.svg"),
      };
      this.panel.title = label;
    }
  }

  private startTabPulse() {
    if (this._tabPulseInterval) { return; }
    this._tabPulseOn = true;
    // Slow ~1.2s cycle: 600ms each state
    this._tabPulseInterval = setInterval(() => {
      if (!this.panel) { return; }
      this._tabPulseOn = !this._tabPulseOn;
      const label = this._tabSummary ?? "Pi";
      this.panel.title = label;
      // Also toggle icon to show colored active dot while streaming
      if (this._tabPulseOn) {
        this.panel.iconPath = {
          light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-active-light.svg"),
          dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-active-dark.svg"),
        };
      } else {
        this.panel.iconPath = {
          light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-idle-light.svg"),
          dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-dot-idle-dark.svg"),
        };
      }
    }, 600);
  }

  private stopTabPulse() {
    if (this._tabPulseInterval) {
      clearInterval(this._tabPulseInterval);
      this._tabPulseInterval = null;
    }
    this._tabPulseOn = false;
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"),
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

    .thinking-block summary {
      cursor: pointer;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--fg-secondary);
    }

    .thinking-block .thinking-content {
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 6px;
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
      max-height: 360px;
      overflow-y: auto;
    }

    .tool-block .tool-result p {
      margin: 4px 0;
      white-space: pre-wrap;
      word-break: break-word;
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

    .status-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 12px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
      font-size: 0.8em;
      color: var(--fg-secondary);
      min-height: 32px;
    }

    .status-bar .status-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .status-bar .status-item.clickable {
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .status-bar .status-item.clickable:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .status-bar .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-bar .status-dot.streaming {
      background: var(--accent);
      animation: pulse 1.5s ease-in-out infinite;
    }

    .status-bar .status-dot.idle {
      background: var(--success);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
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
    }

    .live-card:last-child {
      border-bottom: none;
    }

    .live-card .live-card-label {
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      font-size: 0.75em;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
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
      border-radius: 8px;
      padding: 8px 18px;
      cursor: pointer;
      font-size: 1.2em;
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

    #prompt-input:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    #abort-button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 0.9em;
      align-self: flex-start;
    }

    #abort-button:hover {
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

    .diff-line-removed {
      color: var(--vscode-diffEditor-removedTextBackground, #f14c4c);
      background: rgba(255,0,0,0.08);
    }

    .diff-line-added {
      color: var(--vscode-diffEditor-insertedTextBackground, #4ec9b0);
      background: rgba(0,255,0,0.08);
    }

    .diff-line-context {
      color: var(--fg-secondary);
      opacity: 0.7;
    }

    .diff-word-removed {
      background: rgba(255,0,0,0.25);
      border-radius: 2px;
      padding: 0 1px;
    }

    .diff-word-added {
      background: rgba(0,255,0,0.2);
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

    /* ── Turn separator ───────────────────────── */

    .turn-separator {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
      padding: 6px 0;
    }

    .turn-separator .turn-bar {
      flex: 1;
      height: 0;
      border-top: 2px solid var(--accent);
      opacity: 0.35;
    }

    .turn-separator .turn-label {
      font-size: 0.75em;
      font-weight: 600;
      color: var(--accent);
      white-space: nowrap;
      letter-spacing: 0.5px;
    }

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
    <button id="send-button" disabled title="Submit (Enter)">↵</button>
    <button id="abort-button" class="hidden">Stop</button>
  </div>

  <div class="status-bar" id="status-bar">
    <span class="status-item">
      <span class="status-dot idle" id="status-dot"></span>
    </span>
    <span class="status-item clickable" id="status-model-picker" title="Click to change model">
      <span id="status-model">Initializing...</span>
    </span>
    <span class="status-item clickable" id="status-thinking-picker" title="Click to change thinking level">
      <span id="status-thinking"></span>
    </span>
    <span class="status-item clickable" id="status-effort-picker" title="Click to change effort (only for certain models)">
      <span id="status-effort"></span>
    </span>
    <span class="status-item clickable" id="status-usage" title="Click to set context budget">
      <span id="status-usage-text"></span>
    </span>
    <span class="status-item clickable" id="status-settings-btn" title="Settings">
      <span>⚙</span>
    </span>
    <span class="status-item">
      <span id="status-extra"></span>
    </span>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="settings-overlay" id="settings-overlay"></div>
  <div class="slash-autocomplete" id="slash-autocomplete"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>

</body>
</html>`;
  }

  /** Open VS Code quick pick to pick a model for the current session */
  private async triggerModelPicker() {
    const ps = this.piService;
    let modelItems: Array<{ label: string; description: string; provider: string; modelId: string }> = [];

    // Use the PiService's getAvailableModels for dynamic registry discovery
    try {
      const available = await ps.getAvailableModels();
      if (available.length > 0) {
        modelItems = available.map((m) => ({
          label: m.name || m.id,
          description: m.provider,
          provider: m.provider,
          modelId: m.id,
        }));
      }
    } catch { /* fall through */ }

    // Fallback: static list of common models
    if (modelItems.length === 0) {
      const fallbackModels = [
        { label: "Claude Sonnet 4.5", description: "anthropic", provider: "anthropic", modelId: "claude-sonnet-4-5" },
        { label: "Claude Haiku 4.5", description: "anthropic", provider: "anthropic", modelId: "claude-haiku-4-5" },
        { label: "Claude Opus 4.5", description: "anthropic", provider: "anthropic", modelId: "claude-opus-4-5" },
        { label: "GPT 4o", description: "openai", provider: "openai", modelId: "gpt-4o" },
        { label: "Gemini 2.5 Pro", description: "google", provider: "google", modelId: "gemini-2.5-pro" },
        { label: "DeepSeek V3", description: "deepseek", provider: "deepseek", modelId: "deepseek-chat" },
      ];
      modelItems = fallbackModels;
    }

    const currentId = ps.model?.id;
    const defModel = ps.getDefaultModel();
    const items = modelItems.map((m) => {
      const isDefault = defModel && m.provider === defModel.provider && m.modelId === defModel.id;
      const isCurrent = m.modelId === currentId;
      return {
        label: `${m.label}${isDefault ? " \u2605" : ""}${isCurrent ? " $(check)" : ""}`,
        description: m.description || m.provider,
        provider: m.provider,
        modelId: m.modelId,
        isDefault,
      };
    });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model (\u2605 = default)" });
    if (!picked) { return; }

    await ps.setModel(picked.provider, picked.modelId);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this model for future sessions" }],
        { placeHolder: `Use ${picked.label.replace(/ \u2605| \$\(check\)/g, "")} as the default?` },
      );
      if (save) { ps.saveDefaultModel(); }
    }
  }

  /** Open VS Code quick pick to pick thinking level */
  private async triggerThinkingPicker() {
    const ps = this.piService;
    const levels = [
      { label: "off", description: "No thinking" },
      { label: "minimal", description: "Minimal thinking" },
      { label: "low", description: "Brief thinking" },
      { label: "medium", description: "Balanced thinking" },
      { label: "high", description: "Extended thinking" },
      { label: "xhigh", description: "Maximum thinking" },
    ];
    const current = ps.thinkingLevel;
    const defLevel = ps.getDefaultThinking();
    const items = levels.map((l) => {
      const isDefault = l.label === defLevel;
      return {
        label: `${l.label === current ? "$(check) " : ""}${l.label}${isDefault ? " \u2605" : ""}`,
        description: l.description,
        level: l.label,
        isDefault,
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select thinking level (\u2605 = default)" });
    if (!picked) { return; }
    await ps.setThinkingLevel(picked.level);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this thinking level for future sessions" }],
        { placeHolder: `Use "${picked.level}" thinking as the default?` },
      );
      if (save) { ps.saveDefaultThinking(); }
    }
  }

  /** Open VS Code quick pick to pick context budget */
  private async triggerContextBudgetPicker() {
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
  private async triggerEffortPicker() {
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
