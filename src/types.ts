/** Image content for prompt attachments */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

/** Webview message for prompt with optional images */
export interface PromptMessage {
  type: "prompt";
  text: string;
  images?: ImageContent[];
}

export interface PiServiceEvent {
  type:
    // Core lifecycle
    | "agent-start"
    | "agent-end"
    // Turn lifecycle (one LLM response + tool execution batch)
    | "turn-start"
    | "turn-end"
    // Message lifecycle
    | "chat-message"       // user message (from message_start)
    | "assistant-start"    // assistant message started (from message_start for assistant)
    | "assistant-end"      // assistant message finalized (from message_end for assistant)
    | "stream-delta"       // text streaming (from message_update / text_delta)
    | "thinking-delta"     // thinking streaming (from message_update / thinking_delta)
    // Tool lifecycle
    | "tool-start"
    | "tool-end"
    | "tool-update"
    // Bash execution lifecycle (distinct from generic tools)
    | "bash-start"
    | "bash-output"
    | "bash-end"
    // Custom messages (from extensions)
    | "custom-message"
    // Compaction summary message (post-compaction feedback)
    | "compaction-summary-message"
    // User message list (for resend/reuse)
    | "user-messages-list"
    // Scoped models (from .pi/config.json)
    | "scoped-models-update"
    // Settings (auto-compaction, auto-retry, show-images)
    | "settings-update"
    // Session events
    | "status-update"
    | "queue-update"
    | "compaction-start"
    | "compaction-end"
    | "auto-retry-start"
    | "auto-retry-end"
    | "thinking-level-changed"
    // Slash command autocomplete
    | "slash-commands-update"
    // Extension widget bridge
    | "widget-update"
    // Errors
    | "error";
  data?: any;
}
