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
  DefaultResourceLoader: any;
  defineTool: Function;
  getAgentDir: Function;
  createSyntheticSourceInfo: Function;
}

interface PiAi {
  getModel: Function;
  getProviders: Function;
  complete: Function;
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
      if (fs.existsSync(pkgPath)) { return candidate; }
    } catch {}
  }

  throw new Error(
    "Pi coding agent SDK not found. Please install it:\n" +
      "  npm install -g @mariozechner/pi-coding-agent",
  );
}

// ── System Prompt ────────────────────────────────────────

/** Build the VS Code-aware system prompt */
function buildSystemPrompt(): string {
  return `You are a coding assistant running inside VS Code through the Pi Code Gui extension.
You have full access to the VS Code editor state through bridge tools.

Key information about your environment:
- You are embedded in VS Code as an extension with a webview chat UI.
- You can see open editors, selections, diagnostics, symbols, and more via vscode_* tools.
- Use vscode_get_editor_state to see what the user is looking at.
- Use vscode_open_file to open files in the editor.
- Use vscode_apply_workspace_edit to edit files safely through VS Code (buffers stay in sync).
- Use vscode_get_diagnostics to see lint/type errors.
- Use vscode_get_hover and vscode_get_definitions for type info.

When the user asks you to fix something:
1. Check diagnostics first with vscode_get_diagnostics.
2. Look at the relevant code with the read tool.
3. Make edits with the edit or write tool (they keep VS Code buffers in sync).

Be concise and helpful. Prefer editing existing files over creating new ones.`;
}

// ── Context Files ────────────────────────────────────────

/** Build virtual context files (project guidelines for VS Code context) */
function buildContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Check if project has a package.json to infer project type
  let pkgJson: any = null;
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    }
  } catch {}

  // Check for common config files
  const hasTypeScript = fs.existsSync(path.join(cwd, "tsconfig.json"));
  const hasVite = fs.existsSync(path.join(cwd, "vite.config.ts")) || fs.existsSync(path.join(cwd, "vite.config.js"));
  const hasNextJS = pkgJson?.dependencies?.next || pkgJson?.devDependencies?.next;
  const hasReact = pkgJson?.dependencies?.react || pkgJson?.devDependencies?.react;
  const hasNodeBackend = pkgJson?.dependencies?.express || pkgJson?.dependencies?.fastify || pkgJson?.dependencies?.hono;

  files.push({
    path: "/virtual/vscode-guidelines.md",
    content: `# VS Code Extension Guidelines

## Running in Pi Code Gui
- You are an AI coding assistant inside VS Code.
- The user interacts with you through a chat webview.
- You have access to the full VS Code API via bridge tools (vscode_*).
- Always check what the user has open with vscode_get_editor_state.

## Interaction Tips
- Before making changes, check diagnostics with vscode_get_diagnostics.
- If the user mentions a file, verify it exists and check its content.
- When editing, use VS Code's workspace edit API to keep buffers in sync.`,
  });

  if (hasTypeScript) {
    files.push({
      path: "/virtual/project-stack-typescript.md",
      content: `# Project Stack

This project uses TypeScript. Follow these conventions:
- Use strict typing, avoid 'any'.
- Import using ES module syntax.
- Use const over let where possible.
- Prefer async/await over raw promises.`,
    });
  }

  if (hasReact || hasNextJS || hasVite) {
    files.push({
      path: "/virtual/project-stack-frontend.md",
      content: `# Frontend Project Guidelines

This is a ${hasNextJS ? "Next.js" : hasVite ? "Vite-based" : "React"} project.
- Use functional components with hooks.
- Keep components focused and single-responsibility.
- Use proper TypeScript types for props.`,
    });
  }

  if (hasNodeBackend) {
    files.push({
      path: "/virtual/project-stack-backend.md",
      content: `# Backend Project Guidelines

This is a Node.js backend project.
- Handle errors gracefully with proper status codes.
- Validate inputs.
- Use async/await for async operations.`,
    });
  }

  return files;
}

// ── Prompt Templates ─────────────────────────────────────

/** Build custom slash commands */
function buildPromptTemplates(
  createSyntheticSourceInfo: Function,
): Array<{ name: string; description: string; filePath: string; sourceInfo: any; content: string }> {
  const syn = (p: string) => createSyntheticSourceInfo(p, { source: "vscode-gui" });

  return [
    {
      name: "fix-diagnostics",
      description: "Fix all diagnostics in open file",
      filePath: "/virtual/prompts/fix-diagnostics.md",
      sourceInfo: syn("/virtual/prompts/fix-diagnostics.md"),
      content: `# Fix Diagnostics

Check the currently open file for diagnostics using vscode_get_diagnostics.
For each diagnostic, analyze the root cause and apply a fix.
Explain what you're fixing and why.`,
    },
    {
      name: "explain-code",
      description: "Explain the code at current cursor position",
      filePath: "/virtual/prompts/explain-code.md",
      sourceInfo: syn("/virtual/prompts/explain-code.md"),
      content: `# Explain Code

Use vscode_get_editor_state to find what file and selection the user has open.
Read the relevant code section and explain what it does, its purpose, and how it works.
If the selection is empty, explain the function/module at the cursor position (use vscode_get_hover for additional context).`,
    },
    {
      name: "refactor",
      description: "Refactor the selected code",
      filePath: "/virtual/prompts/refactor.md",
      sourceInfo: syn("/virtual/prompts/refactor.md"),
      content: `# Refactor

Get the current selection with vscode_get_selection.
Analyze the code and suggest/apply refactoring improvements:
- Extract repeated logic into functions
- Simplify complex expressions
- Improve variable naming
- Add missing type annotations
- Reduce nesting

Apply your changes using edit tools.`,
    },
  ];
}

// ── PiService ────────────────────────────────────────────

export class PiService {
  private session: any = null;
  private unsubscribe: (() => void) | null = null;
  private listeners: EventListener[] = [];
  private _model: { id?: string; name?: string; provider?: string } | null = null;
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
  private resourceLoader: any = null;

  // Model cycling state (populated dynamically from registry)
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

      // Verify critical transitive dependencies are actually present (not just
      // package.json stubs — npm global install hoisting can leave hollow dirs).
      const missing: string[] = [];
      const criticalDeps: Array<[string, string]> = [
        ["openai", "index.js"],
        ["@anthropic-ai/sdk", "index.mjs"],
      ];
      for (const [dep, entry] of criticalDeps) {
        const candidate = path.join(p, "node_modules", dep, entry);
        if (!fs.existsSync(candidate)) {
          // Also check top-level hoist (npm global installs sometimes hoist to
          // the global node_modules directly).
          const globalCandidate = path.join(p, "..", "..", dep, entry);
          if (!fs.existsSync(globalCandidate)) {
            missing.push(dep);
          }
        }
      }

      if (missing.length > 0) {
        return {
          installed: false,
          hasApiKey: false,
          error:
            `Pi SDK found but dependencies are missing: ${missing.join(", ")}. ` +
            `Reinstall with: npm uninstall -g @mariozechner/pi-coding-agent && npm install -g @mariozechner/pi-coding-agent`,
        };
      }

      return { installed: true, hasApiKey: true, path: p };
    } catch (e: any) {
      return { installed: false, hasApiKey: false, error: e.message ?? String(e) };
    }
  }

  /** List past (saved-on-disk) sessions for the given cwd. */
  static async listSessions(cwd: string): Promise<any[]> {
    try {
      const piRoot = resolvePiPackagePath();
      const SDK = await import(path.join(piRoot, "dist/index.js"));
      return SDK.SessionManager.list(cwd);
    } catch { return []; }
  }

  /** Delete a session file from disk. */
  static async deleteSessionFile(filePath: string): Promise<void> {
    if (typeof filePath !== "string") {
      throw new Error("deleteSessionFile: filePath must be a string");
    }
    await fs.promises.unlink(filePath);
  }

  async initialize(opts?: { fresh?: boolean; openPath?: string }): Promise<{ success: boolean; error?: string }> {
    const fresh = opts?.fresh ?? false;
    const openPath = opts?.openPath ?? null;
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
      const msg = e.message ?? String(e);
      // Detect common missing-dependency patterns caused by broken npm global
      // installs and give a specific fix instruction.
      const openaiMatch = msg.match(/openai\/index\.js/);
      const anthroMatch = msg.match(/@anthropic-ai\/sdk/);
      if (openaiMatch || anthroMatch) {
        return {
          success: false,
          error:
            `Missing dependency (${openaiMatch ? "openai" : "@anthropic-ai/sdk"}). ` +
            `This is usually caused by a broken npm global install. ` +
            `Fix: npm uninstall -g @mariozechner/pi-coding-agent && npm install -g @mariozechner/pi-coding-agent`,
        };
      }
      return { success: false, error: `Failed to load pi-ai: ${msg}` };
    }
    // Load typebox for defineTool usage
    let Type: any;
    try {
      const Typebox = await import(path.join(this._piRoot, "node_modules/typebox/build/index.mjs"));
      Type = Typebox.Type ?? Typebox;
    } catch (e: any) {
      return { success: false, error: `Failed to load typebox: ${e.message ?? e}` };
    }

    const SDK = this.SDK;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // ── Step 3: Auth & model registry ──────────────────
    try {
      this.authStorage = SDK.AuthStorage.create();

      // Runtime API key override from VS Code secrets or env
      const config = vscode.workspace.getConfiguration("pi-code-gui");
      const anthropicKey = config.get<string>("anthropicApiKey");
      if (anthropicKey) {
        this.authStorage.setRuntimeApiKey("anthropic", anthropicKey);
      }
      const openaiKey = config.get<string>("openaiApiKey");
      if (openaiKey) {
        this.authStorage.setRuntimeApiKey("openai", openaiKey);
      }

      this.modelRegistry = SDK.ModelRegistry.create(this.authStorage);
      this.settingsManager = SDK.SettingsManager.create(cwd);
    } catch (e: any) {
      return { success: false, error: `Auth/registry setup failed: ${e.message ?? e}` };
    }

    // ── Step 4: Pick a model (dynamic from registry) ──
    const AI = this.AI;
    let model: any = null;
    try {
      // Try registry first (respects API keys)
      const available = await this.modelRegistry.getAvailable();
      if (available.length > 0) {
        model = available[0];
        this.cycleModels = available.map((m: any) => ({ provider: m.provider, id: m.id }));
      } else {
        // Fallback: try built-in models via modelRegistry.find() and getModel()
        this.cycleModels = [];
        for (const candidate of [
          ["anthropic", "claude-sonnet-4-5"],
          ["anthropic", "claude-haiku-4-5"],
          ["openai", "gpt-4o"],
        ]) {
          const found = this.modelRegistry.find(candidate[0], candidate[1]);
          if (found) {
            this.cycleModels.push({ provider: candidate[0], id: candidate[1] });
            if (!model) { model = found; }
          }
        }
        // Try getModel for models not in registry but built-in
        if (!model) {
          for (const candidate of [
            ["anthropic", "claude-sonnet-4-5"],
            ["anthropic", "claude-haiku-4-5"],
            ["openai", "gpt-4o"],
          ]) {
            const m = AI.getModel(candidate[0], candidate[1]);
            if (m) { model = m; break; }
          }
        }
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

    // ── Override with user's default model from VS Code settings ──
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const defProvider = cfg.get<string>("defaultModelProvider");
    const defModelId = cfg.get<string>("defaultModelId");
    if (defProvider && defModelId) {
      const defModel = this.modelRegistry.find(defProvider, defModelId) ?? AI.getModel(defProvider, defModelId);
      if (defModel) { model = defModel; }
    }

    // ── Override context budget from VS Code settings ──
    const contextBudget = cfg.get<number>("contextBudget") ?? 0;
    if (contextBudget > 0) {
      model = { ...model, contextWindow: contextBudget };
    }

    this._model = { id: model.id, name: model.name, provider: model.provider };

    // ── Step 5: ResourceLoader ─────────────────────────
    // Builds custom system prompt, skills, context files, and prompt templates
    try {
      const DefaultResourceLoader = SDK.DefaultResourceLoader;
      const getAgentDir = SDK.getAgentDir;

      const contextFiles = buildContextFiles(cwd);
      const templates = buildPromptTemplates(SDK.createSyntheticSourceInfo);

      this.resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir ? getAgentDir() : undefined,
        // Custom system prompt with VS Code context
        systemPromptOverride: () => buildSystemPrompt(),
        // Prevent DefaultResourceLoader from appending default append files
        appendSystemPromptOverride: () => [],
        // Inject virtual context files with project-specific guidelines
        agentsFilesOverride: (current: any) => ({
          agentsFiles: [...current.agentsFiles, ...contextFiles],
        }),
        // Inject custom slash commands
        promptsOverride: (current: any) => ({
          prompts: [...current.prompts, ...templates],
          diagnostics: current.diagnostics,
        }),
      });
      await this.resourceLoader.reload();

      // Report discovered resources
      const { skills: discoveredSkills } = this.resourceLoader.getSkills();
      const { prompts: discoveredPrompts } = this.resourceLoader.getPrompts();
      const { agentsFiles } = this.resourceLoader.getAgentsFiles();
      console.log(`[pi-gui] Skills: ${discoveredSkills.map((s: any) => s.name).join(", ") || "none"}`);
      console.log(`[pi-gui] Prompt templates: ${discoveredPrompts.map((p: any) => `/${p.name}`).join(", ") || "none"}`);
      console.log(`[pi-gui] Context files: ${agentsFiles.length}`);
    } catch (e: any) {
      console.warn(`[pi-gui] ResourceLoader setup warning: ${e.message}`);
      // Non-fatal: ResourceLoader is optional, session can work without it
    }

    // ── Step 6: Session tools ──────────────────────────
    let tools: any[];
    try {
      tools = [
        ...SDK.createCodingTools(cwd),
        ...createBridgeTools(SDK.defineTool, Type),
      ];
    } catch (e: any) {
      return { success: false, error: `Tool setup failed: ${e.message ?? e}` };
    }

    // ── Step 7: Session manager ─────────────────────
    try {
      if (openPath) {
        // Open a specific saved session file
        this.sessionManager = SDK.SessionManager.open(openPath);
      } else if (fresh) {
        // Explicit new session — always a fresh file
        this.sessionManager = SDK.SessionManager.create(cwd);
      } else {
        // First load: try to continue the most recent session (persists across VS Code restarts)
        // If none exists, create a new one.
        try {
          this.sessionManager = await SDK.SessionManager.continueRecent(cwd);
        } catch {
          this.sessionManager = SDK.SessionManager.create(cwd);
        }
      }
    } catch (e: any) {
      return { success: false, error: `Session manager failed: ${e.message ?? e}` };
    }

    // ── Step 8: Restore model & thinking from session file (if resuming) ──
    let resumeModel: any = model;
    let resumeThinkingLevel = cfg.get<string>("defaultThinkingLevel") ?? "off";
    if (openPath && this.sessionManager) {
      const entries = this.sessionManager.getEntries?.();
      if (Array.isArray(entries)) {
        // Walk entries in reverse to find the last model_change and thinking_level_change
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "model_change" && e.provider && e.modelId && !resumeModel._fromSession) {
            // Try to resolve the model from the registry
            const found = this.modelRegistry.find(e.provider, e.modelId);
            if (found) {
              resumeModel = found;
              (resumeModel as any)._fromSession = true;
            } else {
              // Fallback: try getModel
              const m = AI.getModel(e.provider, e.modelId);
              if (m) { resumeModel = m; (resumeModel as any)._fromSession = true; }
            }
          }
          if (e.type === "thinking_level_change" && e.thinkingLevel && resumeThinkingLevel === "off") {
            resumeThinkingLevel = e.thinkingLevel;
          }
          // Stop early once both are resolved
          if ((resumeModel as any)._fromSession && resumeThinkingLevel !== "off") { break; }
        }
      }
    }

    // ── Step 9: Create agent session ───────────────────
    let result: any;
    try {
      const opts: any = {
        model: resumeModel,
        thinkingLevel: resumeThinkingLevel,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        settingsManager: this.settingsManager,
        sessionManager: this.sessionManager,
        customTools: tools,
        cwd,
      };

      // Scoped models from registry (dynamic)
      if (this.cycleModels.length > 0) {
        opts.scopedModels = this.cycleModels.map((m: any) => ({
          model: AI.getModel(m.provider, m.id),
          thinkingLevel: "off",
        }));
      }

      // ResourceLoader with custom system prompt, context files, templates
      if (this.resourceLoader) {
        opts.resourceLoader = this.resourceLoader;
      }

      result = await SDK.createAgentSession(opts);
    } catch (e: any) {
      return { success: false, error: `createAgentSession failed: ${e.message ?? e}` };
    }

    this.session = result.session;
    this._thinkingLevel = resumeThinkingLevel;
    this.sessionId = this.session.sessionId;

    // Update cached model if resume overrode it
    if (resumeModel !== model) {
      this._model = { id: resumeModel.id, name: resumeModel.name, provider: resumeModel.provider };
    }

    // ── Step 10: Subscribe to events ───────────────────
    this.unsubscribe = this.session.subscribe((event: any) => {
      this.handleAgentEvent(event);
    });

    // ── Step 11: Send initial message history (like TUI renderInitialMessages) ──
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
          const thinking = this.extractThinkingFromContent(msg.content);
          if (text || thinking) {
            this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
            // Emit thinking content first, then text
            if (thinking) {
              this.emit({ type: "thinking-delta", data: { delta: thinking } });
              this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
            }
            if (text) {
              this.emit({ type: "stream-delta", data: { delta: text } });
            }
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

  /** Extract thinking content blocks from an assistant message content array */
  private extractThinkingFromContent(content: any): string {
    if (!content) { return ""; }
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => c.type === "thinking")
        .map((c: any) => c.thinking)
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
        this.emit({ type: "agent-end", data: { messages: event.messages } });
        this.reportStatus();
        break;

      case "turn_start":
        this.emit({ type: "turn-start", data: { turnIndex: this.turnIndex } });
        break;

      case "turn_end":
        this.emit({ type: "turn-end", data: { turnIndex: this.turnIndex, message: event.message, toolResults: event.toolResults } });
        this.turnIndex++;
        break;

      case "message_start":
        if (event.message?.role === "user") {
          const text = this.extractTextFromContent(event.message.content);
          if (text) {
            this._userMessages.push({ id: event.message.id ?? `user-${Date.now()}`, text, timestamp: event.message.timestamp ?? Date.now() });
            if (this._userMessages.length > 50) { this._userMessages.shift(); }
            const entry = this.sessionManager?.getEntries?.()?.find((e: any) => e.message?.id === event.message.id);
            this.emit({ type: "chat-message", data: { role: "user", content: text, entryId: entry?.id ?? event.message.id } });
          }
        } else if (event.message?.role === "assistant") {
          this.currentAssistantToolCalls.clear();
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
            this.emit({ type: "error", data: { message: d.error ?? "Unknown error" } });
            break;
        }

        if (event.message?.role === "assistant" && event.message?.content) {
          const toolCalls = this.extractToolCallsFromContent(event.message.content);
          for (const tc of toolCalls) {
            if (!this.currentAssistantToolCalls.has(tc.id)) {
              this.currentAssistantToolCalls.set(tc.id, { toolName: tc.name, toolCallId: tc.id, args: tc.arguments });
              this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true } });
            } else {
              const existing = this.currentAssistantToolCalls.get(tc.id);
              if (existing) {
                existing.args = tc.arguments;
                this.emit({ type: "tool-update", data: { toolCallId: tc.id, toolName: tc.name, partialResult: { content: [{ type: "text", text: JSON.stringify(tc.arguments, null, 2) }] } } });
              }
            }
          }
        }
        break;
      }

      case "message_end":
        if (event.message?.role === "user") { break; }
        if (event.message?.role === "assistant") {
          const toolCalls = this.extractToolCallsFromContent(event.message.content);
          this.emit({ type: "assistant-end", data: { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage, toolCalls: toolCalls.map((tc) => tc.id) } });
          this.reportStatus();
        } else if (event.message?.role === "custom") {
          const custEntry = this.sessionManager?.getEntries?.()?.findLast?.(
            (e: any) => e.type === "message" && e.message?.role === "custom",
          );
          this.emit({ type: "custom-message", data: { customType: event.message.customType, content: event.message.content, timestamp: event.message.timestamp, entryId: custEntry?.id ?? event.message.id } });
        }
        break;

      case "tool_execution_start": {
        const tcEntry = this.sessionManager?.getEntries?.()?.find(
          (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === event.toolCallId,
        );
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        if (event.toolName === "bash" || event.toolName === "exec") {
          this.emit({ type: "bash-start", data: { toolCallId: event.toolCallId, command: event.args?.command ?? "", entryId: tcEntryId } });
        } else {
          this.emit({ type: "tool-start", data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, fromMessage: false, entryId: tcEntryId } });
        }
        break;
      }

      case "tool_execution_update":
        if (event.toolName === "bash" || event.toolName === "exec") {
          const text = event.partialResult?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          this.emit({ type: "bash-output", data: { toolCallId: event.toolCallId, output: text ?? "" } });
        } else {
          this.emit({ type: "tool-update", data: { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult } });
        }
        break;

      case "tool_execution_end": {
        const tcEntry = this.sessionManager?.getEntries?.()?.find(
          (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === event.toolCallId,
        );
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        if (event.toolName === "bash" || event.toolName === "exec") {
          const text = event.result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          this.emit({ type: "bash-end", data: { toolCallId: event.toolCallId, command: event.args?.command ?? "", exitCode: event.isError ? 1 : 0, cancelled: false, output: text ?? "", isError: event.isError, entryId: tcEntryId } });
        } else {
          this.emit({ type: "tool-end", data: { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, entryId: tcEntryId } });
        }
        break;
      }

      case "session_info_changed":
        this.reportStatus();
        break;

      case "thinking_level_changed":
        this._thinkingLevel = event.level;
        this.emit({ type: "thinking-level-changed", data: { level: event.level } });
        this.reportStatus();
        break;

      case "queue_update":
        this.emit({ type: "queue-update", data: { steering: Array.from(event.steering ?? []), followUp: Array.from(event.followUp ?? []) } });
        break;

      case "compaction_start":
        this.emit({ type: "compaction-start", data: { reason: event.reason } });
        break;

      case "compaction_end":
        this.emit({ type: "compaction-end", data: { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, result: event.result, errorMessage: event.errorMessage } });
        if (event.result) {
          const compactEntries = this.sessionManager?.getEntries?.();
          const compactEntry = compactEntries?.findLast?.((e: any) => e.type === "compaction");
          this.emit({ type: "compaction-summary-message", data: { summary: event.result.summary, tokensBefore: event.result.tokensBefore, timestamp: Date.now(), entryId: compactEntry?.id } });
        }
        break;

      case "auto_retry_start":
        this.emit({ type: "auto-retry-start", data: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage } });
        break;

      case "auto_retry_end":
        this.emit({ type: "auto-retry-end", data: { success: event.success, attempt: event.attempt, finalError: event.finalError } });
        break;
    }
  }

  private reportStatus() {
    const stats = this.getUsageStats();
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const budget = cfg.get<number>("contextBudget") ?? 0;
    this.emit({
      type: "status-update",
      data: {
        model: this._model?.id ?? this._model?.name ?? "pi",
        thinkingLevel: this._thinkingLevel,
        effort: this._effort,
        isStreaming: this._isStreaming,
        sessionId: this.sessionId ?? undefined,
        usage: stats,
        contextBudget: budget,
      },
    });
  }

  // ── User actions ───────────────────────────────────────

  async sendPrompt(text: string, images?: any[]) {
    if (!this.session) { throw new Error("Pi session not initialized"); }
    if (this._isStreaming) {
      if (images && images.length > 0) {
        throw new Error("Cannot attach images while agent is streaming");
      }
      await this.session.steer(text);
    } else {
      const opts: any = {};
      if (images && images.length > 0) {
        // Check if current model supports images; if not, try to auto-switch
        if (!this.activeModelSupportsImages()) {
          const visionModel = this.findVisionModel();
          if (visionModel) {
            // Auto-switch to a vision-capable model
            await this.setModel(visionModel.provider, visionModel.id);
            this.emit({
              type: "custom-message",
              data: {
                customType: "info",
                content: `Auto-switched to ${visionModel.id} (vision-capable) for image support.`,
                timestamp: Date.now(),
              },
            });
          } else {
            throw new Error(
              `Cannot send images: no vision-capable model available. ` +
              "Add an API key for Claude, GPT-4o, or Gemini to use images."
            );
          }
        }
        opts.images = images;
      }
      await this.session.prompt(text, opts);
    }
  }

  /** Check whether the active model's input capabilities include images. */
  private activeModelSupportsImages(): boolean {
    const rawModel = (this.session as any)?.model;
    if (!rawModel) { return true; }
    const input = rawModel.input as string[] | undefined;
    return input?.includes("image") ?? true;
  }

  /** Find a vision-capable model from the available scoped models. */
  private findVisionModel(): { provider: string; id: string } | null {
    if (!this.AI) { return null; }
    for (const cm of this.cycleModels) {
      const m = this.AI.getModel(cm.provider, cm.id);
      if (m?.input?.includes("image")) {
        return { provider: cm.provider, id: cm.id };
      }
    }
    return null;
  }

  async abort() {
    if (!this.session) { return; }
    try { this.session.agent.abort(); } catch { /* ignore */ }
  }

  async newSession() {
    if (!this.session) { return; }
    await this.session.agent.waitForIdle();
    this.dispose();
    await this.initialize({ fresh: true });
  }

  /** Resume a past session from a .jsonl file path. Disposes current and re-initializes. */
  async resumeSession(filePath: string): Promise<{ success: boolean; error?: string }> {
    try { await this.session?.agent.waitForIdle(); } catch { /* ignore */ }
    this.dispose();
    return this.initialize({ openPath: filePath });
  }

  /** After a branch/fork operation, re-emit the branched entries to the webview */
  replayBranchEntries(path: any[]) {
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
          const thinking = this.extractThinkingFromContent(msg.content);
          if (text || thinking) {
            this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
            // Emit thinking content first, then text
            if (thinking) {
              this.emit({ type: "thinking-delta", data: { delta: thinking } });
              this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
            }
            if (text) {
              this.emit({ type: "stream-delta", data: { delta: text } });
            }
            this.emit({ type: "assistant-end", data: { stopReason: msg.stopReason, errorMessage: msg.errorMessage, toolCalls: this.extractToolCallsFromContent(msg.content).map((tc: any) => tc.id) } });

            const toolCalls = this.extractToolCallsFromContent(msg.content);
            for (const tc of toolCalls) {
              const toolResultEntry = path.find(
                (e: any) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === tc.id,
              );
              if (tc.name === "bash" || tc.name === "exec") {
                this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
                const outputText = toolResultEntry?.message ? this.extractTextFromContent(toolResultEntry.message.content) : "";
                this.emit({ type: "bash-end", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id } });
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
        this.emit({ type: "compaction-summary-message", data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: entry.timestamp ?? Date.now(), entryId: entry.id } });
      }
    }

    this.reportStatus();
  }

  async setModel(provider: string, modelId: string) {
    if (!this.session || !this.AI) { return; }
    // Try registry first, then fall back to getModel
    let model: any = null;
    if (this.modelRegistry) {
      model = this.modelRegistry.find(provider, modelId);
    }
    if (!model) {
      model = this.AI.getModel(provider, modelId);
    }
    if (model) {
      await this.session.setModel(model);
      this._model = { id: modelId, provider };
      this.cycleIndex = this.cycleModels.findIndex((m) => m.provider === provider && m.id === modelId);
      if (this.cycleIndex === -1) { this.cycleIndex = 0; }
      this.reportStatus();
    }
  }

  async cycleModel() {
    if (!this.session || !this.AI || this.cycleModels.length === 0) { return; }
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
    const next = this.cycleModels[this.cycleIndex];
    const model = this.AI.getModel(next.provider, next.id);
    if (model) {
      await this.session.setModel(model);
      this._model = { id: next.id, provider: next.provider };
      this.reportStatus();
    }
  }

  async setThinkingLevel(level: string) {
    if (!this.session) { return; }
    this.session.setThinkingLevel(level);
    this._thinkingLevel = level;
    this.reportStatus();
  }

  // ── Default model / thinking persistence ──────────────

  /** Save the current model as the default for future sessions. */
  saveDefaultModel() {
    if (!this._model?.provider || !this._model?.id) { return; }
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    cfg.update("defaultModelProvider", this._model.provider, vscode.ConfigurationTarget.Global);
    cfg.update("defaultModelId", this._model.id, vscode.ConfigurationTarget.Global);
  }

  /** Save the current thinking level as the default for future sessions. */
  saveDefaultThinking() {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    cfg.update("defaultThinkingLevel", this._thinkingLevel, vscode.ConfigurationTarget.Global);
  }

  /** Get the configured default model (if any). */
  getDefaultModel(): { provider: string; id: string } | null {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const provider = cfg.get<string>("defaultModelProvider");
    const id = cfg.get<string>("defaultModelId");
    return (provider && id) ? { provider, id } : null;
  }

  /** Get the configured default thinking level. */
  getDefaultThinking(): string {
    return vscode.workspace.getConfiguration("pi-code-gui").get<string>("defaultThinkingLevel") ?? "off";
  }

  /** Get the current context budget (0 = model default). */
  getContextBudget(): number {
    return vscode.workspace.getConfiguration("pi-code-gui").get<number>("contextBudget") ?? 0;
  }

  /** Save context budget setting (requires restart to take effect). */
  async setContextBudget(budget: number) {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    await cfg.update("contextBudget", budget, vscode.ConfigurationTarget.Global);
    this.reportStatus();
  }

  // ── Settings, models, scoped models ──────────────────

  get autoCompactionEnabled(): boolean { return this._autoCompactionEnabled; }
  get autoRetryEnabled(): boolean { return this._autoRetryEnabled; }
  get showImages(): boolean { return this._showImages; }
  get userMessages(): Array<{ id: string; text: string; timestamp?: number }> { return this._userMessages; }

  /** Get available models from the model registry (for dynamic model pickers) */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string }>> {
    if (!this.modelRegistry) { return []; }
    try {
      const available = await this.modelRegistry.getAvailable();
      return available.map((m: any) => ({ provider: m.provider, id: m.id, name: m.name }));
    } catch {
      return [];
    }
  }

  /** Get scoped models from the session */
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
      data: { autoCompaction: this._autoCompactionEnabled, autoRetry: this._autoRetryEnabled, showImages: this._showImages },
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
    if (this.session && typeof this.session.setEffort === "function") {
      await this.session.setEffort(effort);
    }
    this.reportStatus();
  }

  /** Generate a short 3-word tab title summary for the first user input in a session. */
  async generateTabSummary(userInput: string): Promise<string | null> {
    if (!this.AI || !this._model) { return null; }

    try {
      const model = this.AI.getModel(this._model.provider, this._model.id);
      if (!model) { return null; }

      const apiKey = this.authStorage
        ? await this.authStorage.getApiKey(this._model.provider!)
        : undefined;

      const context = {
        systemPrompt: "Generate a concise 3-word summary of the following user request. Respond with ONLY the three words, lowercase, no punctuation, no quotes, no explanation.",
        messages: [
          { role: "user", content: userInput, timestamp: Date.now() },
        ],
      };

      const result = await this.AI.complete(model, context, {
        maxTokens: 20,
        apiKey,
      });

      const text = this.extractTextFromContent(result.content);
      if (text) {
        // Clean up: take first line, trim, limit to ~40 chars
        return text.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 40);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Set a runtime API key (not persisted to disk) */
  setRuntimeApiKey(provider: string, key: string) {
    if (this.authStorage && typeof this.authStorage.setRuntimeApiKey === "function") {
      this.authStorage.setRuntimeApiKey(provider, key);
    }
  }

  // ── Usage / token stats ──────────────────────────────

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

    let contextPercent: number | null = null;
    let contextWindow = 0;
    try {
      const contextUsage = this.session?.getContextUsage?.();
      if (contextUsage) {
        contextPercent = contextUsage.percent;
        contextWindow = contextUsage.contextWindow;
      }
    } catch { /* ignore */ }

    return { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, cost: totalCost, contextPercent, contextWindow };
  }

  // ── Getters ────────────────────────────────────────────

  get isStreaming() { return this._isStreaming; }
  get model() { return this._model; }
  get thinkingLevel() { return this._thinkingLevel; }
  get effort() { return this._effort; }
  get sdkRoot(): string | null { return this._piRoot; }
  get sessionManagerInstance(): any { return this.sessionManager; }
  get sessionIdValue(): string | null { return this.sessionId; }
  get rawSession(): any { return this.session; }
  /** Expose the model registry for dynamic model pickers in the webview */
  get modelRegistryInstance(): any { return this.modelRegistry; }

  /** Get the session display name from the session manager, if set. */
  get sessionName(): string | undefined {
    return this.sessionManager?.getSessionName?.();
  }

  // ── Login / Logout ─────────────────────────────────────

  /**
   * Show the login flow for a provider.
   * Mirrors the pi CLI's /login command:
   * 1. Select auth type (subscription/OAuth vs API key)
   * 2. Select provider
   * 3. For OAuth: open browser and complete OAuth flow
   * 4. For API key: prompt for key and save it
   */
  async login(): Promise<void> {
    if (!this.authStorage || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // ── Step 1: Auth type selector ─────────────────────
    const authType = await this.pickAuthType();
    if (!authType) { return; } // cancelled

    // ── Step 2: Provider selector ───────────────────────
    const providerChoice = await this.pickLoginProvider(authType);
    if (!providerChoice) { return; } // cancelled

    // ── Step 3: Execute login ───────────────────────────
    if (providerChoice.authType === "oauth") {
      await this.doOAuthLogin(providerChoice.id, providerChoice.name);
    } else if (providerChoice.id === "amazon-bedrock") {
      await this.showInfoMessage(
        "Amazon Bedrock uses AWS credentials. Configure an AWS profile, IAM keys, or role-based credentials.",
      );
    } else {
      await this.doApiKeyLogin(providerChoice.id, providerChoice.name);
    }
  }

  /** Show the auth type picker: Subscription (OAuth) vs API Key */
  private async pickAuthType(): Promise<"oauth" | "api_key" | undefined> {
    const ITEMS = [
      { label: "Use a subscription", authType: "oauth" as const, description: "OAuth login for Anthropic, GitHub Copilot, OpenAI Codex" },
      { label: "Use an API key", authType: "api_key" as const, description: "Enter an API key for any provider" },
    ];
    const pick = await this.showQuickPick(ITEMS, "Select authentication method:");
    return pick?.authType;
  }

  /** Show provider picker for a given auth type */
  private async pickLoginProvider(
    authType: "oauth" | "api_key",
  ): Promise<{ id: string; name: string; authType: string } | undefined> {
    const options = this.getLoginProviderOptions(authType);
    if (options.length === 0) {
      const label = authType === "oauth" ? "No subscription providers available." : "No API key providers available.";
      await this.showInfoMessage(label);
      return undefined;
    }
    const pick = await this.showQuickPick(options, `Select ${authType === "oauth" ? "subscription" : "API key"} provider:`);
    return pick;
  }

  /** Build the list of provider options for login */
  private getLoginProviderOptions(
    authType: "oauth" | "api_key",
  ): Array<{ id: string; name: string; authType: string; label: string; description: string }> {
    const oauthProviders = this.authStorage.getOAuthProviders();
    const oauthProviderIds = new Set(oauthProviders.map((p: any) => p.id));
    const options: Array<{ id: string; name: string; authType: string; label: string; description: string }> = [];

    if (authType === "oauth") {
      // OAuth providers
      for (const provider of oauthProviders) {
        const authStatus = this.modelRegistry.getProviderAuthStatus(provider.id);
        options.push({
          id: provider.id,
          name: provider.name,
          authType: "oauth",
          label: provider.name,
          description: authStatus?.configured ? "$(check) Already configured" : "",
        });
      }
    } else {
      // API key providers — all model providers that aren't OAuth-only
      const allModels = this.modelRegistry.getAll();
      const seenProviders = new Set<string>();
      for (const model of allModels) {
        const providerId = model.provider;
        if (seenProviders.has(providerId)) { continue; }
        seenProviders.add(providerId);
        // Skip providers that only support OAuth
        if (oauthProviderIds.has(providerId)) { continue; }
        const displayName = this.modelRegistry.getProviderDisplayName(providerId);
        const authStatus = this.modelRegistry.getProviderAuthStatus(providerId);
        options.push({
          id: providerId,
          name: displayName,
          authType: "api_key",
          label: displayName,
          description: authStatus?.configured
            ? `$(check) Already configured (${authStatus.source})`
            : "",
        });
      }
    }

    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Show a VS Code quick pick (wraps showQuickPick since it's async and returns proper type) */
  private async showQuickPick<T extends { label: string; description?: string }>(
    items: T[],
    placeHolder: string,
  ): Promise<T | undefined> {
    const vscode = await import("vscode");
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked as T | undefined;
  }

  /** Show an info message */
  private async showInfoMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showInformationMessage(message);
  }

  /** Show an error message */
  private async showErrorMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showErrorMessage(message);
  }

  /**
   * Execute OAuth login flow for a provider.
   * Opens the browser, handles callbacks, and waits for completion.
   */
  private async doOAuthLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Logging in to ${providerName}...`,
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());

          await this.authStorage.login(providerId, {
            onAuth: (info: { url: string; instructions?: string }) => {
              // Open the URL in the browser
              vscode.env.openExternal(vscode.Uri.parse(info.url));
              if (info.instructions) {
                progress.report({ message: info.instructions });
              }
            },
            onPrompt: async (prompt: { message: string; placeholder?: string }) => {
              // Show an input box for the response
              return vscode.window.showInputBox({
                prompt: prompt.message,
                placeHolder: prompt.placeholder,
                password: true,
                ignoreFocusOut: true,
              }) ?? "";
            },
            onProgress: (message: string) => {
              progress.report({ message });
            },
            onManualCodeInput: () => {
              // For callback-server providers, prompt for manual paste
              return new Promise<string>((resolve, reject) => {
                token.onCancellationRequested(() => reject(new Error("Login cancelled")));
                vscode.window
                  .showInputBox({
                    prompt: "Paste redirect URL below, or complete login in browser:",
                    ignoreFocusOut: true,
                  })
                  .then((value) => {
                    if (value) { resolve(value); }
                    else { reject(new Error("Login cancelled")); }
                  });
              });
            },
            signal: abortController.signal,
          });

          progress.report({ message: "Login successful!" });
        },
      );

      // Refresh model registry and try to select a model for the provider
      this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "oauth", previousModel);
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to login to ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /**
   * Execute API key login flow for a provider.
   */
  private async doApiKeyLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${providerName}:`,
        password: true,
        placeHolder: "sk-...",
        validateInput: (value) => (value.trim() ? undefined : "API key required"),
        ignoreFocusOut: true,
      });

      if (!apiKey || !apiKey.trim()) {
        return; // cancelled
      }

      this.authStorage.set(providerId, { type: "api_key", key: apiKey.trim() });
      this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "api_key", previousModel);
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to save API key for ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /** After login, try to select a default model for the provider */
  private async completeLogin(
    providerId: string,
    providerName: string,
    authType: string,
    previousModel: { id?: string; provider?: string } | null,
  ): Promise<void> {
    const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

    // Try to select a default model for the provider if the current model is "unknown"
    if (this.AI && (!previousModel || previousModel.provider === "unknown")) {
      const availableModels = this.modelRegistry.getAvailable();
      const providerModels = availableModels.filter((m: any) => m.provider === providerId);
      if (providerModels.length > 0) {
        try {
          await this.setModel(providerId, providerModels[0].id);
          await this.showInfoMessage(`${actionLabel}. Selected ${providerModels[0].id}.`);
        } catch {
          await this.showInfoMessage(`${actionLabel}.`);
        }
        return;
      }
    }

    await this.showInfoMessage(`${actionLabel}.`);
  }

  /**
   * Show the logout flow for a provider.
   * Mirrors the pi CLI's /logout command.
   */
  async logout(): Promise<void> {
    if (!this.authStorage || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // Build list of providers that have credentials saved
    const options: Array<{ id: string; name: string; label: string; description: string }> = [];
    for (const providerId of this.authStorage.list()) {
      const credential = this.authStorage.get(providerId);
      if (!credential) { continue; }
      const displayName = this.modelRegistry.getProviderDisplayName(providerId);
      options.push({
        id: providerId,
        name: displayName,
        label: displayName,
        description: credential.type === "oauth" ? "OAuth subscription" : "API key",
      });
    }

    if (options.length === 0) {
      await this.showInfoMessage(
        "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
      );
      return;
    }

    const pick = await this.showQuickPick(
      options.sort((a, b) => a.name.localeCompare(b.name)),
      "Select provider to logout:",
    );
    if (!pick) { return; }

    try {
      this.authStorage.logout(pick.id);
      this.modelRegistry.refresh();
      const message =
        pick.description === "OAuth subscription"
          ? `Logged out of ${pick.name}`
          : `Removed stored API key for ${pick.name}. Environment variables and models.json config are unchanged.`;
      await this.showInfoMessage(message);
    } catch (error: any) {
      await this.showErrorMessage(`Logout failed: ${error.message ?? error}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────

  dispose() {
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = null;
    this.unsubscribe = null;
    this.SDK = null;
    this.AI = null;
    this.resourceLoader = null;
  }
}
