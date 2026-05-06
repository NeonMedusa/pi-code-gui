import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { createBridgeTools } from "./bridge-tools.js";
import type { PiServiceEvent } from "./types.js";

// ── Types for the dynamically loaded SDK ──────────────────

interface PiSdk {
  createAgentSession: Function;
  SessionManager: any;
  SettingsManager: any;
  AuthStorage: any;
  ModelRegistry: any;
  createCodingTools: Function;
  createReadOnlyTools: Function;
}

interface PiAi {
  getModel: Function;
  getProviders: Function;
}

export interface InstallStatus {
  installed: boolean;
  hasApiKey: boolean;
  path?: string;
  error?: string;
}

type EventListener = (event: PiServiceEvent) => void;

// ── SDK Resolution ───────────────────────────────────────

function resolvePiPackagePath(): string {
  const candidates: string[] = [];

  // Project-local from pi packages (workspace install)
  candidates.push(path.resolve(".pi/npm/node_modules/@mariozechner/pi-coding-agent"));

  // Global npm / yarn / pnpm locations
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    candidates.push(
      path.join(home, ".npm-global/lib/node_modules/@mariozechner/pi-coding-agent"),
      path.join(home, ".local/lib/node_modules/@mariozechner/pi-coding-agent"),
    );
  }

  // nvm
  if (process.env.NVM_DIR) {
    try {
      const versionsDir = path.join(process.env.NVM_DIR, "versions", "node");
      if (fs.existsSync(versionsDir)) {
        for (const version of fs.readdirSync(versionsDir)) {
          candidates.push(
            path.join(versionsDir, version, "lib", "node_modules", "@mariozechner", "pi-coding-agent"),
          );
        }
      }
    } catch {}
  }

  // Windows %APPDATA%\npm
  const appData = process.env.APPDATA || "";
  if (appData) {
    candidates.push(path.join(appData, "npm", "node_modules", "@mariozechner", "pi-coding-agent"));
  }

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, "package.json");
      if (fs.existsSync(pkgPath)) {return candidate;}
    } catch {}
  }

  throw new Error(
    "Pi coding agent SDK not found. Please install it:\n" +
      "  npm install -g @mariozechner/pi-coding-agent",
  );
}

// ── PiService ────────────────────────────────────────────

export class PiService {
  private session: any = null;
  private unsubscribe: (() => void) | null = null;
  private listeners: EventListener[] = [];
  private _model: { id?: string; name?: string } | null = null;
  private _thinkingLevel = "off";
  private _effort = "auto";
  private _isStreaming = false;
  private sessionId: string | null = null;

  // SDK root path (for re-importing individual modules)
  private _piRoot: string | null = null;

  // SDK instances (loaded at init time)
  private SDK: PiSdk | null = null;
  private AI: PiAi | null = null;
  private authStorage: any = null;
  private modelRegistry: any = null;
  private settingsManager: any = null;
  private sessionManager: any = null;

  // Model cycling state
  private cycleModels: Array<{ provider: string; id: string }> = [];
  private cycleIndex = 0;

  // Track current assistant message content (for toolCall stubs during message_update)
  private currentAssistantToolCalls: Map<string, { toolName: string; toolCallId: string; args: any }> = new Map();

  // Turn tracking (like AgentSession._turnIndex in the SDK)
  private turnIndex = 0;

  // User message history for the resend/reuse feature (#2)
  private _userMessages: Array<{ id: string; text: string; timestamp?: number }> = [];

  // Settings state (#3)
  private _autoCompactionEnabled = true;
  private _autoRetryEnabled = true;
  private _showImages = true;

  constructor() {}

  // ── Public API ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: PiServiceEvent) {
    for (const l of this.listeners) {
      try { l(event); } catch { /* ignore */ }
    }
  }

  static async checkInstall(): Promise<InstallStatus> {
    try {
      const p = resolvePiPackagePath();
      return { installed: true, hasApiKey: true, path: p };
    } catch (e: any) {
      return { installed: false, hasApiKey: false, error: e.message ?? String(e) };
    }
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    // ── Step 1: Resolve SDK ────────────────────────────
    try {
      this._piRoot = resolvePiPackagePath();
    } catch (e: any) {
      return { success: false, error: `SDK not found: ${e.message ?? e}` };
    }

    // ── Step 2: Load SDK modules ───────────────────────
    try {
      this.SDK = (await import(path.join(this._piRoot, "dist/index.js"))) as PiSdk;
    } catch (e: any) {
      return { success: false, error: `Failed to load pi-coding-agent: ${e.message ?? e}` };
    }
    try {
      this.AI = (await import(
        path.join(this._piRoot, "node_modules/@mariozechner/pi-ai/dist/index.js")
      )) as PiAi;
    } catch (e: any) {
      return { success: false, error: `Failed to load pi-ai: ${e.message ?? e}` };
    }

    // ── Step 3: Auth & model registry ──────────────────
    const SDK = this.SDK;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      this.authStorage = SDK.AuthStorage.create();
      this.modelRegistry = SDK.ModelRegistry.create(this.authStorage);
      this.settingsManager = SDK.SettingsManager.create(cwd);
    } catch (e: any) {
      return { success: false, error: `Auth/registry setup failed: ${e.message ?? e}` };
    }

    // ── Step 4: Pick a model ───────────────────────────
    const AI = this.AI;
    let model: any = null;
    try {
      const available = await this.modelRegistry.getAvailable();
      if (available.length > 0) {
        model = available[0];
        this.cycleModels = available.map((m: any) => ({ provider: m.provider, id: m.id }));
      } else {
        for (const candidate of [
          ["anthropic", "claude-sonnet-4-5"],
          ["anthropic", "claude-haiku-4-5"],
          ["openai", "gpt-4o"],
        ]) {
          const m = AI.getModel(candidate[0], candidate[1]);
          if (m) { model = m; break; }
        }
        this.cycleModels = model ? [{ provider: model.provider, id: model.id }] : [];
      }
    } catch (e: any) {
      return { success: false, error: `Model lookup failed: ${e.message ?? e}` };
    }

    if (!model) {
      return {
        success: false,
        error: "No model available. Set an API key (e.g. ANTHROPIC_API_KEY) and restart.",
      };
    }

    // ── Step 5: Session tools ──────────────────────────
    let tools: any[];
    try {
      tools = [
        ...SDK.createCodingTools(cwd),
        ...createBridgeTools(),
      ];
    } catch (e: any) {
      return { success: false, error: `Tool setup failed: ${e.message ?? e}` };
    }

    // ── Step 6: Session manager ────────────────────────
    try {
      this.sessionManager = SDK.SessionManager.create(cwd);
    } catch (e: any) {
      return { success: false, error: `Session manager failed: ${e.message ?? e}` };
    }

    // ── Step 7: Create agent session ───────────────────
    let result: any;
    try {
      result = await SDK.createAgentSession({
        model,
        thinkingLevel: "off",
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        settingsManager: this.settingsManager,
        sessionManager: this.sessionManager,
        customTools: tools,
        scopedModels: this.cycleModels.map((m: any) => ({
          model: AI.getModel(m.provider, m.id),
          thinkingLevel: "off",
        })),
        cwd,
      });
    } catch (e: any) {
      return { success: false, error: `createAgentSession failed: ${e.message ?? e}` };
    }

    this.session = result.session;
    this._model = { id: model.id, name: model.name };
    this._thinkingLevel = "off";
    this.sessionId = this.session.sessionId;

    // ── Step 8: Subscribe to events ────────────────────
    this.unsubscribe = this.session.subscribe((event: any) => {
      this.handleAgentEvent(event);
    });

    // ── Step 9: Send initial message history (like TUI renderInitialMessages) ──
    this.sendInitialMessages();

    this.reportStatus();
    this.emitScopedModels();
    this.emitSettings();
    return { success: true };
  }

  /** Send existing session messages to the webview on initial load */
  private sendInitialMessages() {
    // Build session context from the session manager
    const entries = this.sessionManager.getEntries();
    if (!entries || entries.length === 0) { return; }

    // Emit existing messages to populate the webview chat
    for (const entry of entries) {
      if (entry.type === "message" && entry.message) {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = this.extractTextFromContent(msg.content);
          if (text) {
            this._userMessages.push({ id: msg.id ?? `user-${Date.now()}`, text, timestamp: msg.timestamp });
            if (this._userMessages.length > 50) { this._userMessages.shift(); }
            this.emit({ type: "chat-message", data: { role: "user", content: text, entryId: entry.id } });
          }
        } else if (msg.role === "assistant") {
          const text = this.extractTextFromContent(msg.content);
          if (text) {
            this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
            this.emit({ type: "stream-delta", data: { delta: text } });
            this.emit({
              type: "assistant-end",
              data: {
                stopReason: msg.stopReason,
                errorMessage: msg.errorMessage,
                toolCalls: this.extractToolCallsFromContent(msg.content).map((tc) => tc.id),
              },
            });

            const toolCalls = this.extractToolCallsFromContent(msg.content);
            for (const tc of toolCalls) {
              const toolResultEntry = entries.find(
                (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === tc.id,
              );
              if (tc.name === "bash" || tc.name === "exec") {
                this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
                const outputText = toolResultEntry?.message
                  ? this.extractTextFromContent(toolResultEntry.message.content)
                  : "";
                this.emit({
                  type: "bash-end",
                  data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id },
                });
              } else {
                this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true, entryId: toolResultEntry?.id } });
                if (toolResultEntry?.message) {
                  this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
                } else {
                  this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(completed)" }] }, isError: false, entryId: toolResultEntry?.id } });
                }
              }
            }
          }
        } else if (msg.role === "custom") {
          this.emit({ type: "custom-message", data: { customType: msg.customType, content: msg.content, timestamp: msg.timestamp, entryId: entry.id } });
        } else if (msg.role === "bashExecution") {
          const bashEntryId = entry.id ?? `bash-${Date.now()}`;
          this.emit({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
          this.emit({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
        }
      } else if (entry.type === "compaction") {
        this.emit({
          type: "compaction-summary-message",
          data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: entry.timestamp ?? Date.now(), entryId: entry.id },
        });
      }
    }
  }

  // ── Agent event → PiServiceEvent translation ────────────

  /** Extract plain text from a message content (string or array) */
  private extractTextFromContent(content: any): string {
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

  /** Extract tool call content blocks from an assistant message */
  private extractToolCallsFromContent(content: any[]): Array<{ name: string; id: string; arguments: any }> {
    if (!content) { return []; }
    return content
      .filter((c: any) => c.type === "toolCall")
      .map((c: any) => ({ name: c.name, id: c.id, arguments: c.arguments }));
  }

  private handleAgentEvent(event: any) {
    switch (event.type) {
      // ── Agent lifecycle ────────────────────────────────
      case "agent_start":
        this._isStreaming = true;
        this.currentAssistantToolCalls.clear();
        this.turnIndex = 0;
        this.emit({ type: "agent-start" });
        break;

      case "agent_end":
        this._isStreaming = false;
        this.currentAssistantToolCalls.clear();
        this.turnIndex = 0;
        this.emit({
          type: "agent-end",
          data: { messages: event.messages },
        });
        this.reportStatus();
        break;

      // ── Turn lifecycle ─────────────────────────────────
      case "turn_start":
        this.emit({
          type: "turn-start",
          data: { turnIndex: this.turnIndex },
        });
        break;

      case "turn_end":
        this.emit({
          type: "turn-end",
          data: {
            turnIndex: this.turnIndex,
            message: event.message,
            toolResults: event.toolResults,
          },
        });
        this.turnIndex++;
        break;

      // ── Message lifecycle ──────────────────────────────
      case "message_start":
        if (event.message?.role === "user") {
          const text = this.extractTextFromContent(event.message.content);
          if (text) {
            // Track user message for resend/reuse (#2)
            this._userMessages.push({
              id: event.message.id ?? `user-${Date.now()}`,
              text,
              timestamp: event.message.timestamp ?? Date.now(),
            });
            // Keep only last 50 messages
            if (this._userMessages.length > 50) { this._userMessages.shift(); }
            // #9: Include entryId for scroll-to
            const entry = this.sessionManager?.getEntries?.()?.find((e: any) => e.message?.id === event.message.id);
            this.emit({ type: "chat-message", data: { role: "user", content: text, entryId: entry?.id ?? event.message.id } });
          }
        } else if (event.message?.role === "assistant") {
          this.currentAssistantToolCalls.clear();
          // Emit assistant-start to create the container eagerly (like TUI)
          // #9: Include entryId for scroll-to
          const entry = this.sessionManager?.getEntries?.()?.find((e: any) => e.message?.id === event.message.id);
          this.emit({ type: "assistant-start", data: { messageId: event.message.id, entryId: entry?.id ?? event.message.id } });
        }
        break;

      case "message_update": {
        const d = event.assistantMessageEvent;
        switch (d?.type) {
          case "text_delta":
            this.emit({ type: "stream-delta", data: { delta: d.delta } });
            break;
          case "thinking_delta":
            this.emit({ type: "thinking-delta", data: { delta: d.delta } });
            break;
          case "thinking_end":
            this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
            break;
          case "error":
            this.emit({
              type: "error",
              data: { message: d.error ?? "Unknown error" },
            });
            break;
        }

        // Emit tool call stubs from message_update content (like TUI creates ToolExecutionComponent eagerly)
        if (event.message?.role === "assistant" && event.message?.content) {
          const toolCalls = this.extractToolCallsFromContent(event.message.content);
          for (const tc of toolCalls) {
            if (!this.currentAssistantToolCalls.has(tc.id)) {
              this.currentAssistantToolCalls.set(tc.id, {
                toolName: tc.name,
                toolCallId: tc.id,
                args: tc.arguments,
              });
              this.emit({
                type: "tool-start",
                data: {
                  toolCallId: tc.id,
                  toolName: tc.name,
                  args: tc.arguments,
                  fromMessage: true, // flag: created eagerly from message content
                },
              });
            } else {
              // Update args for existing stub (arguments may stream in)
              const existing = this.currentAssistantToolCalls.get(tc.id);
              if (existing) {
                existing.args = tc.arguments;
                this.emit({
                  type: "tool-update",
                  data: {
                    toolCallId: tc.id,
                    toolName: tc.name,
                    partialResult: { content: [{ type: "text", text: JSON.stringify(tc.arguments, null, 2) }] },
                  },
                });
              }
            }
          }
        }
        break;
      }

      case "message_end":
        if (event.message?.role === "user") {
          break;
        }
        if (event.message?.role === "assistant") {
          const toolCalls = this.extractToolCallsFromContent(event.message.content);
          this.emit({
            type: "assistant-end",
            data: {
              stopReason: event.message.stopReason,
              errorMessage: event.message.errorMessage,
              toolCalls: toolCalls.map((tc) => tc.id),
            },
          });
          // Update status with new usage data after each assistant message
          this.reportStatus();
        } else if (event.message?.role === "custom") {
          // Forward custom messages with full metadata (#7)
          const custEntry = this.sessionManager?.getEntries?.()?.findLast?.(
            (e: any) => e.type === "message" && e.message?.role === "custom",
          );
          this.emit({
            type: "custom-message",
            data: {
              customType: event.message.customType,
              content: event.message.content,
              timestamp: event.message.timestamp,
              entryId: custEntry?.id ?? event.message.id,
            },
          });
        }
        break;

      // ── Tool lifecycle ─────────────────────────────────
      case "tool_execution_start": {
        // Look up the entry for this tool call to get its entry ID
        const tcEntry = this.sessionManager?.getEntries?.()?.find(
          (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === event.toolCallId,
        );
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        // Detect bash execution tools (bash, exec) for distinct rendering (#10)
        if (event.toolName === "bash" || event.toolName === "exec") {
          this.emit({
            type: "bash-start",
            data: {
              toolCallId: event.toolCallId,
              command: event.args?.command ?? "",
              entryId: tcEntryId,
            },
          });
        } else {
          this.emit({
            type: "tool-start",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              fromMessage: false,
              entryId: tcEntryId,
            },
          });
        }
        break;
      }

      case "tool_execution_update":
        if (event.toolName === "bash" || event.toolName === "exec") {
          const text = event.partialResult?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          this.emit({
            type: "bash-output",
            data: { toolCallId: event.toolCallId, output: text ?? "" },
          });
        } else {
          this.emit({
            type: "tool-update",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              partialResult: event.partialResult,
            },
          });
        }
        break;

      case "tool_execution_end": {
        // Look up the entry for this tool call
        const tcEntry = this.sessionManager?.getEntries?.()?.find(
          (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === event.toolCallId,
        );
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        if (event.toolName === "bash" || event.toolName === "exec") {
          const text = event.result?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          this.emit({
            type: "bash-end",
            data: {
              toolCallId: event.toolCallId,
              command: event.args?.command ?? "",
              exitCode: event.isError ? 1 : 0,
              cancelled: false,
              output: text ?? "",
              isError: event.isError,
              entryId: tcEntryId,
            },
          });
        } else {
          this.emit({
            type: "tool-end",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              entryId: tcEntryId,
            },
          });
        }
        break;
      }

      // ── Session events ─────────────────────────────────
      case "session_info_changed":
        this.reportStatus();
        break;

      case "thinking_level_changed":
        this._thinkingLevel = event.level;
        this.emit({ type: "thinking-level-changed", data: { level: event.level } });
        this.reportStatus();
        break;

      case "queue_update":
        this.emit({
          type: "queue-update",
          data: {
            steering: Array.from(event.steering ?? []),
            followUp: Array.from(event.followUp ?? []),
          },
        });
        break;

      case "compaction_start":
        this.emit({
          type: "compaction-start",
          data: { reason: event.reason },
        });
        break;

      case "compaction_end":
        this.emit({
          type: "compaction-end",
          data: {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            result: event.result,
            errorMessage: event.errorMessage,
          },
        });
        // Emit compaction summary message for in-chat display (#1)
        if (event.result) {
          // Try to find the compaction entry that was just created
          const compactEntries = this.sessionManager?.getEntries?.();
          const compactEntry = compactEntries?.findLast?.(
            (e: any) => e.type === "compaction",
          );
          this.emit({
            type: "compaction-summary-message",
            data: {
              summary: event.result.summary,
              tokensBefore: event.result.tokensBefore,
              timestamp: Date.now(),
              entryId: compactEntry?.id,
            },
          });
        }
        break;

      case "auto_retry_start":
        this.emit({
          type: "auto-retry-start",
          data: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorMessage: event.errorMessage,
          },
        });
        break;

      case "auto_retry_end":
        this.emit({
          type: "auto-retry-end",
          data: {
            success: event.success,
            attempt: event.attempt,
            finalError: event.finalError,
          },
        });
        break;
    }
  }

  private reportStatus() {
    const stats = this.getUsageStats();
    this.emit({
      type: "status-update",
      data: {
        model: this._model?.id ?? this._model?.name ?? "pi",
        thinkingLevel: this._thinkingLevel,
        effort: this._effort,
        isStreaming: this._isStreaming,
        sessionId: this.sessionId ?? undefined,
        usage: stats,
      },
    });
  }

  // ── User actions ───────────────────────────────────────

  async sendPrompt(text: string, images?: any[]) {
    if (!this.session) {throw new Error("Pi session not initialized");}
    if (this._isStreaming) {
      if (images && images.length > 0) {
        throw new Error("Cannot attach images while agent is streaming");
      }
      await this.session.steer(text);
    } else {
      const opts: any = {};
      if (images && images.length > 0) { opts.images = images; }
      await this.session.prompt(text, opts);
    }
  }

  async abort() {
    if (!this.session) {return;}
    try {
      this.session.agent.abort();
    } catch { /* ignore */ }
  }

  async newSession() {
    if (!this.session) {return;}
    await this.session.agent.waitForIdle();
    // Create a fresh in-memory session
    this.dispose();
    await this.initialize();
  }

  /**
   * After a branch/fork operation, re-emit the branched entries to the webview
   * so the chat panel shows the correct history from the fork point.
   */
  replayBranchEntries(path: any[]) {
    // Clear tracked user messages (they'll be re-added during replay)
    this._userMessages = [];

    for (const entry of path) {
      if (entry.type === "message" && entry.message) {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = this.extractTextFromContent(msg.content);
          if (text) {
            this._userMessages.push({ id: msg.id ?? `user-${Date.now()}`, text, timestamp: msg.timestamp });
            if (this._userMessages.length > 50) { this._userMessages.shift(); }
            this.emit({ type: "chat-message", data: { role: "user", content: text, entryId: entry.id } });
          }
        } else if (msg.role === "assistant") {
          const text = this.extractTextFromContent(msg.content);
          if (text) {
            this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
            this.emit({ type: "stream-delta", data: { delta: text } });
            this.emit({
              type: "assistant-end",
              data: {
                stopReason: msg.stopReason,
                errorMessage: msg.errorMessage,
                toolCalls: this.extractToolCallsFromContent(msg.content).map((tc: any) => tc.id),
              },
            });

            // Replay tool results
            const toolCalls = this.extractToolCallsFromContent(msg.content);
            for (const tc of toolCalls) {
              const toolResultEntry = path.find(
                (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === tc.id,
              );
              if (tc.name === "bash" || tc.name === "exec") {
                this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
                const outputText = toolResultEntry?.message
                  ? this.extractTextFromContent(toolResultEntry.message.content)
                  : "";
                this.emit({
                  type: "bash-end",
                  data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id },
                });
              } else {
                this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true, entryId: toolResultEntry?.id } });
                if (toolResultEntry?.message) {
                  this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
                } else {
                  this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(forked)" }] }, isError: false, entryId: toolResultEntry?.id } });
                }
              }
            }
          }
        } else if (msg.role === "custom") {
          this.emit({ type: "custom-message", data: { customType: msg.customType, content: msg.content, timestamp: msg.timestamp, entryId: entry.id } });
        } else if (msg.role === "bashExecution") {
          const bashEntryId = entry.id ?? `bash-${Date.now()}`;
          this.emit({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
          this.emit({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
        }
      } else if (entry.type === "compaction") {
        this.emit({
          type: "compaction-summary-message",
          data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: entry.timestamp ?? Date.now(), entryId: entry.id },
        });
      }
    }

    this.reportStatus();
  }

  async setModel(provider: string, modelId: string) {
    if (!this.session || !this.AI) {return;}
    const model = this.AI.getModel(provider, modelId);
    if (model) {
      await this.session.setModel(model);
      this._model = { id: modelId };
      this.cycleIndex = this.cycleModels.findIndex(
        (m) => m.provider === provider && m.id === modelId,
      );
      if (this.cycleIndex === -1) {this.cycleIndex = 0;}
      this.reportStatus();
    }
  }

  async cycleModel() {
    if (!this.session || !this.AI || this.cycleModels.length === 0) {return;}
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
    const next = this.cycleModels[this.cycleIndex];
    const model = this.AI.getModel(next.provider, next.id);
    if (model) {
      await this.session.setModel(model);
      this._model = { id: next.id };
      this.reportStatus();
    }
  }

  async setThinkingLevel(level: string) {
    if (!this.session) {return;}
    this.session.setThinkingLevel(level);
    this._thinkingLevel = level;
    this.reportStatus();
  }

  // ── Settings & scoped models (#3, #4) ──────────────

  get autoCompactionEnabled(): boolean { return this._autoCompactionEnabled; }
  get autoRetryEnabled(): boolean { return this._autoRetryEnabled; }
  get showImages(): boolean { return this._showImages; }
  get userMessages(): Array<{ id: string; text: string; timestamp?: number }> { return this._userMessages; }

  /** Get scoped models from the session (#4) */
  getScopedModels(): Array<{ provider: string; id: string; thinkingLevel: string }> {
    if (!this.session || !this.session.scopedModels) { return []; }
    return this.session.scopedModels.map((s: any) => ({
      provider: s.model.provider,
      id: s.model.id,
      thinkingLevel: s.thinkingLevel ?? "off",
    }));
  }

  emitScopedModels() {
    this.emit({ type: "scoped-models-update", data: { models: this.getScopedModels() } });
  }

  emitSettings() {
    this.emit({
      type: "settings-update",
      data: {
        autoCompaction: this._autoCompactionEnabled,
        autoRetry: this._autoRetryEnabled,
        showImages: this._showImages,
      },
    });
  }

  async toggleAutoCompaction(): Promise<boolean> {
    if (!this.session) { return this._autoCompactionEnabled; }
    this._autoCompactionEnabled = !this._autoCompactionEnabled;
    if (typeof this.session.setAutoCompactionEnabled === "function") {
      await this.session.setAutoCompactionEnabled(this._autoCompactionEnabled);
    }
    this.emitSettings();
    return this._autoCompactionEnabled;
  }

  async toggleAutoRetry(): Promise<boolean> {
    if (!this.session) { return this._autoRetryEnabled; }
    this._autoRetryEnabled = !this._autoRetryEnabled;
    this.emitSettings();
    return this._autoRetryEnabled;
  }

  async toggleShowImages(): Promise<boolean> {
    this._showImages = !this._showImages;
    this.emitSettings();
    return this._showImages;
  }

  async setEffort(effort: string) {
    this._effort = effort;
    // If the session supports effort, set it
    if (this.session && typeof this.session.setEffort === "function") {
      await this.session.setEffort(effort);
    }
    this.reportStatus();
  }

  // ── Usage / token stats (mirrors TUI footer) ─────────

  getUsageStats(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextPercent: number | null;
    contextWindow: number;
  } {
    if (!this.sessionManager) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
    }

    const entries = this.sessionManager.getEntries();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const entry of entries) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const usage = entry.message.usage;
        if (usage) {
          totalInput += usage.input ?? 0;
          totalOutput += usage.output ?? 0;
          totalCacheRead += usage.cacheRead ?? 0;
          totalCacheWrite += usage.cacheWrite ?? 0;
          totalCost += usage.cost?.total ?? 0;
        }
      }
    }

    // Context usage (percentage of window used)
    let contextPercent: number | null = null;
    let contextWindow = 0;
    try {
      const contextUsage = this.session?.getContextUsage?.();
      if (contextUsage) {
        contextPercent = contextUsage.percent;
        contextWindow = contextUsage.contextWindow;
      }
    } catch { /* ignore */ }

    return {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      cost: totalCost,
      contextPercent,
      contextWindow,
    };
  }

  // ── Getters ────────────────────────────────────────────

  get isStreaming() {
    return this._isStreaming;
  }

  get model() {
    return this._model;
  }

  get thinkingLevel() {
    return this._thinkingLevel;
  }

  get effort() {
    return this._effort;
  }

  get sdkRoot(): string | null {
    return this._piRoot;
  }

  get sessionManagerInstance(): any {
    return this.sessionManager;
  }

  get sessionIdValue(): string | null {
    return this.sessionId;
  }

  /** Raw agent session instance (for advanced operations like forking) */
  get rawSession(): any {
    return this.session;
  }

  // ── Cleanup ────────────────────────────────────────────

  dispose() {
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = null;
    this.unsubscribe = null;
    this.SDK = null;
    this.AI = null;
  }
}
