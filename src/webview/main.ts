// ── Pi Code Gui Webview Entry Point ─────────────────────────
//
// Initializes state, debug, rendering engine, tool renderers,
// event handlers, and the VS Code message bridge.
//
// Import order matters:
//   1. state.js    — shared mutable state
//   2. debug.js    — debug infrastructure
//   3. engine.js   — rendering functions (pure, no side effects)
//   4. tools.js    — registers tool renderers (side effect)
//   5. handlers.js — sets up message listener (side effect)

import { state, initState } from "./state.js";
import { initDebugObserver } from "./debug.js";
import {
  setupCodeBlockHandlers,
  updateStreamingState,
  scrollToBottom, applyFontSize,
} from "./render/engine.js";

// Side-effect imports (self-register on load)
import "./tools/index.js";
import "./handlers/index.js";

// ── Initialize ──────────────────────────────────────────────

// Acquire VS Code API and store globally (handlers need it)
const vscode = acquireVsCodeApi();
window.__vscode = vscode;

// Populate DOM refs (called automatically by state.js on import,
// but called again here for clarity and safety)
initState(document);

// Start MutationObserver for debug logging
initDebugObserver();

// Set up event delegation (code copy buttons, file path clicks)
setupCodeBlockHandlers();

// Set initial streaming state (show/hide buttons)
updateStreamingState();

// Request initial settings (zoom, font)
window.__vscode.postMessage({ type: "getSettings" });

// ── Scroll tracking ─────────────────────────────────────────
state.chatContainer.addEventListener("scroll", () => {
  const threshold = 50;
  const atBottom =
    state.chatContainer.scrollHeight -
      state.chatContainer.scrollTop -
      state.chatContainer.clientHeight <
    threshold;
  state.hasScrolledUp = !atBottom;

  // Lazy load: detect scroll-to-top
  if (!state._inBatch && !state._isLoadingMore &&
      state._loadedUpTo < state._totalEntries &&
      state.chatContainer.scrollTop < threshold) {
    state._isLoadingMore = true;
    window.__vscode.postMessage({ type: "loadMoreMessages" });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!state.hasScrolledUp) {
      scrollToBottom();
    }
  }
});

// ── Sidebar tab switching ────────────────────────────────

// Handle switchTab messages from extension (title bar buttons)
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "switchTab") {
    switchSidebarTab(message.data?.tab ?? "chat");
  }
});

function switchSidebarTab(tab: string): void {
  document.querySelectorAll(".sidebar-panel").forEach(function (panel) {
    (panel as HTMLElement).classList.toggle("active", panel.id === "panel-" + tab);
  });
  if (tab === "settings") {
    window.__vscode.postMessage({ type: "getSettings" });
  }
}

// ── Session tree state ─────────────────────────────────
// ── Settings ─────────────────────────────────────────────

let defaultBlockState = {
  thinking: "collapsed",
  read: "collapsed",
  write: "expanded",
  edit: "expanded",
  bash: "expanded",
};
window.__blockDefaults = defaultBlockState;

// Apply font size via CSS variable
// Handle settingsUpdate message from extension
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "settingsUpdate") {
    if (msg.data.defaultThinkingState) { defaultBlockState.thinking = msg.data.defaultThinkingState; const sel = document.getElementById("setting-thinking-state") as HTMLSelectElement | null; if (sel) sel.value = msg.data.defaultThinkingState; }
    if (msg.data.defaultReadState) { defaultBlockState.read = msg.data.defaultReadState; const sel = document.getElementById("setting-read-state") as HTMLSelectElement | null; if (sel) sel.value = msg.data.defaultReadState; }
    if (msg.data.defaultWriteState) { defaultBlockState.write = msg.data.defaultWriteState; const sel = document.getElementById("setting-write-state") as HTMLSelectElement | null; if (sel) sel.value = msg.data.defaultWriteState; }
    if (msg.data.defaultEditState) { defaultBlockState.edit = msg.data.defaultEditState; const sel = document.getElementById("setting-edit-state") as HTMLSelectElement | null; if (sel) sel.value = msg.data.defaultEditState; }

    if (msg.data.defaultBashState) { defaultBlockState.bash = msg.data.defaultBashState; const sel = document.getElementById("setting-bash-state") as HTMLSelectElement | null; if (sel) sel.value = msg.data.defaultBashState; }
    window.__blockDefaults = defaultBlockState;
    applyFontSize(msg.data.fontSize ?? 14);
  }
});

// Font size input
const fontInput = document.getElementById("setting-font-size") as HTMLInputElement | null;
fontInput?.addEventListener("input", () => {
  const raw = parseInt(fontInput.value);
  if (isNaN(raw)) { return; }
  const size = Math.max(0, Math.min(30, raw));
  if (String(size) !== fontInput.value) { fontInput.value = String(size); }
  applyFontSize(size);
  window.__vscode.postMessage({ type: "setFontSize", fontSize: size });
});

// Default state dropdowns
["thinking", "read", "write", "edit", "code", "bash"].forEach((key) => {
  const el = document.getElementById("setting-" + key + "-state") as HTMLSelectElement | null;
  el?.addEventListener("change", () => {
    defaultBlockState[key as keyof typeof defaultBlockState] = el.value;
    window.__vscode.postMessage({ type: "setDefaultState", key: "default" + key.charAt(0).toUpperCase() + key.slice(1) + "State", value: el.value });
  });
});

// ── Delegated events (for HTML-injected code blocks) ──────

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Code collapsible toggle
  const header = target.closest(".code-collapsible-header") as HTMLElement | null;
  if (header) {
    const body = header.parentElement?.querySelector(".code-collapsible-body") as HTMLElement | null;
    const arrow = header.querySelector(".code-collapsible-arrow") as HTMLElement | null;
    if (body && arrow) {
      const collapsed = body.classList.toggle("collapsed");
      arrow.textContent = collapsed ? "▼" : "▲";
    }
    return;
  }

  // Bash collapsible toggle
  const bashHeader = target.closest(".bash-header") as HTMLElement | null;
  if (bashHeader) {
    const body = bashHeader.parentElement?.querySelector(".bash-body") as HTMLElement | null;
    const arrow = bashHeader.querySelector(".bash-arrow") as HTMLElement | null;
    if (body && arrow) {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      arrow.textContent = hidden ? "▲" : "▼";
    }
    return;
  }

  // Copy button in AI-generated code blocks
  const copyBtn = target.closest(".code-copy-btn") as HTMLElement | null;
  if (copyBtn) {
    const pre = copyBtn.closest("pre") as HTMLElement | null;
    if (pre) {
      navigator.clipboard.writeText(pre.textContent || "");
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    }
  }
});
