// ── Shared application state ────────────────────────────────
//
// Single source of truth for all mutable state in the webview.
// Exported as a mutable object so any module can read or write
// fields freely (same as the old window.__pi.state namespace).
//
// DOM refs are populated by initState(document) on startup.

export const state = {
  // ── Boolean flags ──────────────────────────────────────────
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  _inBatch: false,

  // ── DOM element references (current streaming state) ────────
  currentAssistantEl: null,
  currentThinkingEl: null,

  // ── Tool execution tracking ────────────────────────────────
  currentToolBlocks: {}, // toolCallId -> { el, renderer } or HTMLElement
  assistantToolCallIds: {}, // toolCallId -> true

  // ── Message tracking ───────────────────────────────────────
  lastUserMessageContent: null,
  userMessagesSeen: 0,
  userMessageHistory: [],

  // ── Attachments ────────────────────────────────────────────
  attachments: [],

  // ── Bash execution blocks ──────────────────────────────────
  bashBlocks: {},
  bashOutputs: {},

  // ── Truncation text store ──────────────────────────────────
  truncationTexts: {},
  truncationIdx: 0,

  // ── Settings ───────────────────────────────────────────────
  settingsState: { autoCompaction: true, autoRetry: true, showImages: true },
  settingsOpen: false,

  // ── Scoped models ──────────────────────────────────────────
  scopedModels: [],

  // ── Overlay state ──────────────────────────────────────────
  userMsgSelectorOpen: false,
  slashAutocompleteOpen: false,
  slashFilter: "",
  slashSelectedIdx: 0,

  // ── Tool renderer registry ─────────────────────────────────
  toolRenderers: {},

  // ── Stream rendering (RAF-batched) ────────────────────────
  _streamRafId: null,
  _streamContentEl: null,
  _streamPrevTokens: [],
  _thinkingRafId: null,
  _thinkingEl: null,

  // ── Scroll tracking ────────────────────────────────────────
  hasScrolledUp: false,

  // ── Queue/steer mode ───────────────────────────────────────
  queueMode: "steer",

  // ── Marked availability flag ───────────────────────────────
  _markedAvailable: false,

  // ── Custom message renderer registry ───────────────────────
  messageRenderers: {},

  // ── Live panel cards ───────────────────────────────────────
  liveCards: {},
  widgetCards: {},

  // ── Slash commands ─────────────────────────────────────────
  builtinSlashCommands: [
    { cmd: "/compact", desc: "Compact context" },
    { cmd: "/resume", desc: "Resume a previous session" },
    { cmd: "/export", desc: "Export session to HTML" },
    { cmd: "/fork", desc: "Fork session from message" },
    { cmd: "/sessions", desc: "List sessions" },
    { cmd: "/model", desc: "Change model" },
    { cmd: "/thinking", desc: "Set thinking level" },
    { cmd: "/new", desc: "Start new session" },
    { cmd: "/settings", desc: "Open settings" },
    { cmd: "/login", desc: "Configure provider authentication" },
    { cmd: "/logout", desc: "Remove provider authentication" },
    { cmd: "/debug", desc: "Dump webview state for troubleshooting" },
  ],
  extensionSlashCommands: [],
  localSlashCommands: [
    "/login", "/logout", "/debug", "/model", "/thinking", "/sessions", "/settings",
  ],

  // ── DOM refs (populated by initState) ──────────────────────
  chatContainer: null,
  promptInput: null,
  sendButton: null,
  abortButton: null,
  steerDropdown: null,
  welcome: null,
  attachmentBar: null,
  userMsgOverlay: null,
  settingsOverlay: null,
  slashAutocomplete: null,
  livePanel: null,
  sbDot: null,
  sbModel: null,
  sbThinking: null,
  sbEffort: null,
  sbUsage: null,
};

/** Populate DOM refs from document. Call once on startup. */
export function initState(doc) {
  state.chatContainer = doc.getElementById("chat-container");
  state.promptInput = doc.getElementById("prompt-input");
  state.sendButton = doc.getElementById("send-button");
  state.abortButton = doc.getElementById("abort-button");
  state.steerDropdown = doc.getElementById("steer-dropdown");
  state.welcome = doc.getElementById("welcome");
  state.attachmentBar = doc.getElementById("attachment-bar");
  state.userMsgOverlay = doc.getElementById("user-msg-overlay");
  state.settingsOverlay = doc.getElementById("settings-overlay");
  state.slashAutocomplete = doc.getElementById("slash-autocomplete");
  state.livePanel = doc.getElementById("live-panel");
  state.sbDot = doc.getElementById("pi-sb-dot");
  state.sbModel = doc.getElementById("pi-sb-model");
  state.sbThinking = doc.getElementById("pi-sb-thinking");
  state.sbEffort = doc.getElementById("pi-sb-effort");
  state.sbUsage = doc.getElementById("pi-sb-usage");

  // Detect marked availability
  if (typeof marked !== "undefined") {
    state._markedAvailable = true;
  }
}

// Auto-initialize DOM refs on import (before any other module uses them)
if (typeof document !== "undefined") {
  initState(document);
}
