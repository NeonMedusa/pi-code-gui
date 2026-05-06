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
  const sw: SessionWindow = { id, piService, webviewPanel, initialized: false, isStreaming: false };
  sessions.push(sw);
  return sw;
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
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.forkSession", async () => {
      const selection = sessionTreeView?.selection;
      if (!selection || selection.length === 0) { return; }
      const item = selection[0] as SessionTreeItem;
      if (item.contextValue !== "sessionEntry") { return; }

      // Extract entry ID from the item's command arguments
      const cmdArgs = item.command?.arguments;
      if (!cmdArgs || cmdArgs.length < 2) {
        vscode.window.showErrorMessage("Cannot fork: missing entry information.");
        return;
      }

      const sessionId = cmdArgs[0] as string;
      const entryId = cmdArgs[1] as string;
      const sw = sessions.find((s) => s.id === sessionId);
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
        sm.branch(entryId);

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
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // ── Step 2: Status bar ─────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "pi-code-gui.addSession";
  statusBarItem.text = "\u03C0 Pi";
  statusBarItem.tooltip = "Add Pi Session";
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
  initSessionInBackground(context, sw);
}


// ── Initialize a single session ───────────────────────

function ensureTreeProvider(context: vscode.ExtensionContext) {
  if (!sessionTreeProvider) {
    sessionTreeProvider = new MultiSessionTreeProvider(sessions);
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

    // Handle click on session entries via selection change (more reliable than TreeItem.command)
    sessionTreeView.onDidChangeSelection((e) => {
      const element = e.selection?.[0];
      if (element && element.contextValue === "sessionEntry" && element.command) {
        vscode.commands.executeCommand(element.command.command, ...(element.command.arguments ?? []));
      }
    });
  }
}

async function initSessionInBackground(context: vscode.ExtensionContext, sw: SessionWindow) {
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

  const result = await sw.piService.initialize();

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

  console.log(`Pi Code Gui session ${sw.id} ready`);
}

function removeSession(sw: SessionWindow) {
  const idx = sessions.indexOf(sw);
  if (idx !== -1) {
    sessions.splice(idx, 1);
  }
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
 * The Sessions view in the VS Code sidebar shows sessions in a tree:
 *
 * 1. TOP LEVEL: "Sessions (N)" header.
 * 2. Per-session: Model + Thinking sub-items and "Entries" expandable.
 * 3. Entries: recent chat messages.
 *
 * Because VS Code tree views are flat at the top, we use a virtual nesting approach:
 * - "sessions-header" children are individual session nodes.
 * - Each session node has model, thinking, and entries-header children.
 * - entries-header children are the recent chat messages.
 */

class MultiSessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Track which sessions have their entries header expanded so refresh doesn't collapse them. */
  private expandedEntries = new Set<string>();

  constructor(private sessions: SessionWindow[]) {}

  /** Called by TreeView expand/collapse events to track entries-header state. */
  setEntryHeaderExpanded(sessionId: string, expanded: boolean) {
    if (expanded) {
      this.expandedEntries.add(sessionId);
    } else {
      this.expandedEntries.delete(sessionId);
    }
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    // ── Root level: Sessions list only ────────────────────────
    if (!element) {
      if (this.sessions.length === 0) { return []; }

      return [
        new SessionTreeItem(
          `Sessions (${this.sessions.length})`,
          "sessions-header",
          undefined,
          this.sessions.length >= 1
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
        ),
      ];
    }

    // ── Sessions group children: individual session items ─────
    if (element.contextValue === "sessions-header") {
      return this.sessions.map((sw) => this.makeSessionItem(sw));
    }

    // ── Session children: model, thinking, entries ────────────
    if (element.contextValue === "session") {
      return this.getSessionChildren(element);
    }

    // ── Entries children: recent chat messages ────────────────
    if (element.contextValue === "entries-header") {
      return this.getEntryChildren(element);
    }

    return [];
  }

  private makeSessionItem(sw: SessionWindow): SessionTreeItem {
    const label = sw.initialized
      ? `Session ${sw.id.replace("session-", "")}`
      : `Session ${sw.id.replace("session-", "")}: initializing...`;

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
    item.contextValue = "session";
    item.description = sw.initialized ? (sw.piService.model?.id ?? "...") : "initializing";
    item.tooltip = new vscode.MarkdownString(
      `**${sw.id}**\n\nModel: ${sw.piService.model?.id ?? "-"}\nThinking: ${sw.piService.thinkingLevel}\nEntries: ${entryCount}\nInitialized: ${sw.initialized}\nStreaming: ${sw.isStreaming}`,
    );

    // ── Status dot ────────────────────────────────────────
    // Show a coloured dot next to the session name that mirrors the status bar dot.
    //   - Not initialized:   grey dot
    //   - Initialized + idle: green dot
    //   - Streaming:          blue dot with pulsing animation (iconPath is set per-refresh,
    //                          so we use a ThemeIcon trick via the label)
    if (!sw.initialized) {
      item.iconPath = new vscode.ThemeIcon("circle", new vscode.ThemeColor("disabledForeground"));
    } else if (sw.isStreaming) {
      // Blue/pulsing dot via a themable colour close to focusBorder
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("focusBorder"));
    } else {
      // Green dot for idle
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    }

    return item;
  }

  private getSessionChildren(element: SessionTreeItem): SessionTreeItem[] {
    const sw = this.sessions.find((s) => s.id === element.sessionId);
    if (!sw || !sw.initialized) { return []; }
    const ps = sw.piService;

    const children: SessionTreeItem[] = [];

    // Model info (clickable per-session picker)
    const modelItem = new SessionTreeItem(
      `Model: ${ps.model?.id ?? "..."}`,
      "model",
      {
        command: "pi-code-gui.pickSessionModel",
        title: "Change Model",
        arguments: [sw.id],
      },
    );
    modelItem.contextValue = "session-model";
    children.push(modelItem);

    // Thinking level (clickable per-session picker)
    const thinkingItem = new SessionTreeItem(
      `Thinking: ${ps.thinkingLevel}`,
      "thinking",
      {
        command: "pi-code-gui.pickSessionThinking",
        title: "Change Thinking Level",
        arguments: [sw.id],
      },
    );
    thinkingItem.contextValue = "session-thinking";
    children.push(thinkingItem);

    // Usage stats (tokens + cost)
    const stats = ps.getUsageStats();
    const statsParts: string[] = [];
    if (stats.input > 0) { statsParts.push(`\u2191${formatTokens(stats.input)}`); }
    if (stats.output > 0) { statsParts.push(`\u2193${formatTokens(stats.output)}`); }
    if (stats.cacheRead > 0) { statsParts.push(`R${formatTokens(stats.cacheRead)}`); }
    if (stats.cacheWrite > 0) { statsParts.push(`W${formatTokens(stats.cacheWrite)}`); }
    if (stats.cost > 0) { statsParts.push(`$${stats.cost.toFixed(3)}`); }
    if (stats.contextWindow > 0 && stats.contextPercent !== null) {
      statsParts.push(`${stats.contextPercent.toFixed(1)}%`);
    } else if (stats.contextWindow > 0) {
      statsParts.push("?%");
    }
    if (statsParts.length > 0) {
      const usageItem = new SessionTreeItem(
        statsParts.join(" "),
        "usage",
      );
      usageItem.contextValue = "session-usage";
      usageItem.description = "tokens / cost";
      children.push(usageItem);
    }

    // Entries (expandable) — preserve user toggle state across refreshes
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
      return { label: `🧑 ${text || "(empty)"}`, tooltip: text, type: "user" };
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

// ── UI pickers for per-session model / thinking level ──────

async function pickModelForSession(ps: PiService): Promise<{ provider: string; modelId: string } | null> {
  const models = [
    { label: "Claude Sonnet 4.5", provider: "anthropic", modelId: "claude-sonnet-4-5" },
    { label: "Claude Haiku 4.5", provider: "anthropic", modelId: "claude-haiku-4-5" },
    { label: "Claude Opus 4.5", provider: "anthropic", modelId: "claude-opus-4-5" },
    { label: "GPT 4o", provider: "openai", modelId: "gpt-4o" },
    { label: "Gemini 2.5 Pro", provider: "google", modelId: "gemini-2.5-pro" },
    { label: "DeepSeek V3", provider: "deepseek", modelId: "deepseek-chat" },
  ];
  const currentId = ps.model?.id;
  const items = models.map((m) => ({
    label: `${m.label}${m.modelId === currentId ? " $(check)" : ""}`,
    description: m.provider,
    provider: m.provider,
    modelId: m.modelId,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model" });
  if (!picked || typeof picked === "string") { return null; }
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
