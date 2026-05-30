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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this._piService
                .sendPrompt(message.text, message.images, message.mode)
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

          case "getSettings":
            const cfg = vscode.workspace.getConfiguration("pi-code-gui");
            this.postMessage({
              type: "settingsUpdate",
              data: { fontSize: cfg.get("fontSize") ?? 0 },
            });
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
    this._piService = piService;
    this._disposables.push({
      dispose: piService.onEvent((event) => this.handleAgentEvent(event)),
    });
    if (this._view) {
      this.updateTitle();
      const model = piService.model;
      this.postMessage({
        type: "status",
        data: {
          model: model?.id ?? "loading...",
          thinkingLevel: piService.thinkingLevel,
          effort: piService.effort,
          ready: model !== null,
        },
      });
      // Send initial status-update for context budget / usage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stats = (piService as any).getUsageStats?.() ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextPercent: null,
        contextWindow: 0,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionId = (piService as any).sessionId ?? undefined;
      this.postMessage({
        type: "status-update",
        data: {
          model: piService.model?.id ?? piService.model?.name ?? "pi",
          thinkingLevel: piService.thinkingLevel,
          effort: piService.effort,
          isStreaming: false,
          sessionId,
          usage: stats,
          contextBudget: piService.getContextBudget(),
        },
      });
      // Replay existing session entries to the sidebar webview
      void piService.sendInitialMessages((event) => this.postMessage(event));
    }
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
      <div id="steer-split">
        <button id="send-button" disabled title="Submit (Enter)">↵</button>
        <button id="steer-dropdown" class="hidden" title="Switch to Queue">▾</button>
      </div>
      <button id="abort-button" class="hidden">■ Stop</button>
    </div>
  </div>

  <div id="panel-history" class="sidebar-panel">
    <div class="sidebar-panel-header">
      <button id="btn-current-session" class="panel-action-btn">◂ Current Session</button>
      <button id="btn-new-session" class="panel-action-btn">+ New Session</button>
    </div>
    <div id="history-content">
      <p class="sidebar-placeholder">Loading sessions...</p>
    </div>
  </div>

  <div id="panel-packages" class="sidebar-panel">
    <div class="sidebar-panel-header">
      <span class="panel-title">Packages</span>
    </div>
    <div class="sidebar-panel-body">
      <p class="sidebar-placeholder">Coming soon</p>
    </div>
  </div>

  <div id="panel-settings" class="sidebar-panel">
    <div class="sidebar-panel-header">
      <span class="panel-title">Settings</span>
    </div>
    <div class="sidebar-panel-body">
      <div class="setting-row">
        <label class="setting-label">Font size</label>
        <input type="number" id="setting-font-size" class="setting-number" min="0" max="30" value="0">
        <span class="setting-unit">px (0 = default)</span>
      </div>
    </div>
  </div>
  </div>

  <div id="pi-status-bar">
    <span id="pi-sb-dot" style="flex-shrink:0; font-weight:700;">○</span>
    <div class="pi-sb-item" id="pi-sb-model" title="Click to change model">π Pi</div>
    <div class="pi-sb-item" id="pi-sb-thinking" title="Click to change thinking level">thinking: off</div>
    <div class="pi-sb-item" id="pi-sb-effort" title="Click to change effort">effort: auto</div>
    <div class="pi-sb-item" id="pi-sb-usage" title="Click to set context budget" style="margin-left:auto">0%</div>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="settings-overlay" id="settings-overlay"></div>
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postMessage(message: any): void {
    this._view?.webview.postMessage(message);
  }

  get visible(): boolean {
    return this._view?.visible ?? false;
  }
}
