import * as vscode from "vscode";
import { PiService } from "./pi-service.js";

export class PiChatViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _piService: PiService | null = null;
  private _disposables: vscode.Disposable[] = [];

  // Tab indicator state
  private _tabInitialized = false;
  private _tabStreaming = false;
  private _tabSummary: string | null = null;
  private _sidebarLoadedUpTo = 0;

  // Callbacks set by extension.ts for accessing session data
  onGetSessionsTree: (() => void) | null = null;
  onGetSessionEntries: ((sessionId: string) => void) | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    if (this._piService) {
      this.attachService(this._piService);
      this.updateTitle();
      this.sendStatus(this._piService);
      this.replayMessages();
    }

    this.setupWebviewHandlers(webviewView);
  }

  // ── Webview message handling ────────────────────────

  private setupWebviewHandlers(webviewView: vscode.WebviewView): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let statusInterval: any = null;
    const startPolling = (): void => {
      if (statusInterval) {
        return;
      }
      statusInterval = setInterval(() => {
        const ps = this._piService;
        if (!ps) {
          return;
        }
        const model = ps.model;
        this.postMessage({
          type: "status",
          data: {
            model: model?.id ?? "loading...",
            thinkingLevel: ps.thinkingLevel,
            effort: ps.effort,
            ready: model !== null,
          },
        });
        if (model !== null && statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
          this._tabInitialized = true;
          this.updateTitle();
        }
      }, 500);
    };
    const cleanupInterval = {
      dispose: () => {
        if (statusInterval) {
          clearInterval(statusInterval);
        }
      },
    };
    this._disposables.push(cleanupInterval);

    webviewView.webview.onDidReceiveMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (message: any) => {
        switch (message.type) {
          case "prompt":
            if (this._piService) {
              this._piService
                .sendPrompt(message.text, message.images, message.mode)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .catch((error: any) => {
                  let errMsg = error.message ?? String(error);
                  if (/api.?key|login|authenticate|provider/i.test(errMsg)) {
                    errMsg +=
                      "\n\n[Set up an API key →](https://pi.dev/docs/latest/quickstart)";
                  }
                  this.postMessage({
                    type: "error",
                    data: { message: errMsg },
                  });
                });
            }
            break;

          case "abort":
            await this._piService?.abort();
            break;

          case "cycleModel":
            await this._piService?.cycleModel();
            break;

          case "setThinkingLevel":
            if (this._piService) {
              await this._piService.setThinkingLevel(message.level);
            }
            break;

          case "setEffort":
            if (this._piService) {
              await this._piService.setEffort(message.effort);
            }
            break;

          case "pickModel":
            void this._piService?.pickModel();
            break;

          case "pickThinkingLevel":
            void this._piService?.pickThinkingLevel();
            break;

          case "pickEffort":
            void this.triggerEffortPicker();
            break;

          case "switchTab":
            webviewView.webview.postMessage({
              type: "tabChanged",
              data: { tab: message.tab },
            });
            break;

          case "getSessionsTree":
            this.onGetSessionsTree?.();
            break;

          case "getSessionEntries":
            this.onGetSessionEntries?.(message.sessionId);
            break;

          case "newSession":
            await this._piService?.newSession();
            this.postMessage({ type: "sessionReset" });
            // Refresh history list
            {
              const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
              const sessions = await PiService.listSessions(cwd);
              this.postMessage({ type: "sessionsList", data: sessions ?? [], activePath: null });
            }
            break;

          case "resumeSession":
            if (this._piService) {
              const result = await this._piService.resumeSession(message.path);
              this.postMessage({ type: "resumeResult", data: result });
            }
            break;

          case "loadMoreMessages":
            void this.handleLoadMoreMessages();
            break;

          case "listSessions":
            if (this._piService && this._piService.sdkRoot) {
              const cwd =
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                process.cwd();
              const sessions = await PiService.listSessions(cwd);
              const activePath = this._piService?.sessionFilePath ?? null;
              this.postMessage({
                type: "sessionsList",
                data: sessions ?? [],
                activePath,
              });
            }
            break;

          case "deleteSession":
            if (message.path) {
              const confirm = await vscode.window.showWarningMessage(
                "Delete this session permanently?",
                { modal: true },
                "Delete",
              );
              if (confirm !== "Delete") {
                break;
              }
              await PiService.deleteSessionFile(message.path);
              // Refresh list after deletion
              const cwd2 =
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                process.cwd();
              const sessions2 = await PiService.listSessions(cwd2);
              const activePath = this._piService?.sessionFilePath ?? null;
              this.postMessage({
                type: "sessionsList",
                data: sessions2 ?? [],
                activePath,
              });
            }
            break;

          case "toggleAutoCompaction":
            await this._piService?.toggleAutoCompaction();
            break;

          case "toggleAutoRetry":
            await this._piService?.toggleAutoRetry();
            break;

          case "toggleShowImages":
            await this._piService?.toggleShowImages();
            break;

          case "openFile":
            if (message.path && typeof message.path === "string") {
              vscode.window.showTextDocument(vscode.Uri.file(message.path));
            }
            break;

          case "setFontSize":
            if (typeof message.fontSize === "number") {
              await vscode.workspace
                .getConfiguration("pi-code-gui")
                .update(
                  "fontSize",
                  message.fontSize,
                  vscode.ConfigurationTarget.Global,
                );
            }
            break;

          case "openSettings":
            void this.triggerSettingsPicker();
            break;

          case "getSettings":
            const cfg = vscode.workspace.getConfiguration("pi-code-gui");
            this.postMessage({
              type: "settingsUpdate",
              data: {
                fontSize: cfg.get("fontSize") ?? 14,
                defaultThinkingState: cfg.get("defaultThinkingState") ?? "collapsed",
                defaultReadState: cfg.get("defaultReadState") ?? "collapsed",
                defaultWriteState: cfg.get("defaultWriteState") ?? "expanded",
                defaultEditState: cfg.get("defaultEditState") ?? "expanded",

                defaultBashState: cfg.get("defaultBashState") ?? "expanded",
              },
            });
            break;

          case "setDefaultState":
            if (message.key && message.value) {
              await vscode.workspace
                .getConfiguration("pi-code-gui")
                .update(message.key, message.value, vscode.ConfigurationTarget.Global);
            }
            break;
        }
      },
    );

    webviewView.onDidDispose(() => {
      this._disposables.forEach((d) => d.dispose());
      this._disposables = [];
    });

    startPolling();
  }

  // ── Event forwarding ───────────────────────────────

  /** Attach a PiService and register as an event listener. */
  attachService(piService: PiService): void {
    if (this._piService === piService) {
      // Already listening to this service — just replay messages
      if (this._view) { this.replayMessages(); }
      return;
    }
    if (this._piService) { this.detachService(); }
    this._piService = piService;
    this._disposables.push({
      dispose: piService.onEvent((event) => this.handleAgentEvent(event)),
    });
    if (this._view) {
      this.updateTitle();
      this.sendStatus(piService);
      this.replayMessages();
    }
  }

  /** Send status and replay session messages to the webview. */
  private replayMessages(): void {
    var ps = this._piService;
    if (!ps || !this._view || !ps.initialized) { return; }
    var pm = (event: Record<string, unknown>): void => this.postMessage(event);
    pm({ type: "sessionReset" });
    var entries = ps.sessionManagerInstance?.getEntries?.() ?? [];
    var total = entries.length;
    var initialLimit = Math.min(50, total);
    var from = Math.max(0, total - initialLimit);
    this._sidebarLoadedUpTo = initialLimit;
    pm({ type: "batch-start", data: { hasEntries: initialLimit > 0, totalEntries: total, loadedCount: initialLimit } });
    void ps.sendInitialMessages(pm, from, initialLimit).then(function () {
      pm({ type: "batch-end", data: { hasEntries: initialLimit > 0 } });
    });
  }

  /** Send current status to the webview. */
  private sendStatus(piService: PiService): void {
    if (!this._view) { return; }
    var model = piService.model;
    this.postMessage({ type: "status", data: { model: model?.id ?? "loading...", thinkingLevel: piService.thinkingLevel, effort: piService.effort, ready: model !== null } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    var ps = piService as any;
    var stats = ps.getUsageStats?.() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
    this.postMessage({ type: "status-update", data: { model: ps.model?.id ?? ps.model?.name ?? "pi", thinkingLevel: ps.thinkingLevel, effort: ps.effort, isStreaming: false, sessionId: ps.sessionId ?? undefined, usage: stats, contextBudget: ps.getContextBudget() } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleAgentEvent(event: any): void {
    if (!this._view) {
      return;
    }

    // Track streaming state for title indicator
    if (event.type === "assistant-start") {
      this._tabStreaming = true;
      this.updateTitle();
    } else if (event.type === "assistant-end") {
      this._tabStreaming = false;
      this.updateTitle();
    } else if (event.type === "semantic-title" && event.data?.title) {
      this._tabSummary = event.data.title;
      this.updateTitle();
    }

    // Forward all events directly — PiServiceEvent already matches ExtensionToWebview format
    this.postMessage(event);
  }

  // ── Title & tab indicator ──────────────────────────

  updateTitle(): void {
    if (!this._view) {
      return;
    }

    const indicator = this._tabStreaming ? "●" : "○";
    const summary = this._tabSummary ?? "";
    const title = summary ? `${indicator} ${summary}` : "Pi Code Gui";

    this._view.title = title;
  }

  // ── Webview HTML ───────────────────────────────────

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /** Load older session messages (triggered by scrolling to top in sidebar webview). */
  private async handleLoadMoreMessages(): Promise<void> {
    const ps = this._piService;
    if (!ps) { return; }
    const allEntries = ps.sessionManagerInstance?.getEntries?.() ?? [];
    const total = allEntries?.length ?? 0;
    if (this._sidebarLoadedUpTo >= total) { return; }
    const remaining = total - this._sidebarLoadedUpTo;
    const count = Math.min(50, remaining);
    const from = Math.max(0, total - this._sidebarLoadedUpTo - count);
    if (count <= 0) { return; }
    this._sidebarLoadedUpTo += count;
    this.postMessage({
      type: "batch-start",
      data: { hasEntries: true, prepend: true, totalEntries: total, loadedCount: this._sidebarLoadedUpTo },
    });
    await ps.sendInitialMessages(
      (event) => this.postMessage(event),
      from,
      count,
    );
    this.postMessage({ type: "batch-end", data: { hasEntries: true } });
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "bundle.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css"),
    );

    return `<!DOCTYPE html>
<html lang="en" data-view-mode="sidebar">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi Code Gui</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body data-view-mode="sidebar">
  <div id="panel-chat" class="sidebar-panel active">
    <div id="chat-container">
      <div id="welcome" class="welcome-message">
        <h2>Pi coding agent</h2>
      </div>
    </div>
    <div id="live-panel"></div>
    <div id="attachment-bar"></div>
    <div id="input-area">
      <textarea id="prompt-input" placeholder="Ask pi to do something..." rows="1" disabled></textarea>
    </div>
  </div>


  <div id="pi-status-bar">
    <div class="pi-sb-item" id="pi-sb-model" title="Click to change model" style="grid-area: m;">model: ...</div>
    <div class="pi-sb-item" id="pi-sb-effort" title="Click to change effort" style="grid-area: e;">effort: auto</div>
    <div class="pi-sb-item" id="pi-sb-thinking" title="Click to change thinking level" style="grid-area: t;">thinking: off</div>
    <div class="pi-sb-item" id="pi-sb-usage" title="Click to set context budget" style="grid-area: u;">0%</div>
    <div id="steer-split" style="grid-area: btn; display: flex; align-items: center; justify-content: flex-end; align-self: center;">
      <button id="abort-button" class="hidden" style="margin-right: 2px;">■ Stop</button>
      <button id="send-button" disabled title="Submit (Enter)">↵</button>
      <button id="steer-dropdown" class="hidden" title="Switch to Queue">▾</button>
    </div>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="slash-autocomplete" id="slash-autocomplete"></div>

  <script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
  }

  // ── Quick pickers ──────────────────────────────

  private async triggerEffortPicker(): Promise<void> {
    const ps = this._piService;
    if (!ps) {
      return;
    }
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
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select effort level",
    });
    if (!picked) {
      return;
    }
    await ps.setEffort(picked.label);
  }

  // ── API for extension.ts ───────────────────────────

  /** Detach the current PiService and clean up its event listener. */
  detachService(): void {
    // Dispose only the listener disposables (leave view/webview handlers)
    const toDispose = this._disposables.filter(function (d) {
      return d !== null && d !== undefined;
    });
    for (var i = 0; i < toDispose.length; i++) {
      toDispose[i].dispose();
    }
    this._disposables = [];
    this._piService = null;
    this._sidebarLoadedUpTo = 0;
    this._tabInitialized = false;
    this._tabStreaming = false;
    this._tabSummary = null;
  }

  /** Switch to a different PiService (called when user clicks another session in the tree). */
  switchSession(piService: PiService): void {
    this.detachService();
    this.attachService(piService);
  }

  /** Insert a command or file reference into the sidebar chat input. */
  postCommand(command: string): void {
    this._view?.webview.postMessage({ type: "insertCommand", command });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postMessage(message: any): void {
    this._view?.webview.postMessage(message);
  }

  get visible(): boolean {
    return this._view?.visible ?? false;
  }

  get piService(): PiService | null { return this._piService; }

  /** Open VS Code quick pick for unified settings. */
  async triggerSettingsPicker(): Promise<void> {
    var ps = this._piService;
    if (!ps) { return; }
    var cfg = vscode.workspace.getConfiguration("pi-code-gui");
    var makeToggle = function (name: string, on: boolean): string {
      return (on ? "$(check) " : "$(circle-outline) ") + name;
    };
    var items: vscode.QuickPickItem[] = [
      { label: "$(eye) Font size", description: "Current: " + (cfg.get<number>("fontSize") || "default") },
      { label: makeToggle("Auto-compaction", ps.autoCompactionEnabled), description: "Auto-compact context when limit hit" },
      { label: makeToggle("Auto-retry", ps.autoRetryEnabled), description: "Auto-retry on recoverable errors" },
      { label: makeToggle("Show images", ps.showImages), description: "Display image attachments in chat" },
      { label: makeToggle("💡 Thinking", cfg.get("defaultThinkingState") !== "collapsed"), description: "Default state for thinking blocks" },
      { label: makeToggle("📖 Read", cfg.get("defaultReadState") !== "collapsed"), description: "Default state for read tool blocks" },
      { label: makeToggle("✏️ Write", cfg.get("defaultWriteState") === "expanded"), description: "Default state for write tool blocks" },
      { label: makeToggle("🔧 Edit", cfg.get("defaultEditState") === "expanded"), description: "Default state for edit tool blocks" },
      { label: makeToggle("💻 Bash", cfg.get("defaultBashState") === "expanded"), description: "Default state for bash execution blocks" },
    ];
    var picked = await vscode.window.showQuickPick(items, { placeHolder: "Pi settings — click to toggle" });
    if (!picked) { return; }
    var label = picked.label;
    if (label.includes("Font size")) {
      var fontSize = await vscode.window.showInputBox({ placeHolder: "Font size in px (0 = editor default)", value: String(cfg.get<number>("fontSize") ?? 0) });
      if (fontSize !== undefined) {
        var num = parseInt(fontSize);
        if (!isNaN(num) && num >= 0 && num <= 30) {
          await cfg.update("fontSize", num, vscode.ConfigurationTarget.Global);
          this.postMessage({ type: "settingsUpdate", data: { fontSize: num } });
        }
      }
    } else if (label.includes("Auto-compaction")) {
      await ps.toggleAutoCompaction();
    } else if (label.includes("Auto-retry")) {
      await ps.toggleAutoRetry();
    } else if (label.includes("Show images")) {
      await ps.toggleShowImages();
    } else if (label.includes("Thinking")) {
      var val = cfg.get("defaultThinkingState") === "collapsed" ? "expanded" : "collapsed";
      await cfg.update("defaultThinkingState", val, vscode.ConfigurationTarget.Global);
    } else if (label.includes("Read")) {
      var val = cfg.get("defaultReadState") === "collapsed" ? "expanded" : "collapsed";
      await cfg.update("defaultReadState", val, vscode.ConfigurationTarget.Global);
    } else if (label.includes("Write")) {
      var val = cfg.get("defaultWriteState") === "expanded" ? "collapsed" : "expanded";
      await cfg.update("defaultWriteState", val, vscode.ConfigurationTarget.Global);
    } else if (label.includes("Edit")) {
      var val = cfg.get("defaultEditState") === "expanded" ? "collapsed" : "expanded";
      await cfg.update("defaultEditState", val, vscode.ConfigurationTarget.Global);
    } else if (label.includes("Bash")) {
      var val = cfg.get("defaultBashState") === "expanded" ? "collapsed" : "expanded";
      await cfg.update("defaultBashState", val, vscode.ConfigurationTarget.Global);
    }
    // Send block defaults FIRST (direct postMessage is immediate)
    this.postMessage({ type: "settingsUpdate", data: {
      defaultThinkingState: cfg.get("defaultThinkingState"),
      defaultReadState: cfg.get("defaultReadState"),
      defaultWriteState: cfg.get("defaultWriteState"),
      defaultEditState: cfg.get("defaultEditState"),
      defaultBashState: cfg.get("defaultBashState"),
    } });
    // Then emitSettings — its settings-update may arrive later but won't override
    this.piService?.emitSettings?.();
  }
}
