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
  if (message.type === "sessions-tree") {
    renderSessionTree(message.data);
  }
  if (message.type === "session-entries") {
    renderSessionEntries(message.data);
  }
});

// New session button
const newSessionBtn = document.getElementById("btn-new-session");
newSessionBtn?.addEventListener("click", () => {
  window.__vscode.postMessage({ type: "newSession" });
  switchSidebarTab("chat");
});

// Current session button (in history panel)
const currentSessionBtn = document.getElementById("btn-current-session");
currentSessionBtn?.addEventListener("click", () => {
  switchSidebarTab("chat");
});

// Tracks which tab the 💬 button should show next (remembers across tab switches)
let _lastChatTab = "chat";

function switchSidebarTab(tab: string): void {
  // 💬 button remembers last toggle state
  if (tab === "chat") {
    const chatPanel = document.getElementById("panel-chat");
    const historyPanel = document.getElementById("panel-history");
    const onChat = chatPanel?.classList.contains("active");
    const onHistory = historyPanel?.classList.contains("active");

    if (onChat) {
      tab = "history";            // toggle: chat → history
    } else if (onHistory) {
      tab = "chat";               // toggle: history → chat
    } else {
      tab = _lastChatTab;         // restore: packages/settings → last state
    }
  }

  document.querySelectorAll(".sidebar-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tab}`);
  });

  // Remember which tab was last shown (for restore from packages/settings)
  if (tab === "chat" || tab === "history") {
    _lastChatTab = tab;
  }

  if (tab === "history") {
    window.__vscode.postMessage({ type: "getSessionsTree" });
  }
  if (tab === "settings") {
    window.__vscode.postMessage({ type: "getSettings" });
  }
}

// ── Session tree state ─────────────────────────────────
var _sessionEntries: Record<string, any[]> = {};
var _openSessions: any[] = [];
var _pastSessions: any[] = [];
var _expandedSessions: Record<string, boolean> = {};

function renderSessionTree(data: any): void {
  var container = document.getElementById("history-content");
  if (!container) return;
  _openSessions = data.open || [];
  _pastSessions = data.past || [];

  var html = '<div class="session-tree">';
  // Open sessions
  if (_openSessions.length > 0) {
    html += '<div class="tree-section"><div class="tree-section-title">Open Sessions</div>';
    for (var i = 0; i < _openSessions.length; i++) {
      var s = _openSessions[i];
      var isExpanded = _expandedSessions[s.id];
      var entries = _sessionEntries[s.id] || [];
      html += '<div class="tree-session' + (isExpanded ? ' expanded' : '') + '" data-session-id="' + escapeAttr(s.id) + '">';
      html += '<div class="tree-session-header">';
      html += '<span class="tree-arrow">' + (isExpanded ? '▼' : '▶') + '</span>';
      html += '<span class="tree-session-label">' + escapeHtml(s.label || s.id) + '</span>';
      html += '<span class="tree-entry-count">' + s.entryCount + '</span>';
      html += '</div>';
      if (isExpanded) {
        html += '<div class="tree-entries">';
        if (entries.length === 0) {
          html += '<div class="tree-entry loading">Loading...</div>';
        } else {
          for (var j = 0; j < entries.length; j++) {
            var e = entries[j];
            html += '<div class="tree-entry" data-entry-id="' + escapeAttr(e.id) + '" data-session-id="' + escapeAttr(s.id) + '">';
            html += '<span class="tree-entry-icon">' + getEntryIcon(e.type) + '</span>';
            html += '<span class="tree-entry-text">' + escapeHtml(e.preview || e.type) + '</span>';
            html += '</div>';
          }
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  // Past sessions
  html += '<div class="tree-section"><div class="tree-section-title">Past Sessions (' + _pastSessions.length + ')</div>';
  if (_pastSessions.length === 0) {
    html += '<p class="sidebar-placeholder">No past sessions</p>';
  } else {
    for (var k = 0; k < _pastSessions.length; k++) {
      var p = _pastSessions[k];
      var name = p.name || p.summary || "Session";
      var time = timeAgo(p.modified);
      html += '<div class="past-session-item" data-path="' + escapeAttr(p.path) + '">';
      html += '<div class="tree-entry-text">' + escapeHtml(name) + '</div>';
      if (time) { html += '<div class="tree-entry-time">' + time + '</div>'; }
      html += '</div>';
    }
  }
  html += '</div></div>';
  container.innerHTML = html;
  wireTreeEvents(container);
}

function renderSessionEntries(data: any): void {
  _sessionEntries[data.sessionId] = data.entries || [];
  // Re-render if the session is expanded
  if (_expandedSessions[data.sessionId]) {
    var container = document.getElementById("history-content");
    if (container) { renderSessionTree({ open: _openSessions, past: _pastSessions }); }
  }
}

function wireTreeEvents(container: HTMLElement): void {
  // Session header click → toggle expand
  container.querySelectorAll(".tree-session-header").forEach(function (header) {
    header.addEventListener("click", function () {
      var sessionEl = header.closest(".tree-session") as HTMLElement;
      if (!sessionEl) return;
      var id = sessionEl.dataset.sessionId;
      if (!id) return;
      if (_expandedSessions[id]) {
        _expandedSessions[id] = false;
      } else {
        _expandedSessions[id] = true;
        // Fetch entries if not loaded
        if (!_sessionEntries[id]) {
          window.__vscode.postMessage({ type: "getSessionEntries", sessionId: id });
        }
      }
      renderSessionTree({ open: _openSessions, past: _pastSessions });
    });
  });
  // Entry click → revealEntry
  container.querySelectorAll(".tree-entry").forEach(function (entry) {
    entry.addEventListener("click", function () {
      var sessionId = (entry as HTMLElement).dataset.sessionId;
      var entryId = (entry as HTMLElement).dataset.entryId;
      if (sessionId && entryId) {
        window.__vscode.postMessage({ type: "focusSession", sessionId: sessionId });
        window.__vscode.postMessage({ type: "revealEntry", sessionId: sessionId, entryId: entryId });
        switchSidebarTab("chat");
      }
    });
  });
  // Past session click → resume
  container.querySelectorAll(".past-session-item").forEach(function (item) {
    item.addEventListener("click", function () {
      var path = (item as HTMLElement).dataset.path;
      if (path) {
        window.__vscode.postMessage({ type: "resumeSession", path: path });
      }
    });
  });
}

function getEntryIcon(type: string): string {
  if (type === "compaction") return "📦";
  return "💬";
}

function timeAgo(ts: string | number | undefined): string {
  if (!ts) return "";
  var diff = Date.now() - new Date(ts).getTime();
  var min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  var days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return days + "d ago";
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(text: string): string {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
function applyFontSize(size: number): void {
  if (size > 0) {
    document.documentElement.style.setProperty("--pi-font-size", size + "px");
  } else {
    document.documentElement.style.removeProperty("--pi-font-size");
  }
  const el = document.getElementById("setting-font-size") as HTMLInputElement | null;
  if (el) { el.value = String(size); }
}

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
