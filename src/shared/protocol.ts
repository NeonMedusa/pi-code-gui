// ═══════════════════════════════════════════════════════════════════
// Shared message protocol between extension host and webview
// ═══════════════════════════════════════════════════════════════════
//
// This file is the single source of truth for every message that
// crosses the postMessage bridge.  Both src/pi-service.ts (extension)
// and src/webview-panel.ts (webview loader) import from here.
//
// When a message shape changes, tsc catches it on BOTH sides.

// ── Extension → Webview messages ────────────────────────────────

export interface StreamDeltaData {
  delta: string;
}

export interface ThinkingDeltaData {
  delta: string;
  done?: boolean;
}

export interface ToolStartData {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  entryId?: string;
  fromMessage?: boolean;
}

export interface ToolUpdateData {
  toolCallId: string;
  toolName?: string;
  partialResult: {
    content?: Array<{ type: string; text: string }>;
  };
}

export interface ToolEndData {
  toolCallId: string;
  toolName: string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  };
  isError: boolean;
  entryId?: string;
}

export interface StatusUpdateData {
  model?: string;
  thinkingLevel?: string;
  effort?: string;
  usage?: {
    input: number;
    output: number;
    cost: number;
    contextPercent: number;
  };
  isStreaming?: boolean;
  ready?: boolean;
  reset?: boolean;
}

export interface ChatMessageData {
  role: "user" | "assistant";
  content: string;
  entryId?: string;
}

export interface AssistantStartData {
  messageId: string;
  entryId?: string;
}

export interface AssistantEndData {
  stopReason?: string;
  errorMessage?: string;
  toolCalls?: string[];
}

export interface CompactionSummaryMessageData {
  summary: string;
  tokensBefore: number;
  timestamp?: number;
  entryId?: string;
}

export interface QueueUpdateData {
  steering: string[];
  followUp: string[];
}

export interface BatchStartData {
  hasEntries?: boolean;
}

export interface BatchEndData {
  hasEntries?: boolean;
}

export interface BashStartData {
  toolCallId: string;
  command: string;
  entryId?: string;
}

export interface BashOutputData {
  toolCallId: string;
  output: string;
}

export interface BashEndData {
  toolCallId: string;
  command: string;
  exitCode: number;
  cancelled: boolean;
  output: string;
  isError: boolean;
  entryId?: string;
}

export interface CustomMessageData {
  customType: string;
  content: string | Array<{ type: string; text: string }>;
  timestamp?: number;
  entryId?: string;
}

export interface WidgetUpdateData {
  key: string;
  content: string | null; // null = remove widget
}

export interface ScopedModelsUpdateData {
  models: Array<{ id: string; name: string }>;
}

export interface SettingsUpdateData {
  autoCompaction: boolean;
  autoRetry: boolean;
  showImages: boolean;
}

export interface SlashCommandsUpdateData {
  commands: Array<{ cmd: string; desc: string }>;
}

export interface ErrorData {
  message: string;
}

export interface CompactionStartData {
  reason?: string;
}

export interface CompactionEndData {
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  result?: unknown;
  errorMessage?: string;
}

export interface AutoRetryStartData {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage?: string;
}

export interface AutoRetryEndData {
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface ThinkingLevelChangedData {
  level: string;
}

export interface UserMessagesListData {
  messages: Array<{ text: string }>;
}

export interface AgentEndData {
  messages?: unknown[];
}

export interface TurnStartData {
  // Currently empty in pi-service.ts
}

export interface TurnEndData {
  message?: {
    role?: string;
    content?: string;
    errorMessage?: string;
  };
  toolResults?: unknown[];
}

// ── Discriminated union: extension → webview ────────────────────

export type ExtensionToWebview =
  // Agent lifecycle
  | { type: "agent-start"; data?: undefined }
  | { type: "agent-end"; data?: AgentEndData }
  // Turn lifecycle
  | { type: "turn-start"; data?: TurnStartData }
  | { type: "turn-end"; data?: TurnEndData }
  // Message lifecycle
  | { type: "chat-message"; data: ChatMessageData }
  | { type: "assistant-start"; data: AssistantStartData }
  | { type: "assistant-end"; data: AssistantEndData }
  | { type: "stream-delta"; data: StreamDeltaData }
  | { type: "thinking-delta"; data: ThinkingDeltaData }
  // Tool lifecycle
  | { type: "tool-start"; data: ToolStartData }
  | { type: "tool-update"; data: ToolUpdateData }
  | { type: "tool-end"; data: ToolEndData }
  // Bash execution
  | { type: "bash-start"; data: BashStartData }
  | { type: "bash-output"; data: BashOutputData }
  | { type: "bash-end"; data: BashEndData }
  // Status & Settings
  | { type: "status-update"; data: StatusUpdateData }
  | { type: "status"; data?: StatusUpdateData }
  | { type: "queue-update"; data: QueueUpdateData }
  // Compaction & Retry
  | { type: "compaction-start"; data: CompactionStartData }
  | { type: "compaction-end"; data: CompactionEndData }
  | { type: "compaction-summary-message"; data: CompactionSummaryMessageData }
  | { type: "auto-retry-start"; data: AutoRetryStartData }
  | { type: "auto-retry-end"; data: AutoRetryEndData }
  // Batch replay
  | { type: "batch-start"; data: BatchStartData }
  | { type: "batch-end"; data: BatchEndData }
  // Thinking
  | { type: "thinking-level-changed"; data: ThinkingLevelChangedData }
  // Custom messages (extensions)
  | { type: "custom-message"; data: CustomMessageData }
  // User messages list
  | { type: "user-messages-list"; data: UserMessagesListData }
  // Scoped models
  | { type: "scoped-models-update"; data: ScopedModelsUpdateData }
  // Settings
  | { type: "settings-update"; data: SettingsUpdateData }
  // Scroll to entry
  | { type: "revealEntry"; entryId: string }
  // Error
  | { type: "error"; data: ErrorData }
  // Commands
  | { type: "sessionReset" }
  | { type: "insertCommand"; command: string }
  // Slash commands from extensions
  | { type: "slash-commands-update"; data: SlashCommandsUpdateData }
  // Extension widget bridge
  | { type: "widget-update"; data: WidgetUpdateData };

// ── Webview → Extension messages ────────────────────────────────

export interface PromptData {
  text: string;
  images?: Array<{
    type: "image";
    source: {
      type: "base64";
      mediaType: string;
      data: string;
    };
  }>;
  mode?: string; // "steer" | "queue"
}

export type WebviewToExtension =
  | { type: "prompt"; text: string; images?: PromptData["images"]; mode?: string }
  | { type: "abort" }
  | { type: "slashCommand"; command: string }
  | { type: "pickModel" }
  | { type: "pickThinkingLevel" }
  | { type: "pickEffort" }
  | { type: "pickContextBudget" }
  | { type: "getSettings" }
  | { type: "toggleAutoCompaction" }
  | { type: "toggleAutoRetry" }
  | { type: "toggleShowImages" }
  | { type: "openUrl"; url: string }
  | { type: "promoteToSteer"; text: string }
  | { type: "clearQueue" }
  | { type: "resendUserMessage"; text: string };
