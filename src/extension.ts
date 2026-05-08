import * as vscode from "vscode";
import { PiService } from "./pi-service.js";
import { PiWebviewPanel } from "./webview-panel.js";
import { registerPhase3Commands } from "./phase3-commands.js";
import { registerPhase4Commands } from "./phase4-commands.js";

// ── Session window management ──────────────────────────

interface SessionWindow {
  id: string;
  piService: PiService;
  webviewPanel: PiWebviewPanel;
  initialized: boolean;
  isStreaming: boolean;
  /** Cached display label derived from session name or tab summary */
  label: string;
}

const sessions: SessionWindow[] = [];
let sessionCounter = 0;

let statusBarItem: vscode.StatusBarItem | null = null;
let sessionTreeProvider: MultiSessionTreeProvider | null = null;
let sessionTreeView: vscode.TreeView<SessionTreeItem> | null = null;

/** The primary (first) session — used for status bar and tree provider */
function primarySession(): SessionWindow | undefined {
  return sessions[0];
}

/** Create a new session window pair */
function createSessionWindow(context: vscode.ExtensionContext): SessionWindow {
  const id = `session-${++sessionCounter}`;
  const piService = new PiService();
  const webviewPanel = new PiWebviewPanel(context, piService);
  const sw: SessionWindow = {
    id, piService, webviewPanel,
    initialized: false, isStreaming: false,
    label: getGenericSessionLabel(id),
  };

  // When the webview panel is closed (tab closed):
  // 1. Save the session to disk
  // 2. Remove it from open sessions
  // If saved successfully, it will appear in Past Sessions on next refresh.
  webviewPanel.onDispose = handlePanelDispose(sw);

  sessions.push(sw);
  return sw;
}

/** Generate a generic "Session N" label from the internal id. */
function getGenericSessionLabel(id: string): string {
  const num = id.replace("session-", "");
  return `Session ${num}`;
}

/** Build a dispose handler that saves and removes a session when its panel closes. */
function handlePanelDispose(sw: SessionWindow): (piService: PiService) => void {
  return () => {
    // The SessionManager auto-persists entries as they are written during
    // conversation, so the session file already exists on disk.  We just
    // need to clean up and remove it from the open-sessions list so it
    // appears under Past Sessions.
    sw.piService.dispose();
    removeSession(sw);

    // Refresh past sessions list from disk so the closed session appears
    // under Past Sessions immediately.
    refreshPastSessionsList();
  };
}

// ── Activate ───────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  console.log("Pi Code Gui extension activating...");

  // ── Step 1: Register ALL commands immediately ──────────

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.codeAgent", () => {
      const primary = primarySession();
      if (primary) {
        primary.webviewPanel.show();
      } else {
        addSession(context);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.addSession", () => {
      addSession(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.focusSession", (sessionId: string) => {
      const sw = sessions.find((s) => s.id === sessionId);
      if (sw) {
        sw.webviewPanel.show();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.abort", async () => {
      const primary = primarySession();
      if (primary) { await primary.piService.abort(); }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.sendSlashCommand", (cmd: string) => {
      const primary = primarySession();
      if (primary) { primary.webviewPanel.postCommand(cmd); }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.referenceFile", (fp: string) => {
      const primary = primarySession();
      if (primary) { primary.webviewPanel.postCommand(`@${fp}`); }
    }),
  );

  // Reveal a specific session entry — shows the session webview so the user
  // can see the entry in the conversation history.
  // Accepts explicit (sessionId, entryId) args from TreeItem.command click,
  // or falls back to reading the selected tree item from the session tree view
  // (for right-click context menu usage where args are not auto-populated).
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.revealEntry", (sessionId?: string, entryId?: string) => {
      let sw: SessionWindow | undefined;
      let id = entryId;

      if (sessionId) {
        sw = sessions.find((s) => s.id === sessionId);
      }

      // Fallback: read from tree view selection (used by context menu)
      if (!sw || !id) {
        const selection = sessionTreeView?.selection;
        if (selection && selection.length > 0) {
          const item = selection[0] as SessionTreeItem;
          if (item.contextValue === "sessionEntry") {
            const cmdArgs = item.command?.arguments;
            if (cmdArgs && cmdArgs.length >= 2) {
              sw = sessions.find((s) => s.id === cmdArgs[0])!;
              id = cmdArgs[1] as string;
            }
          }
        }
      }

      if (sw && id) {
        sw.webviewPanel.show();
        sw.webviewPanel.postMessage({ type: "revealEntry", entryId: id });
      } else if (sessionId || id) {
        console.log(`[pi-gui] revealEntry: session or entry not found (sessionId=${sessionId}, entryId=${id})`);
      }
    }),
  );

  // Copy the text content of a selected entry from the Sessions tree
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.copyEntryText", async () => {
      const selection = sessionTreeView?.selection;
      if (!selection || selection.length === 0) { return; }
      const item = selection[0] as SessionTreeItem;
      if (item.contextValue !== "sessionEntry") { return; }

      // The tooltip contains the full entry text (label is truncated)
      const text = typeof item.tooltip === "string"
        ? item.tooltip
        : (item.tooltip as vscode.MarkdownString)?.value ?? "";
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Entry text copied to clipboard");
      }
    }),
  );

  // Fork session from a selected entry — branches the session manager to that entry
  // and replaces the agent's messages so further prompts continue from the fork point.
  // Accepts (sessionId, entryId) from TreeItem.command / context-menu auto-arg passing,
  // or reads from tree view selection as fallback.
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.forkSession", async (forkSessionId?: string, forkEntryId?: string) => {
      let resolvedSessionId = forkSessionId;
      let resolvedEntryId = forkEntryId;

      // Fallback: read from tree view selection (right-click context menu)
      if (!resolvedSessionId || !resolvedEntryId) {
        const selection = sessionTreeView?.selection;
        if (selection && selection.length > 0) {
          const item = selection[0] as SessionTreeItem;
          if (item.contextValue === "sessionEntry" && item.command?.arguments) {
            const cmdArgs = item.command.arguments;
            if (cmdArgs.length >= 2) {
              resolvedSessionId = cmdArgs[0] as string;
              resolvedEntryId = cmdArgs[1] as string;
            }
          }
        }
      }

      if (!resolvedSessionId || !resolvedEntryId) {
        vscode.window.showErrorMessage("Cannot fork: missing entry information.");
        return;
      }

      const sw = sessions.find((s) => s.id === resolvedSessionId);
      if (!sw || !sw.piService.sessionManagerInstance) {
        vscode.window.showErrorMessage("Cannot fork: session not found.");
        return;
      }

      try {
        // Wait for any running agent to finish
        if (sw.piService.isStreaming) {
          vscode.window.showInformationMessage("Waiting for current operation to complete before forking...");
          await sw.piService.abort();
        }

        const sm = sw.piService.sessionManagerInstance;

        // Branch the session manager to this entry — discards subsequent messages
        sm.branch(resolvedEntryId!);

        // Get the path entries from root to the fork point
        const path = sm.getPath();

        // Extract messages from path entries for the agent state
        const messages: any[] = [];
        for (const entry of path) {
          if (entry.type === "message" && entry.message) {
            if (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "custom") {
              messages.push(entry.message);
            }
          }
        }

        // Replace the agent's message state with the branched history
        const rawSession = sw.piService.rawSession;
        if (rawSession?.agent?.state) {
          rawSession.agent.state.messages = messages;
        }

        // Clear the webview and re-render from the branched session
        sw.webviewPanel.postMessage({ type: "sessionReset" });
        sw.webviewPanel.show();

        // Re-emit the branched messages to the webview
        // (PiService's sendInitialMessages logic replayed via a helper)
        sw.piService.replayBranchEntries(path);

        sessionTreeProvider?.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Fork failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Resume a past session from the tree view ─────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.resumePastSession", async (filePath?: SessionTreeItem | string) => {
      let resolved: string | undefined;
      // When triggered from a context menu, VS Code passes the tree item as the first arg.
      if (filePath instanceof SessionTreeItem) {
        resolved = (filePath as any).command?.arguments?.[0];
      } else if (typeof filePath === "string") {
        resolved = filePath;
      }
      if (!resolved) {
        const sel = sessionTreeView?.selection?.[0];
        if (sel && (sel as any).contextValue === "pastSessionEntry" && (sel as any).command?.arguments) {
          const arg = (sel as any).command.arguments[0];
          if (typeof arg === "string") { resolved = arg; }
        }
      }
      if (!resolved) {
        vscode.window.showErrorMessage("Cannot resume: missing session file path.");
        return;
      }
      try {
        // Create a new session tab (like Add Pi Session) and resume into it
        const sw = createSessionWindow(context);
        sw.webviewPanel.show();
        sessionTreeProvider?.refresh();
        initSessionInBackground(context, sw, { openPath: resolved });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Resume failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Delete a past session from the tree view ──────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.deletePastSession", async (filePath?: SessionTreeItem | string) => {
      let resolved: string | undefined;
      // When triggered from a context menu, VS Code passes the tree item as the first arg.
      if (filePath instanceof SessionTreeItem) {
        resolved = (filePath as any).command?.arguments?.[0];
      } else if (typeof filePath === "string") {
        resolved = filePath;
      }
      if (!resolved) {
        const sel = sessionTreeView?.selection?.[0];
        if (sel && (sel as any).contextValue === "pastSessionEntry" && (sel as any).command?.arguments) {
          const arg = (sel as any).command.arguments[0];
          if (typeof arg === "string") { resolved = arg; }
        }
      }
      if (!resolved) {
        vscode.window.showErrorMessage("Cannot delete: missing session file path.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        "Delete this session permanently?",
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") { return; }
      try {
        await PiService.deleteSessionFile(resolved);
        await refreshPastSessionsList();
        sessionTreeProvider?.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Delete all past sessions ────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.deleteAllPastSessions", async () => {
      const past = sessionTreeProvider?.pastSessions ?? [];
      if (past.length === 0) {
        vscode.window.showInformationMessage("No past sessions to delete.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete all ${past.length} past sessions permanently?`,
        { modal: true },
        "Delete All",
      );
      if (confirm !== "Delete All") { return; }
      try {
        for (const s of past) {
          await PiService.deleteSessionFile(s.path);
        }
        await refreshPastSessionsList();
        sessionTreeProvider?.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete all failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Filter past sessions ────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.filterPastSessions", async () => {
      const currentFilter = sessionTreeProvider?.pastFilter ?? "";
      const filter = await vscode.window.showInputBox({
        prompt: "Filter past sessions by title or content",
        placeHolder: "Type to filter...",
        value: currentFilter,
      });
      if (filter === undefined) { return; } // cancelled
      if (sessionTreeProvider) {
        sessionTreeProvider.pastFilter = filter;
        sessionTreeProvider.refresh();
      }
    }),
  );

  // Per-session model picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickSessionModel", async (sessionId?: string) => {
      const sw = sessionId ? sessions.find((s) => s.id === sessionId) : primarySession();
      if (!sw || !sw.initialized) { return; }
      // Open model picker for this specific session via its PiService
      const pf = await pickModelForSession(sw.piService);
      if (pf) {
        await sw.piService.setModel(pf.provider, pf.modelId);
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // Per-session thinking level picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickSessionThinking", async (sessionId?: string) => {
      const sw = sessionId ? sessions.find((s) => s.id === sessionId) : primarySession();
      if (!sw || !sw.initialized) { return; }
      const level = await pickThinkingLevel(sw.piService.thinkingLevel);
      if (level) {
        await sw.piService.setThinkingLevel(level);
        updateStatusBar();
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // ── Step 2: Status bar ─────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "pi-code-gui.pickSessionThinking";
  statusBarItem.text = "\u03C0 Pi: off";
  statusBarItem.tooltip = "Click to change thinking level";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── Step 3: Create primary session ─────────────────────
  const primary = createSessionWindow(context);
  primary.webviewPanel.show();

  // ── Step 4: Initialize pi SDK asynchronously ───────────
  initSessionInBackground(context, primary);
}

// ── Add a new session window ──────────────────────────

function addSession(context: vscode.ExtensionContext) {
  const sw = createSessionWindow(context);
  sw.webviewPanel.show();
  sessionTreeProvider?.refresh();
  initSessionInBackground(context, sw, { fresh: true });
}


// ── Initialize a single session ───────────────────────

function ensureTreeProvider(context: vscode.ExtensionContext) {
  if (!sessionTreeProvider) {
    sessionTreeProvider = new MultiSessionTreeProvider(sessions, context);
    sessionTreeView = vscode.window.createTreeView("pi-code-gui.sessions", {
      treeDataProvider: sessionTreeProvider,
    });
    context.subscriptions.push(sessionTreeView);

    // Track expand/collapse of entries headers to preserve state across refreshes
    sessionTreeView.onDidExpandElement((e) => {
      if (e.element.contextValue === "entries-header") {
        sessionTreeProvider!.setEntryHeaderExpanded(e.element.sessionId!, true);
      }
    });
    sessionTreeView.onDidCollapseElement((e) => {
      if (e.element.contextValue === "entries-header") {
        sessionTreeProvider!.setEntryHeaderExpanded(e.element.sessionId!, false);
      }
    });

    // We rely on TreeItem.command for single-click navigation (standard VS Code
    // pattern).  Context menus also work because VS Code passes the TreeItem's
    // command arguments to the action handler automatically.
  }
}

/** Update the status bar text to reflect the primary session's thinking level. */
function updateStatusBar() {
  if (!statusBarItem) { return; }
  const primary = primarySession();
  const level = primary?.piService?.thinkingLevel ?? "off";
  statusBarItem.text = `\u03C0 Pi: ${level}`;
  statusBarItem.tooltip = `Thinking: ${level} \u2014 Click to change`;
}

/**
 * Refresh the past-sessions list from disk.  Called on activation and after
 * delete / resume operations that change the pool of saved sessions.
 */
async function refreshPastSessionsList() {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  await sessionTreeProvider?.refreshPastSessions(cwd);
}

async function initSessionInBackground(context: vscode.ExtensionContext, sw: SessionWindow, opts?: { fresh?: boolean; openPath?: string }) {
  const fresh = opts?.fresh ?? false;
  const openPath = opts?.openPath;
  // Ensure tree provider exists ASAP so the tree view shows something
  ensureTreeProvider(context);



  const status = await PiService.checkInstall();

  if (!status.installed) {
    sw.webviewPanel.postMessage({
      type: "status",
      data: { model: "not installed", thinkingLevel: "off", effort: "auto", ready: false },
    });
    sw.webviewPanel.postMessage({
      type: "error",
      data: {
        message:
          "Pi coding agent SDK is not installed. " +
          'Click "Install Pi" below or run: npm install -g @mariozechner/pi-coding-agent',
      },
    });

    if (!primarySession() || primarySession() === sw) {
      const action = await vscode.window.showErrorMessage(
        "Pi coding agent SDK is not installed.",
        "Install Pi",
        "Learn More",
      );
      if (action === "Install Pi") {
        await installPi();
      } else if (action === "Learn More") {
        vscode.env.openExternal(vscode.Uri.parse("https://pi.dev"));
      }
    }
    sessionTreeProvider?.refresh();
    return;
  }

  const result = await sw.piService.initialize(openPath ? { openPath } : { fresh });

  if (!result.success) {
    sw.webviewPanel.postMessage({
      type: "status",
      data: { model: "init failed", thinkingLevel: "off", effort: "auto", ready: false },
    });
    sw.webviewPanel.postMessage({
      type: "error",
      data: { message: `Pi init failed: ${result.error}` },
    });

    if (!primarySession() || primarySession() === sw) {
      const action = await vscode.window.showErrorMessage(
        `Pi init failed: ${result.error}`,
        "Retry",
      );
      if (action === "Retry") {
        sw.piService.dispose();
        removeSession(sw);
        addSession(context);
      }
    }
    sessionTreeProvider?.refresh();
    return;
  }

  sw.initialized = true;

  // Primary session gets phase 3/4 commands
  if (sw === primarySession()) {
    registerPhase3Commands(context, sw.piService);
    registerPhase4Commands(context, sw.piService);
  }

  // Ensure tree provider is registered (safe to call multiple times)
  ensureTreeProvider(context);

  // Auto-refresh tree when this session changes
  sw.piService.onEvent((event) => {
    // Track streaming state per session for the tree view dot
    if (event.type === "agent-start") {
      sw.isStreaming = true;
    } else if (event.type === "agent-end") {
      sw.isStreaming = false;
    } else if (event.type === "status-update" && event.data) {
      sw.isStreaming = !!event.data.isStreaming;
    }
    // Keep status bar in sync
    if (event.type === "status-update" || event.type === "thinking-level-changed") {
      updateStatusBar();
    }
    sessionTreeProvider?.refresh();
  });

  // Notify webview that pi is ready
  sw.webviewPanel.postMessage({
    type: "status",
    data: {
      model: sw.piService.model?.id ?? "ready",
      thinkingLevel: sw.piService.thinkingLevel,
      effort: sw.piService.effort,
      ready: true,
    },
  });

  sessionTreeProvider?.refresh();
  updateStatusBar();

  // Refresh the past-sessions list once the primary session initialises,
  // so the tree view shows saved sessions from disk.
  if (sw === primarySession()) { refreshPastSessionsList(); }

  console.log(`Pi Code Gui session ${sw.id} ready`);
}

function removeSession(sw: SessionWindow) {
  const idx = sessions.indexOf(sw);
  if (idx !== -1) {
    sessions.splice(idx, 1);
  }
  // Refresh tree so "Open Sessions (N)" header updates count
  sessionTreeProvider?.refresh();
}

// ── Install helper ──────────────────────────────────────

async function installPi(): Promise<void> {
  return new Promise((resolve) => {
    const term = vscode.window.createTerminal("Pi Install");
    term.show();
    term.sendText("npm install -g @mariozechner/pi-coding-agent");
    term.sendText(
      'echo "✅ Pi SDK installed! Reload VS Code to use Pi Code Gui."',
    );
    vscode.window
      .showInformationMessage(
        "Installing Pi SDK... Reload VS Code after the terminal finishes.",
        "Reload Now",
      )
      .then((action) => {
        if (action === "Reload Now") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
    resolve();
  });
}

// ── Multi-Session Tree Provider ───────────────────────────

/**
 * The Sessions view in the VS Code sidebar:
 *
 *   Pi Sessions
 *     ▼ Open Sessions (2)              ← open-sessions-header
 *         Session 1  ●  claude-sonnet  ← session (active/live)
 *           Model: ...
 *           Thinking: ...
 *           ↑ 2k / ↓5k  $0.042
 *           Entries (12)               ← entries-header
 *             📝 hello
 *             🤖 Hi! I can...
 *         Session 2  ●  gpt-4o
 *           ...
 *     ▼ Past Sessions (5)             ← past-sessions-header
 *         chat about auth (3 msgs)     ← pastSessionEntry
 *         refactor done (12 msgs)
 *         ...
 */

class MultiSessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Track which sessions have their entries header expanded so refresh doesn't collapse them. */
  private expandedEntries = new Set<string>();
  /** Past sessions loaded from disk via SessionManager.list(). */
  private _pastSessions: any[] = [];
  /** True while we are refreshing past sessions. */
  private _loadingPast = false;
  /** Current filter string for past sessions (empty = no filter). */
  public pastFilter = "";

  constructor(private sessions: SessionWindow[], private context: vscode.ExtensionContext) {}

  /** Called by TreeView expand/collapse events to track entries-header state. */
  setEntryHeaderExpanded(sessionId: string, expanded: boolean) {
    if (expanded) { this.expandedEntries.add(sessionId); }
    else { this.expandedEntries.delete(sessionId); }
  }

  get pastSessions(): any[] { return this._pastSessions; }

  /** Reload past sessions from disk asynchronously and fire refresh. */
  async refreshPastSessions(cwd: string) {
    this._loadingPast = true;
    try {
      this._pastSessions = await PiService.listSessions(cwd);
    } catch { this._pastSessions = []; }
    this._loadingPast = false;
    this.refresh();
  }

  /** Lightweight refresh (does not re-fetch past sessions). */
  refresh() { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    // ── Root level: two headers (open sessions / past sessions) ──
    if (!element) {
      const children: SessionTreeItem[] = [];

      // Open Sessions
      children.push(new SessionTreeItem(
        `Open Sessions`,
        "open-sessions-header",
        undefined,
        this.sessions.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      ));

      // Past Sessions
      const pastCount = this._pastSessions.length;
      const filteredCount = this.pastFilter
        ? this._pastSessions.filter((s) => this.matchesPastFilter(s)).length
        : pastCount;
      let pastLabel = "Past Sessions";
      if (pastCount > 0) {
        pastLabel = this.pastFilter
          ? `Past Sessions (${filteredCount} of ${pastCount})`
          : `Past Sessions (${pastCount})`;
      }
      const pastItem = new SessionTreeItem(
        pastLabel,
        "past-sessions-header",
        undefined,
        pastCount > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      if (this.pastFilter) {
        pastItem.iconPath = new vscode.ThemeIcon("filter");
      }
      children.push(pastItem);

      return children;
    }

    // ── Open sessions ────────────────────────────────────
    if (element.contextValue === "open-sessions-header") {
      return this.sessions.map((sw) => this.makeSessionItem(sw));
    }

    if (element.contextValue === "session") {
      return this.getSessionChildren(element);
    }

    if (element.contextValue === "entries-header") {
      return this.getEntryChildren(element);
    }

    // ── Past sessions ────────────────────────────────────
    if (element.contextValue === "past-sessions-header") {
      const filtered = this.pastFilter
        ? this._pastSessions.filter((s) => this.matchesPastFilter(s))
        : this._pastSessions;
      return filtered.map((s) => this.makePastSessionItem(s));
    }

    return [];
  }

  // ── Open session items (unchanged logic) ──────────────

  private makeSessionItem(sw: SessionWindow): SessionTreeItem {
    // Derive label from session name (via session_info), tab summary (AI-generated), or fall back to "Session N"
    const sessionName = sw.piService.sessionName
      ?? sw.webviewPanel.summary
      ?? getGenericSessionLabel(sw.id);

    const label = sw.initialized
      ? sessionName
      : `${sessionName}: initializing...`;

    // Cache the label for use in panel title updates
    sw.label = sw.initialized ? sessionName : sw.label;

    const entryCount = getEntryCount(sw);
    const item = new SessionTreeItem(
      label,
      "session",
      {
        command: "pi-code-gui.focusSession",
        title: "Focus Session",
        arguments: [sw.id],
      },
      entryCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.sessionId = sw.id;
    item.description = sw.initialized ? (sw.piService.model?.id ?? "...") : "initializing";
    item.tooltip = new vscode.MarkdownString(
      `**${sw.id}**\n\nModel: ${sw.piService.model?.id ?? "-"}\nThinking: ${sw.piService.thinkingLevel}\nEntries: ${entryCount}\nInitialized: ${sw.initialized}\nStreaming: ${sw.isStreaming}`,
    );

    if (!sw.initialized) {
      item.iconPath = new vscode.ThemeIcon("circle", new vscode.ThemeColor("disabledForeground"));
    } else if (sw.isStreaming) {
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("focusBorder"));
    } else {
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    }

    return item;
  }

  private getSessionChildren(element: SessionTreeItem): SessionTreeItem[] {
    const sw = this.sessions.find((s) => s.id === element.sessionId);
    if (!sw || !sw.initialized) { return []; }
    const ps = sw.piService;
    const children: SessionTreeItem[] = [];

    // Model
    const modelItem = new SessionTreeItem(
      `Model: ${ps.model?.id ?? "..."}`,
      "model",
      { command: "pi-code-gui.pickSessionModel", title: "Change Model", arguments: [sw.id] },
    );
    modelItem.contextValue = "session-model";
    children.push(modelItem);

    // Thinking level
    const thinkingItem = new SessionTreeItem(
      `Thinking: ${ps.thinkingLevel}`,
      "thinking",
      { command: "pi-code-gui.pickSessionThinking", title: "Change Thinking Level", arguments: [sw.id] },
    );
    thinkingItem.contextValue = "session-thinking";
    children.push(thinkingItem);

    // Usage
    const stats = ps.getUsageStats();
    const statsParts: string[] = [];
    if (stats.input > 0) { statsParts.push(`\u2191${formatTokens(stats.input)}`); }
    if (stats.output > 0) { statsParts.push(`\u2193${formatTokens(stats.output)}`); }
    if (stats.cacheRead > 0) { statsParts.push(`R${formatTokens(stats.cacheRead)}`); }
    if (stats.cacheWrite > 0) { statsParts.push(`W${formatTokens(stats.cacheWrite)}`); }
    if (stats.cost > 0) { statsParts.push(`$${stats.cost.toFixed(3)}`); }
    if (stats.contextWindow > 0 && stats.contextPercent !== null) {
      statsParts.push(`${stats.contextPercent.toFixed(1)}%`);
    } else if (stats.contextWindow > 0) { statsParts.push("?%"); }
    if (statsParts.length > 0) {
      const usageItem = new SessionTreeItem(statsParts.join(" "), "usage");
      usageItem.contextValue = "session-usage";
      usageItem.description = "tokens / cost";
      children.push(usageItem);
    }

    // Entries
    const sm = ps.sessionManagerInstance;
    const entries = sm ? sm.getEntries() : [];
    if (entries && entries.length > 0) {
      const alreadyExpanded = this.expandedEntries.has(sw.id);
      const entriesHeader = new SessionTreeItem(
        `Entries (${entries.length})`,
        "entries-header",
        undefined,
        alreadyExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      entriesHeader.sessionId = sw.id;
      entriesHeader.contextValue = "entries-header";
      children.push(entriesHeader);
    }

    return children;
  }

  private getEntryChildren(element: SessionTreeItem): SessionTreeItem[] {
    const sw = this.sessions.find((s) => s.id === element.sessionId);
    if (!sw || !sw.piService.sessionManagerInstance) { return []; }

    const sm = sw.piService.sessionManagerInstance;
    const entries = sm.getEntries();
    if (!entries || entries.length === 0) { return []; }

    return entries.map((entry: any) => {
      const { label, tooltip, type } = formatEntryLabel(entry);
      const item = new SessionTreeItem(label, type, {
        command: "pi-code-gui.revealEntry",
        title: "Show in Chat",
        arguments: [sw.id, entry.id],
      });
      item.tooltip = tooltip;
      item.contextValue = "sessionEntry";
      return item;
    });
  }

  // ── Past session items ────────────────────────────────

  /** Check if a past session matches the current filter. */
  private matchesPastFilter(s: any): boolean {
    if (!this.pastFilter) { return true; }
    const q = this.pastFilter.toLowerCase();
    // Match against name / title
    if (s.name && s.name.toLowerCase().includes(q)) { return true; }
    // Match against first message content
    if (s.firstMessage && s.firstMessage.toLowerCase().includes(q)) { return true; }
    return false;
  }

  private makePastSessionItem(s: any): SessionTreeItem {
    const label = s.name
      ? s.name
      : truncate(s.firstMessage || "(no messages)", 50);

    const dateStr = s.modified
      ? formatRelativeTime(new Date(s.modified))
      : "";
    const msgCount = s.messageCount ?? 0;
    const desc = `${msgCount} msg${msgCount === 1 ? "" : "s"}${dateStr ? " · " + dateStr : ""}`;

    const item = new SessionTreeItem(
      label,
      "pastSessionEntry",
      {
        command: "pi-code-gui.resumePastSession",
        title: "Resume Session",
        arguments: [s.path],
      },
    );
    item.description = desc;
    item.iconPath = new vscode.ThemeIcon("archive");
    item.tooltip = new vscode.MarkdownString(
      `**${s.name || "Session"}**\n\nPath: \`${s.path}\`\nMessages: ${msgCount}\nCreated: ${s.created ? new Date(s.created).toLocaleString() : "-"}\nModified: ${s.modified ? new Date(s.modified).toLocaleString() : "-"}`,
    );
    item.contextValue = "pastSessionEntry";
    return item;
  }
}

/**
 * Format a session entry for display in the tree.
 * Mirrors the pi TUI's entry display logic (roles, compaction, tools, etc.).
 */
function formatEntryLabel(entry: any): { label: string; tooltip: string; type: string } {
  const maxLen = 60;

  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role === "user") {
      const text = truncate(extractText(entry.message?.content), maxLen);
      return { label: `📝 ${text || "(empty)"}`, tooltip: text, type: "user" };
    }
    if (role === "assistant") {
      const text = truncate(extractText(entry.message?.content), maxLen);
      const label = text
        ? `🤖 ${text}`
        : `🤖 (${entry.message?.stopReason ?? "tool use"})`;
      return { label, tooltip: text || entry.message?.errorMessage || "", type: "assistant" };
    }
    if (role === "toolResult") {
      const tcName = entry.message?.toolName ?? "tool";
      const text = truncate(extractText(entry.message?.content), maxLen);
      return { label: `[${tcName}] ${text}`, tooltip: text, type: "toolResult" };
    }
    if (role === "bashExecution") {
      const cmd = truncate(entry.message?.command ?? "", maxLen);
      return { label: `[bash] ${cmd}`, tooltip: cmd, type: "bashExecution" };
    }
    if (role === "custom") {
      const text = truncate(extractText(entry.message?.content), maxLen);
      return { label: `[custom] ${text}`, tooltip: text, type: "custom_message" };
    }
  }

  if (entry.type === "compaction") {
    const kt = Math.round((entry.tokensBefore ?? 0) / 1000);
    return { label: `[compaction: ~${kt}k tokens]`, tooltip: entry.summary ?? "", type: "compaction" };
  }
  if (entry.type === "branch_summary") {
    const text = truncate(entry.summary ?? "", maxLen);
    return { label: `[branch summary] ${text}`, tooltip: entry.summary ?? "", type: "branch_summary" };
  }
  if (entry.type === "model_change") {
    return { label: `[model: ${entry.modelId}]`, tooltip: `Provider: ${entry.provider}`, type: "model_change" };
  }
  if (entry.type === "thinking_level_change") {
    return { label: `[thinking: ${entry.thinkingLevel}]`, tooltip: "", type: "thinking_level_change" };
  }
  if (entry.type === "custom_message") {
    const text = truncate(typeof entry.content === "string" ? entry.content : extractText(entry.content), maxLen);
    return { label: `[${entry.customType}] ${text}`, tooltip: text, type: "custom_message" };
  }
  if (entry.type === "custom") {
    return { label: `[custom: ${entry.customType}]`, tooltip: "", type: "custom" };
  }
  if (entry.type === "label") {
    return { label: `[label: ${entry.label ?? "(cleared)"}]`, tooltip: "", type: "label" };
  }
  if (entry.type === "session_info") {
    return { label: `[title: ${entry.name ?? "(empty)"}]`, tooltip: "", type: "session_info" };
  }

  // Fallback for unknown entry types
  return { label: `[${entry.type}]`, tooltip: JSON.stringify(entry, null, 2), type: entry.type };
}

function getEntryCount(sw: SessionWindow): number {
  return sw.piService.sessionManagerInstance
    ? sw.piService.sessionManagerInstance.getEntries()?.length ?? 0
    : 0;
}

function extractText(content: any): string {
  if (!content) { return ""; }
  if (typeof content === "string") { return content; }
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) { return s; }
  return s.slice(0, max) + "\u2026";
}

function formatTokens(count: number): string {
  if (count < 1000) { return count.toString(); }
  if (count < 10000) { return `${(count / 1000).toFixed(1)}k`; }
  if (count < 1000000) { return `${Math.round(count / 1000)}k`; }
  if (count < 10000000) { return `${(count / 1000000).toFixed(1)}M`; }
  return `${Math.round(count / 1000000)}M`;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) { return "just now"; }
  if (mins < 60) { return `${mins}m ago`; }
  if (hours < 24) { return `${hours}h ago`; }
  if (days < 7) { return `${days}d ago`; }
  return date.toLocaleDateString();
}

// ── UI pickers for per-session model / thinking level ──────

async function pickModelForSession(ps: PiService): Promise<{ provider: string; modelId: string } | null> {
  // Use dynamic model discovery from the registry
  let models: Array<{ label: string; provider: string; modelId: string }> = [];

  try {
    const available = await ps.getAvailableModels();
    if (available.length > 0) {
      models = available.map((m) => ({
        label: m.name || m.id,
        provider: m.provider,
        modelId: m.id,
      }));
    }
  } catch { /* fallback below */ }

  // Fallback: static list of common models
  if (models.length === 0) {
    models = [
      { label: "Claude Sonnet 4.5", provider: "anthropic", modelId: "claude-sonnet-4-5" },
      { label: "Claude Haiku 4.5", provider: "anthropic", modelId: "claude-haiku-4-5" },
      { label: "Claude Opus 4.5", provider: "anthropic", modelId: "claude-opus-4-5" },
      { label: "GPT 4o", provider: "openai", modelId: "gpt-4o" },
      { label: "Gemini 2.5 Pro", provider: "google", modelId: "gemini-2.5-pro" },
      { label: "DeepSeek V3", provider: "deepseek", modelId: "deepseek-chat" },
    ];
  }

  const currentId = ps.model?.id;
  const defModel = ps.getDefaultModel();
  const items = models.map((m) => {
    const isDefault = defModel && m.provider === defModel.provider && m.modelId === defModel.id;
    return {
      label: `${m.label}${m.modelId === currentId ? " $(check)" : ""}${isDefault ? " \u2605" : ""}`,
      description: m.provider,
      provider: m.provider,
      modelId: m.modelId,
      isDefault,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model (\u2605 = default)" });
  if (!picked || typeof picked === "string") { return null; }

  // Offer to save as default
  if (!picked.isDefault) {
    const save = await vscode.window.showQuickPick(
      [{ label: "\u2605 Save as default", description: "Use this model for future sessions" }],
      { placeHolder: `Use as default?` },
    );
    if (save) { ps.saveDefaultModel(); }
  }

  return { provider: picked.provider, modelId: picked.modelId };
}

async function pickThinkingLevel(current: string): Promise<string | null> {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const items = levels.map((l) => ({
    label: `${l === current ? "$(check) " : ""}${l}`,
    description: describeLevel(l),
    level: l,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select thinking level" });
  if (!picked || typeof picked === "string") { return null; }
  return picked.level;
}

function describeLevel(l: string): string {
  const m: Record<string, string> = {
    off: "None", minimal: "Minimal", low: "Brief",
    medium: "Balanced", high: "Extended", xhigh: "Maximum",
  };
  return m[l] ?? "";
}

class SessionTreeItem extends vscode.TreeItem {
  public sessionId?: string;

  constructor(
    label: string,
    type: string,
    command?: vscode.Command,
    collapsible?: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.contextValue = type;
    this.iconPath = new vscode.ThemeIcon(
      type === "session" || type === "sessions-header" ? "multiple-windows"
      : type === "model" ? "symbol-misc"
      : type === "thinking" ? "lightbulb"
      : type === "usage" ? "graph"
      : type === "entries-header" ? "list-tree"
      : type === "user" ? "person"
      : type === "assistant" ? "comment"
      : type === "toolResult" || type === "bashExecution" ? "tools"
      : type === "compaction" ? "archive"
      : type === "branch_summary" ? "git-branch"
      : type === "model_change" ? "gear"
      : type === "thinking_level_change" ? "lightbulb-autofix"
      : type === "custom_message" ? "pencil"
      : type === "custom" ? "symbol-property"
      : type === "label" ? "tag"
      : type === "session_info" ? "info"
      : "play",
    );
  }
}

export function deactivate() {
  for (const sw of sessions) {
    sw.webviewPanel.dispose();
    sw.piService.dispose();
  }
  sessions.length = 0;
  statusBarItem?.dispose();
}
