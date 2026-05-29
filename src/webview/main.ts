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
  scrollToBottom,
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

// ── Scroll tracking ─────────────────────────────────────────
state.chatContainer.addEventListener("scroll", () => {
  const threshold = 50;
  const atBottom =
    state.chatContainer.scrollHeight -
      state.chatContainer.scrollTop -
      state.chatContainer.clientHeight <
    threshold;
  state.hasScrolledUp = !atBottom;
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
  if (message.type === "sessionsList") {
    renderHistoryList(message.data ?? []);
  }
});

// New session button
const newSessionBtn = document.getElementById("btn-new-session");
newSessionBtn?.addEventListener("click", () => {
  window.__vscode.postMessage({ type: "newSession" });
  switchSidebarTab("chat");
});

function switchSidebarTab(tab: string): void {
  document.querySelectorAll(".sidebar-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tab}`);
  });

  if (tab === "history") {
    window.__vscode.postMessage({ type: "listSessions" });
  }
}

function renderHistoryList(sessions: any[]): void {
  const container = document.getElementById("history-content");
  if (!container) return;

  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="sidebar-placeholder">No past sessions</p>';
    return;
  }

  let html = '<div class="history-list">';
  for (const s of sessions) {
    const name = s.name || s.summary || `Session ${s.id ?? ""}`;
    const time = s.lastModified
      ? new Date(s.lastModified).toLocaleDateString()
      : "";
    html += `<div class="history-item" data-path="${s.path ?? ""}">
      <div class="history-item-content">
        <div class="history-item-title">${escapeHtml(name)}</div>
        <div class="history-item-time">${time}</div>
      </div>
      <button class="history-item-delete" title="Delete session">×</button>
    </div>`;
  }
  html += "</div>";
  container.innerHTML = html;

  // Click to resume
  container.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      // Ignore clicks on the delete button
      if ((e.target as HTMLElement).classList.contains("history-item-delete")) { return; }
      const path = (el as HTMLElement).dataset.path;
      if (path) {
        window.__vscode.postMessage({ type: "resumeSession", path });
        switchSidebarTab("chat");
      }
    });
  });

  // Delete button
  container.querySelectorAll(".history-item-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = (btn as HTMLElement).closest(".history-item") as HTMLElement;
      const path = item?.dataset.path;
      if (!path) { return; }
      window.__vscode.postMessage({ type: "deleteSession", path });
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Listen for resumeResult
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "resumeResult" && !message.data?.success) {
    console.error("Resume failed:", message.data?.error);
  }
});
