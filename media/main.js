/*global acquireVsCodeApi*/
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  // ═══ State ═══════════════════════════════════════════════

  var isStreaming = false;
  var isCompacting = false;
  var isRetrying = false;
  var currentAssistantEl = null;       // current streaming assistant message element
  var currentThinkingEl = null;        // current thinking block inside assistant message
  var currentToolBlocks = {};          // toolCallId -> tool block element
  var lastUserMessageContent = null;
  var assistantToolCallIds = {};       // toolCallId -> true, for dual-source dedup (message + execution)
  var userMessagesSeen = 0;
  var currentTurnBlock = null;          // current turn separator element
  var attachments = [];                // { id, type, name, mediaType, data, blobUrl }

  // DOM refs
  var chatContainer = document.getElementById("chat-container");
  var promptInput = document.getElementById("prompt-input");
  var sendButton = document.getElementById("send-button");
  var abortButton = document.getElementById("abort-button");
  var welcome = document.getElementById("welcome");
  var statusDot = document.getElementById("status-dot");
  var statusModel = document.getElementById("status-model");
  var statusThinking = document.getElementById("status-thinking");
  var statusEffort = document.getElementById("status-effort");
  var statusUsageText = document.getElementById("status-usage-text");
  var statusExtra = document.getElementById("status-extra");
  var attachmentBar = document.getElementById("attachment-bar");
  var statusScopedModels = null; // Removed from UI
  var statusSettingsBtn = document.getElementById("status-settings-btn");
  var userMsgOverlay = document.getElementById("user-msg-overlay");
  var settingsOverlay = document.getElementById("settings-overlay");
  var slashAutocomplete = document.getElementById("slash-autocomplete");

  // Bash execution blocks (#10)
  var bashBlocks = {};             // toolCallId -> bash block element
  var bashOutputs = {};            // toolCallId -> accumulated output string

  // Truncation text store (#6)
  var truncationTexts = {};        // id -> { preview: string, full: string }
  var truncationIdx = 0;

  // User message history for selector (#2)
  var userMessageHistory = [];

  // Settings state (#3)
  var settingsState = { autoCompaction: true, autoRetry: true, showImages: true };

  // Scoped models (#4)
  var scopedModels = [];

  // Settings overlay open flag
  var settingsOpen = false;
  var userMsgSelectorOpen = false;
  var slashAutocompleteOpen = false;
  var slashFilter = "";
  var slashSelectedIdx = 0;


  // ── Token formatting (mirrors TUI) ─────────────────────────

  function formatTokens(count) {
    if (!count || count === 0) return "0";
    if (count < 1000) return count.toString();
    if (count < 10000) return (count / 1000).toFixed(1) + "k";
    if (count < 100000) return Math.round(count / 1000) + "k";
    if (count < 1000000) return (count / 1000000).toFixed(1) + "M";
    return Math.round(count / 1000000) + "M";
  }

  // ═══ Event Router ═══════════════════════════════════════

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      // Agent lifecycle
      case "agent-start":         handleAgentStart(); break;
      case "agent-end":           handleAgentEnd(); break;

      // Turn lifecycle
      case "turn-start":          handleTurnStart(msg.data); break;
      case "turn-end":            handleTurnEnd(msg.data); break;

      // Message lifecycle
      case "chat-message":        handleChatMessage(msg.data); break;
      case "assistant-start":     handleAssistantStart(msg.data); break;
      case "assistant-end":       handleAssistantEnd(msg.data); break;
      case "stream-delta":        handleStreamDelta(msg.data); break;
      case "thinking-delta":      handleThinkingDelta(msg.data); break;

      // Tool lifecycle
      case "tool-start":          handleToolStart(msg.data); break;
      case "tool-update":         handleToolUpdate(msg.data); break;
      case "tool-end":            handleToolEnd(msg.data); break;

      // Session events
      case "status-update":       handleStatusUpdate(msg.data); break;
      case "status":              handleStatus(msg.data); break;
      case "queue-update":        handleQueueUpdate(msg.data); break;
      case "compaction-start":    handleCompactionStart(msg.data); break;
      case "compaction-end":      handleCompactionEnd(msg.data); break;
      case "auto-retry-start":    handleAutoRetryStart(msg.data); break;
      case "auto-retry-end":      handleAutoRetryEnd(msg.data); break;
      case "thinking-level-changed": handleThinkingLevelChanged(msg.data); break;

      // New features (#1, #2, #7, #9)
      case "compaction-summary-message": handleCompactionSummaryMessage(msg.data); break;
      case "bash-start":         handleBashStart(msg.data); break;
      case "bash-output":        handleBashOutput(msg.data); break;
      case "bash-end":           handleBashEnd(msg.data); break;
      case "custom-message":     handleCustomMessage(msg.data); break;
      case "user-messages-list": handleUserMessagesList(msg.data); break;
      case "scoped-models-update": handleScopedModelsUpdate(msg.data); break;
      case "settings-update":    handleSettingsUpdate(msg.data); break;
      case "revealEntry":        handleRevealEntry(msg.entryId); break;

      // Errors
      case "error":               handleError(msg.data); break;

      // UI commands from extension host
      case "sessionReset":        resetChat(); break;
      case "insertCommand":       handleInsertCommand(msg.command); break;


    }
  });

  // ═══ Agent Lifecycle ═══════════════════════════════════

  function handleAgentStart() {
    isStreaming = true;
    assistantToolCallIds = {};
    removeWorkingIndicator();
    addWorkingIndicator();
    updateStreamingState();
  }

  function handleAgentEnd() {
    isStreaming = false;
    isRetrying = false;
    assistantToolCallIds = {};
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();

    // If there's a stale streaming component (e.g. aborted without message_end), finalize it
    if (currentAssistantEl) {
      var mc = currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          var thinkingBlock = mc.querySelector(".thinking-block");
          mc.innerHTML = renderMarkdown(raw);
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }
      currentAssistantEl = null;
      currentThinkingEl = null;
    }

    // Finalize any pending tool blocks
    Object.keys(currentToolBlocks).forEach(function (id) {
      var block = currentToolBlocks[id];
      if (block && block.getAttribute("data-status") === "running") {
        var statusEl = block.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = "done";
          statusEl.className = "tool-status success";
        }
        block.setAttribute("data-status", "done");
      }
    });
    currentToolBlocks = {};

    updateStreamingState();
  }

  // ═══ Turn Lifecycle ═══════════════════════════════════=

  function handleTurnStart(data) {
    hideWelcome();

    // Build turn separator: ──── Turn N ────
    var turnNum = (data && data.turnIndex != null) ? data.turnIndex + 1 : 1;
    var sep = document.createElement("div");
    sep.className = "turn-separator";
    sep.innerHTML =
      '<div class="turn-label">Turn ' + turnNum + '</div>' +
      '<div class="turn-bar"></div>';
    chatContainer.appendChild(sep);
    currentTurnBlock = sep;
  }

  function handleTurnEnd(data) {
    // Track error state from the turn_end message (like Agent class does internally)
    if (data && data.message && data.message.role === "assistant" && data.message.errorMessage) {
      // If the current assistant container exists, show the error
      if (currentAssistantEl) {
        addErrorToElement(currentAssistantEl, data.message.errorMessage);
      }
    }
    // Keep the turn separator; clean up the reference for next turn
    currentTurnBlock = null;
  }

  // ═══ Message Lifecycle ═════════════════════════════════

  function handleChatMessage(data) {
    // Dedup: skip if same role+content as last user message
    if (data.role === "user" && data.content === lastUserMessageContent) return;
    if (data.role === "user") {
      lastUserMessageContent = data.content;
      // Populate userMessageHistory for up-arrow recall (#2)
      userMessageHistory.unshift({ text: data.content });
      if (userMessageHistory.length > 50) userMessageHistory.pop();
    }

    hideWelcome();
    removeWorkingIndicator(); // Hide working indicator when we get a response

    var el = createMessageEl(data.role);
    // #9: Entry ID for scroll-to
    if (data.entryId) el.id = "entry-" + data.entryId;
    var mc = el.querySelector(".message-content");
    if (mc) mc.innerHTML = renderMarkdown(data.content);
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  function handleAssistantStart(data) {
    hideWelcome();
    removeWorkingIndicator();

    // Create the assistant container eagerly before any content arrives
    currentAssistantEl = createMessageEl("assistant");
    // #9: Entry ID for scroll-to
    if (data.entryId) currentAssistantEl.id = "entry-" + data.entryId;
    currentThinkingEl = null;
    assistantToolCallIds = {};
    chatContainer.appendChild(currentAssistantEl);
    scrollToBottom();
  }

  function handleAssistantEnd(data) {
    // Finalize the assistant message
    if (currentAssistantEl) {
      var mc = currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          // Preserve any thinking block that was prepended during streaming.
          // handleThinkingDelta prepends <details class="thinking-block"> into mc,
          // but mc.innerHTML = ... would destroy it.
          var thinkingBlock = mc.querySelector(".thinking-block");
          mc.innerHTML = renderMarkdown(raw);
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }

      // Handle error/abort stop reasons (like TUI)
      if (data && data.stopReason) {
        if (data.stopReason === "aborted") {
          addErrorToElement(currentAssistantEl, data.errorMessage || "Operation aborted");
          // Mark any pending tool blocks as errored
          if (data.toolCalls) {
            data.toolCalls.forEach(function (tcId) {
              var block = currentToolBlocks[tcId];
              if (block) {
                var statusEl = block.querySelector(".tool-status");
                if (statusEl) {
                  statusEl.textContent = "error";
                  statusEl.className = "tool-status error";
                }
                block.setAttribute("data-status", "error");
                delete currentToolBlocks[tcId];
              }
            });
          }
        } else if (data.stopReason === "error") {
          addErrorToElement(currentAssistantEl, data.errorMessage || "Error");
        }
      }

      currentAssistantEl = null;
      currentThinkingEl = null;
    }
  }

  function handleStreamDelta(data) {
    hideWelcome();
    if (!currentAssistantEl) {
      // Safety: create container if assistant-start was missed
      currentAssistantEl = createMessageEl("assistant");
      currentThinkingEl = null;
      chatContainer.appendChild(currentAssistantEl);
    }
    var contentEl = currentAssistantEl.querySelector(".message-content");
    if (contentEl) {
      // Preserve the thinking block across innerHTML re-renders.
      // handleThinkingDelta prepends <details class="thinking-block"> into mc,
      // but innerHTML = renderMarkdown(raw) would destroy it.
      // We must save it BEFORE innerHTML and restore it AFTER.
      // currentThinkingEl is null after thinking finishes (done:true), so
      // we need to also look for an existing DOM thinking-block.
      var savedThinkingBlock = currentThinkingEl || contentEl.querySelector(".thinking-block");

      var raw = contentEl.getAttribute("data-raw") || "";
      raw += data.delta;
      contentEl.setAttribute("data-raw", raw);
      contentEl.innerHTML = renderMarkdown(raw);

      // Restore the thinking block after re-render
      if (savedThinkingBlock) {
        contentEl.prepend(savedThinkingBlock);
        // Keep currentThinkingEl in sync if it was the live one
        if (!currentThinkingEl) {
          currentThinkingEl = savedThinkingBlock;
        }
      }

      contentEl.classList.add("streaming-cursor");
    }
    scrollToBottom();
  }

  function handleThinkingDelta(data) {
    if (data.done) {
      // Keep currentThinkingEl alive so handleStreamDelta can save and
      // re-prepend it. If there's no more stream-delta after this,
      // handleAssistantEnd / handleAgentEnd will clean up references.
      return;
    }
    if (!currentThinkingEl) {
      currentThinkingEl = createThinkingBlock("");
      if (currentAssistantEl) {
        var mc = currentAssistantEl.querySelector(".message-content");
        if (mc) mc.prepend(currentThinkingEl);
      }
    }
    var tc = currentThinkingEl.querySelector(".thinking-content");
    if (tc) {
      tc.innerHTML += escapeHtml(data.delta);
      // No cursor — display-only block
    }
    scrollToBottom();
  }

  // ═══ Tool Lifecycle ════════════════════════════════════

  function handleToolStart(data) {
    hideWelcome();
    // Guard against duplicates
    if (currentToolBlocks[data.toolCallId]) {
      // Already created from message_update; transition from "pending" to "running"
      var block = currentToolBlocks[data.toolCallId];
      if (block && block.getAttribute("data-status") === "pending") {
        var statusEl = block.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = "running";
          statusEl.className = "tool-status running";
        }
        block.setAttribute("data-status", "running");
      }
      // Update the ID if we now have an entryId and the block doesn't have one
      if (data.entryId && block && !block.id.startsWith("entry-")) {
        block.id = "entry-" + data.entryId;
      }
      return;
    }

    var block = createToolBlock(data.toolName, data.toolCallId, "pending", data.args);
    if (data.entryId) block.id = "entry-" + data.entryId;
    chatContainer.appendChild(block);
    currentToolBlocks[data.toolCallId] = block;

    // If fromMessage=false (actual execution), mark as running
    if (!data.fromMessage) {
      var statusEl = block.querySelector(".tool-status");
      if (statusEl) {
        statusEl.textContent = "running";
        statusEl.className = "tool-status running";
      }
      block.setAttribute("data-status", "running");
    }
    scrollToBottom();
  }

  /** Render tool result content as markdown so code blocks, diffs, etc.
   *  get syntax highlighting, line numbers, and copy buttons. */
  function renderToolResult(text) {
    if (!text) return "";
    // First try: if text already starts with ```, it's already markdown
    if (/^```/.test(text.trim())) {
      return renderMarkdown(text);
    }

    // #5: Check if this is a diff result (e.g. from edit tool)
    if (/(?:^|\n)[+\-@]/.test(text) || /(?:^|\n)---\s/.test(text) || /(?:^|\n)\+\+\+\s/.test(text)) {
      return renderDiffMarkup(text);
    }

    // For multi-line tool results, wrap in a generic code block so the
    // rich rendering (line numbers, copy button, syntax highlighting) applies.
    var trimmed = text.trim();
    if (trimmed.indexOf("\n") !== -1 || trimmed.length > 120) {
      // Detect common structured data formats
      var lang = detectToolResultLang(trimmed);
      return renderMarkdown("```" + lang + "\n" + trimmed + "\n```");
    }

    // Short single-line results: render as inline markdown
    return renderMarkdown(text);
  }

  /** Guess the language of a tool result blob. */
  function detectToolResultLang(text) {
    // JSON objects/arrays
    if (/^[\[\{]\s*["\w]/.test(text) && /[\]\}]\s*$/.test(text)) return "json";
    // XML/HTML
    if (/<[a-z][\s\S]*>/i.test(text)) return "html";
    // Shell output (lines starting with $)
    if (/^\$ /.test(text)) return "bash";
    // Diff
    if (/^[@@]/.test(text) && /^[+-]/.test(text)) return "diff";
    // Log files
    if (text.length < 500 && /\[\d{4}-\d{2}-\d{2}|ERROR|WARN|INFO|TRACE/.test(text)) return "log";
    // TypeScript/JavaScript: import/export, const/let, function, =>, interfaces, types, etc.
    if (/(?:^|\n)\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|interface\s|type\s|class\s|async\s)/.test(text)) return "typescript";
    // Python: def, import, class, if __name__, decorators, etc.
    if (/(?:^|\n)\s*(?:def\s|import\s|from\s|class\s|@\w+|if\s+__name__)/.test(text)) return "python";
    // Go: package, func, import, := etc.
    if (/(?:^|\n)\s*(?:package\s|func\s|import\s|type\s\w+\sstruct)/.test(text)) return "go";
    // Rust: fn, let mut, impl, pub, etc.
    if (/(?:^|\n)\s*(?:fn\s|let\s+mut|impl\s|pub\s|use\s|mod\s|unsafe\s)/.test(text)) return "rust";
    // Java: public class, private, package, etc.
    if (/(?:^|\n)\s*(?:public\s+(?:class|void|static)|private\s|package\s|import\s+java)/.test(text)) return "java";
    // C/C++: #include, int main, void, struct, #define, etc.
    if (/(?:^|\n)\s*(?:#include|int\s+main|void\s+|struct\s|class\s+|#define|#ifndef)/.test(text)) return "cpp";
    // YAML/TOML: key: value patterns, ---, etc.
    if (/(?:^|\n)\s*---\s*$/.test(text) || /(?:^|\n)[a-zA-Z_][\w]*:\s+"|(?:^|\n)[a-zA-Z_][\w]*\s*=\s*"|^\w+\s*:\s+[\w\.]/.test(text)) return "yaml";
    // Markdown: # headers, ---, ```, | tables, etc.
    if (/(?:^|\n)\s*#{1,6}\s+/.test(text) || text.indexOf('```') !== -1) return "markdown";
    // Default: no specific lang (plain text / unknown)
    return "typescript";
  }

  function handleToolUpdate(data) {
    var block = currentToolBlocks[data.toolCallId];
    if (block) {
      var tr = block.querySelector(".tool-result");
      if (tr && data.partialResult && data.partialResult.content) {
        var text = data.partialResult.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
        if (text) {
          // #6: During streaming, limit to last 60 lines to avoid layout thrash
          var lines = text.split("\n");
          var displayText = lines.length > 60 ? "...\n" + lines.slice(-60).join("\n") : text;
          tr.innerHTML = renderToolResult(displayText);
          // No cursor — tool blocks are display-only
        }
      }
    }
    scrollToBottom();
  }

  function handleToolEnd(data) {
    var block = currentToolBlocks[data.toolCallId];
    if (block) {
      // Update the ID if we now have an entryId and the block doesn't have one
      if (data.entryId && block && !block.id.startsWith("entry-")) {
        block.id = "entry-" + data.entryId;
      }
      var statusEl = block.querySelector(".tool-status");
      if (statusEl) {
        statusEl.textContent = data.isError ? "error" : "done";
        statusEl.className = "tool-status " + (data.isError ? "error" : "success");
      }
      block.setAttribute("data-status", data.isError ? "error" : "done");

      // Show final result text with rich formatting (#5 + #6)
      var text = "";
      if (data.result && data.result.content) {
        text = data.result.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
      }
      var tr = block.querySelector(".tool-result");
      if (tr) {
        // #6: Truncate long results with show-more
        var lines = text.split("\n");
        if (lines.length > 50) {
          tr.innerHTML = renderToolResultTruncated(text);
        } else {
          tr.innerHTML = renderToolResult(text);
        }
        // No cursor — tool blocks are display-only
      }

      delete currentToolBlocks[data.toolCallId];
    }
    scrollToBottom();
  }

  // ═══ Session Events ════════════════════════════════════

  function handleStatusUpdate(data) {
    if (data.reset) return;
    if (data.model) statusModel.textContent = data.model;
    if (data.thinkingLevel) {
      statusThinking.textContent = "thinking: " + data.thinkingLevel;
    } else {
      statusThinking.textContent = "";
    }
    // Show effort if not "auto"
    if (data.effort && data.effort !== "auto") {
      statusEffort.textContent = "effort: " + data.effort;
    } else {
      statusEffort.textContent = "";
    }

    // Usage stats (tokens + cost + context %)
    if (data.usage) {
      var u = data.usage;
      var parts = [];
      if (u.input > 0) parts.push("\u2191" + formatTokens(u.input));
      if (u.output > 0) parts.push("\u2193" + formatTokens(u.output));
      if (u.cacheRead > 0) parts.push("R" + formatTokens(u.cacheRead));
      if (u.cacheWrite > 0) parts.push("W" + formatTokens(u.cacheWrite));

      var costStr = "";
      if (u.cost > 0) {
        costStr = "$" + u.cost.toFixed(3);
      }
      if (costStr) parts.push(costStr);

      // Context budget override indicator
      if (data.contextBudget > 0) {
        parts.push("budget:" + formatTokens(data.contextBudget));
      }

      // Context %
      if (u.contextWindow > 0 && u.contextPercent !== null) {
        var ctx = u.contextPercent.toFixed(1) + "%/" + formatTokens(u.contextWindow);
        // Colorize based on usage
        if (u.contextPercent > 90) {
          ctx = "<span style=\"color: var(--vscode-errorForeground);\">" + ctx + "</span>";
        } else if (u.contextPercent > 70) {
          ctx = "<span style=\"color: var(--vscode-editorWarning-foreground);\">" + ctx + "</span>";
        }
        parts.push(ctx);
      } else if (u.contextWindow > 0) {
        parts.push("?/" + formatTokens(u.contextWindow));
      }

      statusUsageText.innerHTML = parts.join(" ");
    } else {
      statusUsageText.innerHTML = "";
    }
  }

  function handleStatus(data) {
    if (data.model) statusModel.textContent = data.model;
    if (data.effort) {
      statusEffort.textContent = data.effort !== "auto" ? "effort: " + data.effort : "";
    }
    if (data.ready) {
      statusDot.className = "status-dot idle";
      statusDot.style.backgroundColor = ""; // Clear inline override so CSS class takes effect
      promptInput.disabled = false;
      sendButton.disabled = false;
      promptInput.placeholder = "Ask pi to do something...";
      promptInput.focus();
    } else if (data.model === "not installed" || data.model === "init failed") {
      statusDot.className = "status-dot idle";
      statusDot.style.backgroundColor = "var(--vscode-errorForeground)";
      promptInput.disabled = true;
      sendButton.disabled = true;
    }
  }

  function handleQueueUpdate(data) {
    // Show queued messages indicator (like TUI pendingMessagesContainer)
    var existing = document.getElementById("pending-queue-indicator");
    if (existing) existing.remove();

    var steering = data.steering || [];
    var followUp = data.followUp || [];
    if (steering.length === 0 && followUp.length === 0) return;

    var el = document.createElement("div");
    el.id = "pending-queue-indicator";
    el.style.cssText =
      "padding: 6px 16px; font-size: 0.8em; color: var(--vscode-descriptionForeground); " +
      "background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border);";

    var lines = [];
    steering.forEach(function (m) {
      lines.push("\u21E8 " + escapeHtml(m));
    });
    followUp.forEach(function (m) {
      lines.push("Follow-up: " + escapeHtml(m));
    });
    el.innerHTML = lines.join("<br>");

    // Insert between chat and input
    var inputArea = document.getElementById("input-area");
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(el, inputArea);
    }
  }

  function handleCompactionStart(data) {
    isCompacting = true;
    removeCompactionIndicator();
    addCompactionIndicator(data.reason === "manual" ? "Compacting..." : "Auto-compacting...");
    updateStreamingState();
  }

  function handleCompactionEnd(data) {
    isCompacting = false;
    removeCompactionIndicator();
    if (data.aborted) {
      addStatusMessage(data.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled");
    } else if (data.errorMessage) {
      addStatusMessage("Compaction error: " + data.errorMessage);
    } else if (data.result) {
      addStatusMessage("Compaction complete");
    }
    updateStreamingState();
  }

  function handleAutoRetryStart(data) {
    isRetrying = true;
    removeRetryIndicator();
    addRetryIndicator(data.attempt, data.maxAttempts, data.delayMs);
    updateStreamingState();
  }

  function handleAutoRetryEnd(data) {
    isRetrying = false;
    removeRetryIndicator();
    if (!data.success) {
      addErrorMessage("Retry failed after " + data.attempt + " attempts: " + (data.finalError || "Unknown error"));
    }
    updateStreamingState();
  }

  function handleThinkingLevelChanged(data) {
    // Already handled via status-update emission
  }

  // ═══ Error Handling ════════════════════════════════════

  function handleError(data) {
    hideWelcome();
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();

    addErrorMessage(data.message || "Unknown error");
    isStreaming = false;
    if (currentAssistantEl) {
      var mc = currentAssistantEl.querySelector(".message-content");
      if (mc) mc.classList.remove("streaming-cursor");
      currentAssistantEl = null;
      currentThinkingEl = null;
    }
    updateStreamingState();
    scrollToBottom();
  }

  // ═══ UI Helpers — Indicators ═══════════════════════════

  function addWorkingIndicator() {
    var existing = document.getElementById("working-indicator");
    if (existing) return;
    var el = document.createElement("div");
    el.id = "working-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content"><span class="working-spinner">○</span> Working...</div>';
    chatContainer.appendChild(el);
    chatContainer.appendChild(createSpacer());
    scrollToBottom();

    // Animate spinner
    var frames = ["○", "◔", "◐", "◓"];
    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = (frame + 1) % frames.length;
      var s = el.querySelector(".working-spinner");
      if (s) s.textContent = frames[frame];
    }, 300);
  }

  function removeWorkingIndicator() {
    var el = document.getElementById("working-indicator");
    if (el) {
      if (el._spinnerInterval) clearInterval(el._spinnerInterval);
      el.remove();
    }
    // Also remove trailing spacer
    var spacer = document.getElementById("working-spacer");
    if (spacer) spacer.remove();
  }

  function addCompactionIndicator(message) {
    var existing = document.getElementById("compaction-indicator");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "compaction-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content" style="color: var(--vscode-editorWarning-foreground);">' +
      '<span class="working-spinner">◆</span> ' + escapeHtml(message) + '</div>';
    chatContainer.appendChild(el);
    scrollToBottom();

    var frames = ["◇", "◆", "◇", "◆"];
    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = (frame + 1) % frames.length;
      var s = el.querySelector(".working-spinner");
      if (s) s.textContent = frames[frame];
    }, 400);
  }

  function removeCompactionIndicator() {
    var el = document.getElementById("compaction-indicator");
    if (el) {
      if (el._spinnerInterval) clearInterval(el._spinnerInterval);
      el.remove();
    }
  }

  function addRetryIndicator(attempt, maxAttempts, delayMs) {
    var existing = document.getElementById("retry-indicator");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "retry-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content" style="color: var(--vscode-editorWarning-foreground);">' +
      '<span class="working-spinner">↻</span> Retrying (' + attempt + '/' + maxAttempts +
      ') in ' + Math.ceil(delayMs / 1000) + 's...</div>';
    chatContainer.appendChild(el);
    scrollToBottom();

    // Countdown
    var remaining = delayMs;
    el._countdownInterval = setInterval(function () {
      remaining -= 1000;
      if (remaining <= 0) {
        var span = el.querySelector(".retry-countdown");
        if (span) span.textContent = "0s";
        clearInterval(el._countdownInterval);
      } else {
        var spans = el.querySelectorAll("span");
        var textNode = el.querySelector(".message-content");
        if (textNode) {
          textNode.innerHTML =
            '<span class="working-spinner">↻</span> Retrying (' + attempt + '/' + maxAttempts +
            ') in ' + Math.ceil(remaining / 1000) + 's...';
        }
      }
    }, 1000);
  }

  function removeRetryIndicator() {
    var el = document.getElementById("retry-indicator");
    if (el) {
      if (el._countdownInterval) clearInterval(el._countdownInterval);
      el.remove();
    }
  }

  // ═══ UI Helpers — Chat additions ═══════════════════════

  function addStatusMessage(message) {
    var el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = '<div class="message-content" style="color: var(--vscode-descriptionForeground);">' +
      escapeHtml(message) + '</div>';
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  function showQuickstartGuide() {
    // Remove any previous guide
    var existing = document.getElementById("quickstart-guide");
    if (existing) existing.remove();

    var el = document.createElement("div");
    el.id = "quickstart-guide";
    el.className = "message assistant";
    el.innerHTML =
      '<details class="thinking-block" open>' +
      '<summary>📖 Getting started with Pi</summary>' +
      '<div class="quickstart-content">' +

      '<h3>1. Get an API key</h3>' +
      '<p>Pi works with any LLM provider. You need at least one:</p>' +
      '<ul>' +
      '<li><strong>Anthropic (Claude)</strong> — <a href="https://console.anthropic.com/">console.anthropic.com</a> → API Keys</li>' +
      '<li><strong>OpenAI</strong> — <a href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a></li>' +
      '<li><strong>Google Gemini</strong> — <a href="https://aistudio.google.com/apikey">aistudio.google.com</a> (free tier)</li>' +
      '<li><strong>DeepSeek</strong> — <a href="https://platform.deepseek.com/api_keys">platform.deepseek.com</a> (very cheap)</li>' +
      '</ul>' +

      '<h3>🆓 Free & local options</h3>' +
      '<ul>' +
      '<li><strong>Ollama</strong> — run models locally or use cloud-hosted. <a href="https://ollama.com">ollama.com</a></li>' +
      '<li><strong>OpenRouter</strong> — unified API with free models. <a href="https://openrouter.ai/models?max_price=0">openrouter.ai/models?max_price=0</a></li>' +
      '<li><strong>GitHub Copilot</strong> — use <code>/login</code> in Pi and select Copilot (included with GitHub Copilot subscription)</li>' +
      '</ul>' +

      '<h3>2. Set the key</h3>' +
      '<p><strong>Option A:</strong> Run <strong>PiGui: Set Up API Key / Login</strong> from the command palette (<code>Ctrl+Shift+P</code>)</p>' +
      '<p><strong>Option B:</strong> Set an environment variable before opening VS Code:</p>' +
      '<pre><code>export ANTHROPIC_API_KEY=sk-ant-...\n# or\nexport OPENAI_API_KEY=sk-...</code></pre>' +

      '<h3>3. Start chatting</h3>' +
      '<p>Once your key is set, type a request and press Enter:</p>' +
      '<pre><code>Summarize this project and tell me how to run its checks.</code></pre>' +

      '<p style="margin-top:12px;"><a href="https://pi.dev/docs/latest/quickstart">📚 Full quickstart guide →</a>  ·  ' +
      '<a href="https://pi.dev/docs/latest/providers">🔑 All supported providers →</a></p>' +

      '</div>' +
      '</details>';
    chatContainer.appendChild(el);
  }

  function addErrorMessage(message) {
    var el = document.createElement("div");
    el.className = "message assistant";

    // Detect error type to show appropriate heading and help
    var heading = "";
    var help = "";
    var msg = message || "";
    var isApiKeyError = false;

    if (/api.?key/i.test(msg)) {
      heading = "<strong>API key required</strong>";
      help = '<small>Run <strong>PiGui: Set Up API Key / Login</strong> from the command palette ' +
             '(<code>Ctrl+Shift+P</code>), or set <code>ANTHROPIC_API_KEY</code> / ' +
             '<code>OPENAI_API_KEY</code> in your environment.</small>';
      isApiKeyError = true;
    } else if (/not installed|not found|not available|npm install/i.test(msg)) {
      heading = "<strong>Pi is not available</strong>";
      help = '<small>Run <code>npm install -g @mariozechner/pi-coding-agent</code> in a terminal, then reload VS Code.</small>';
    } else {
      heading = "<strong>Something went wrong</strong>";
      help = '<small>Check the error above for details.</small>';
    }

    el.innerHTML =
      '<div class="message-content" style="color: var(--vscode-errorForeground);">' +
      '⚠ ' + heading + '<br><br>' +
      renderMarkdown(msg) +
      '<br><br>' + help +
      '</div>';
    chatContainer.appendChild(el);

    // Show inline quickstart guide for API key errors
    if (isApiKeyError) {
      showQuickstartGuide();
    }

    scrollToBottom();
  }

  function addErrorToElement(parentEl, message) {
    if (!parentEl) return;
    var errorEl = document.createElement("div");
    errorEl.style.cssText = "color: var(--vscode-errorForeground); margin-top: 8px; padding: 4px 0;";
    errorEl.textContent = "\u26A0 " + message;
    parentEl.appendChild(errorEl);
  }

  // ═══ UI Helpers — Tool Block ═══════════════════════════

  function createToolBlock(toolName, toolCallId, status, args) {
    var block = document.createElement("div");
    block.className = "tool-block";
    block.id = "tool-" + toolCallId;
    block.setAttribute("data-status", status || "pending");

    var argsText = "";
    if (args) {
      try {
        argsText = JSON.stringify(args, null, 2);
      } catch (e) {
        argsText = String(args);
      }
    }

    block.innerHTML =
      '<div class="tool-header">' +
      '<span class="tool-name">' + escapeHtml(toolName) + '</span>' +
      '<span class="tool-status ' + (status === "running" ? "running" : "pending") + '">' +
        (status === "running" ? "running" : "pending") +
      '</span>' +
      '</div>' +
      (argsText ? '<div class="tool-args"><code>' + escapeHtml(truncate(argsText, 200)) + '</code></div>' : '') +
      '<div class="tool-result"></div>';

    return block;
  }

  // ═══ UI Helpers — General ══════════════════════════════

  function createSpacer() {
    var el = document.createElement("div");
    el.style.height = "4px";
    return el;
  }

  function createMessageEl(role) {
    var el = document.createElement("div");
    el.className = "message " + role;
    el.innerHTML = '<div class="message-content"></div>';
    return el;
  }

  function createThinkingBlock(content) {
    var el = document.createElement("details");
    el.className = "thinking-block";
    el.open = true;
    el.innerHTML =
      "<summary>Thinking</summary><div class=\"thinking-content\">" +
      escapeHtml(content) +
      "</div>";
    return el;
  }

  function hideWelcome() {
    if (welcome) { welcome.remove(); welcome = null; }
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || "";
    return text.substring(0, maxLen) + "...";
  }

  function resetChat() {
    chatContainer.innerHTML =
      '<div id="welcome" class="welcome-message"><h2>Pi coding agent</h2></div>';
    welcome = document.getElementById("welcome");
    currentAssistantEl = null;
    currentThinkingEl = null;
    currentToolBlocks = {};
    currentTurnBlock = null;
    assistantToolCallIds = {};
    lastUserMessageContent = null;
    isStreaming = false;
    isCompacting = false;
    isRetrying = false;
    bashBlocks = {};
    bashOutputs = {};
    truncationTexts = {};
    truncationIdx = 0;
    userMessageHistory = [];
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();
    clearAttachments();
    updateStreamingState();
  }

  function updateStreamingState() {
    if (isStreaming || isCompacting || isRetrying) {
      statusDot.className = "status-dot streaming";
      sendButton.classList.add("hidden");
      abortButton.classList.remove("hidden");
    } else {
      statusDot.className = "status-dot idle";
      sendButton.classList.remove("hidden");
      abortButton.classList.add("hidden");
    }
  }

  /** True when the user has manually scrolled up — pause auto-scroll. */
  var hasScrolledUp = false;

  // Track manual scrolls on the chat container
  chatContainer.addEventListener("scroll", function () {
    var threshold = 50;
    var atBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < threshold;
    hasScrolledUp = !atBottom;
  });

  // When the webview regains visibility (e.g. user alt-tabs back),
  // force-scroll to the bottom if auto-scroll was active before.
  // The browser defers scroll/layout while hidden, so new content
  // that arrived during absence may not have been scrolled into view.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      if (!hasScrolledUp) {
        scrollToBottom();
      }
    }
  });

  /** Scroll to bottom unless the user has scrolled up to read history.
   *  Uses rAF so scrollHeight is fresh — especially after visibility restore. */
  function scrollToBottom() {
    if (!hasScrolledUp) {
      requestAnimationFrame(function () {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }
  }

  // ═══ Markdown Rendering ═════════════════════════════════
  //
  // Code blocks get lang-aware, line-numbered, copyable editors.
  // We avoid complex dependencies — just clean HTML with proper CSS
  // and a "copy" button.  Users can click to open the snippet in
  // a real VS Code editor via the extension host.

  function renderMarkdown(text) {
    if (!text) return "";
    var html = escapeHtml(text);

    // Code blocks: ```lang\n...``` — render with preserved whitespace,
    // syntax-highlight class, line numbers, and a copy button.
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      function (m, lang, code) {
        // Normalise \r\n and trim trailing newline for consistent line counting
        code = code.replace(/\r\n?/g, "\n");
        code = code.replace(/\n+$/, "");

        // Build line-numbered content with syntax classes
        var lines = code.split("\n");
        var numberedContent = lines
          .map(function (line) {
            return (
              '<span class="code-ln"></span>' +
              '<span class="code-text" data-lang="' +
              escapeHtml(lang) +
              '">' +
              syntaxHighlightLine(line, lang) +
              "</span>"
            );
          })
          .join("\n");

        var langLabel = lang
          ? '<span class="code-lang-label">' + escapeHtml(lang) + "</span>"
          : "";
        return (
          '<div class="code-block-wrapper">' +
          '<div class="code-block-header">' +
          langLabel +
          '<button class="code-copy-btn" type="button">Copy</button>' +
          "</div>" +
          '<pre class="code-block" data-lang="' +
          escapeHtml(lang) +
          '"><code>' +
          numberedContent +
          "</code></pre>" +
          "</div>"
        );
      },
    );

    // Headers: # through ######
    html = html.replace(/^(#{1,6})\s+(.+)$/gm, function (m, hashes, text) {
      var level = hashes.length;
      return "<h" + level + ">" + text + "</h" + level + ">";
    });
    // Horizontal rules: ---, ***, ___
    html = html.replace(/^(?:[-*_]\s*){3,}$/gm, "<hr>");
    // Blockquotes: > text
    html = html.replace(/^>\s*(.+)$/gm, "<blockquote>$1</blockquote>");
    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
    // Strikethrough: ~~text~~
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Italic (must come after bold so ** doesn't match the italic pattern)
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Unordered lists
    html = html.replace(/^[\s]*[-*]\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
    // Ordered lists
    html = html.replace(/^[\s]*\d+\.\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, function (m) {
      return m.indexOf("<ol>") === -1 ? "<ol>" + m + "</ol>" : m;
    });
    // Paragraphs
    var segments = html.split(/\n{2,}/);
    html = segments
      .map(function (s) {
        s = s.trim();
        if (!s) return "";
        s = s.replace(/\n/g, "<br>");
        // Elements that should NOT be wrapped in <p>
        if (
          s.indexOf("<div class=\"code-block-wrapper\">") === 0 ||
          s.indexOf("<pre>") === 0 ||
          s.indexOf("<ul>") === 0 ||
          s.indexOf("<ol>") === 0 ||
          s.indexOf("<blockquote>") === 0 ||
          s.indexOf("<h") === 0 ||
          s.indexOf("<hr>") === 0
        )
          return s;
        return "<p>" + s + "</p>";
      })
      .join("\n");
    return html;
  }

  /**
   * Minimal syntax-highlight a single line by language.
   * Uses only regex-based tokenisation — no external lib.
   * Returns HTML with <span class="tok-xxx"> fragments.
   */
  function syntaxHighlightLine(line, lang) {
    line = escapeHtml(line);
    if (!lang) return line;
    lang = lang.toLowerCase();

    // JavaScript / TypeScript / JSX / TSX
    if (
      lang === "js" ||
      lang === "javascript" ||
      lang === "ts" ||
      lang === "typescript" ||
      lang === "jsx" ||
      lang === "tsx"
    ) {
      return highlightJS(line);
    }
    // Python
    if (lang === "py" || lang === "python") {
      return highlightPython(line);
    }
    // Rust
    if (lang === "rs" || lang === "rust") {
      return highlightRust(line);
    }
    // HTML / XML
    if (lang === "html" || lang === "xml" || lang === "svg") {
      return highlightHTML(line);
    }
    // CSS / SCSS / LESS
    if (lang === "css" || lang === "scss" || lang === "less") {
      return highlightCSS(line);
    }
    // Shell / bash
    if (
      lang === "bash" ||
      lang === "sh" ||
      lang === "shell" ||
      lang === "zsh"
    ) {
      return highlightShell(line);
    }
    // JSON
    if (lang === "json") {
      return highlightJSON(line);
    }
    // Java
    if (lang === "java") {
      return highlightJava(line);
    }
    // Go
    if (lang === "go" || lang === "golang") {
      return highlightGo(line);
    }

    return line;
  }

  // ── Language-specific highlighters ───────────────────────
  // Each returns HTML with spans like:
  //   <span class="tok-kw">const</span>

  var TOKENS = {
    kw: 'tok-kw',
    str: 'tok-str',
    num: 'tok-num',
    cm: 'tok-cm',
    fn: 'tok-fn',
    type: 'tok-type',
    prop: 'tok-prop',
    op: 'tok-op',
    builtin: 'tok-builtin',
    punct: 'tok-punct',
  };

  function span(cls, text) {
    return '<span class="' + cls + '">' + text + "</span>";
  }

  function highlightJS(line) {
    // Strip HTML-safed < and > back for pattern matching
    var raw = line;

    // Comments
    raw = raw.replace(
      /(\/\/[^"']*$)|(\/\*[\s\S]*?\*\/)/g,
      function (m) {
        return span(TOKENS.cm, m);
      },
    );
    // Strings (double, single, backtick)
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(\d+(?:\.\d+)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    var jsKeywords =
      "\\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|enum|implements|interface|package|private|protected|public)\b";
    raw = raw.replace(new RegExp(jsKeywords, "g"), function (m) {
      return span(TOKENS.kw, m);
    });
    // Builtins (null, undefined, true, false, NaN, Infinity)
    raw = raw.replace(
      /\b(null|undefined|true|false|NaN|Infinity)\b/g,
      function (m) {
        return span(TOKENS.builtin, m);
      },
    );
    // Function calls: identifier followed by (
    raw = raw.replace(/([a-zA-Z_$][\w$]*)\s*\(/g, function (m, id) {
      return span(TOKENS.fn, id) + "(";
    });
    return raw;
  }

  function highlightPython(line) {
    var raw = line;
    // Comments
    raw = raw.replace(/(#[^"']*$)/g, function (m) {
      return span(TOKENS.cm, m);
    });
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|("""[\s\S]*?""")|('''[\s\S]*?''')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(\d+(?:\.\d+)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    var pyKeywords =
      "\\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b";
    raw = raw.replace(new RegExp(pyKeywords, "g"), function (m) {
      return span(TOKENS.kw, m);
    });
    // Function calls
    raw = raw.replace(/([a-zA-Z_][\w]*)\s*\(/g, function (m, id) {
      return span(TOKENS.fn, id) + "(";
    });
    // Decorators
    raw = raw.replace(/(@[\w.]+)/g, function (m) {
      return span(TOKENS.prop, m);
    });
    return raw;
  }

  function highlightRust(line) {
    var raw = line;
    // Comments
    raw = raw.replace(
      /(\/\/[^"']*$)|(\/\*[\s\S]*?\*\/)/g,
      function (m) {
        return span(TOKENS.cm, m);
      },
    );
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(\d+(?:_\d+)*(?:\.\d+)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    var rsKeywords =
      "\\b(as|break|const|continue|crate|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|async|await|dyn)\b";
    raw = raw.replace(new RegExp(rsKeywords, "g"), function (m) {
      return span(TOKENS.kw, m);
    });
    // Type annotations (Foo, Vec, String, etc. after ":" or after "->")
    raw = raw.replace(/(\w+)(?=\s*[<&(])/g, function (m) {
      // skip keywords already highlighted
      return m;
    });
    // Lifetimes
    raw = raw.replace(/('\w+)/g, function (m) {
      return span(TOKENS.prop, m);
    });
    // Function calls
    raw = raw.replace(/([a-zA-Z_][\w]*)\s*\(/g, function (m, id) {
      return span(TOKENS.fn, id) + "(";
    });
    return raw;
  }

  function highlightHTML(line) {
    var raw = line;
    // HTML comments
    raw = raw.replace(/(<!--[\s\S]*?-->)/g, function (m) {
      return span(TOKENS.cm, m);
    });
    // Tags
    raw = raw.replace(
      /(&lt;\/?)([\w:-]+)/g,
      function (m, prefix, tag) {
        return prefix + span(TOKENS.kw, tag);
      },
    );
    // Attributes
    raw = raw.replace(
      /([\w:-]+)(=)(&quot;|"|')/g,
      function (m, attr, eq, q) {
        return span(TOKENS.prop, attr) + eq + q;
      },
    );
    // Attribute values
    raw = raw.replace(
      /(&quot;[^&]*&quot;|"[^"]*"|'[^']*')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    return raw;
  }

  function highlightCSS(line) {
    var raw = line;
    // Comments
    raw = raw.replace(
      /(\/\*[\s\S]*?\*\/)/g,
      function (m) {
        return span(TOKENS.cm, m);
      },
    );
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Properties (before " :")
    raw = raw.replace(/([\w-]+)(\s*:)/g, function (m, prop, colon) {
      return span(TOKENS.prop, prop) + colon;
    });
    // Values (numbers with units)
    raw = raw.replace(/\b(\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Selectors (before "{")
    raw = raw.replace(/([.#]?[\w-]+)\s*{/g, function (m, sel) {
      return span(TOKENS.kw, sel) + " {";
    });
    // Pseudo-classes
    raw = raw.replace(/(:\w+)/g, function (m) {
      return span(TOKENS.type, m);
    });
    return raw;
  }

  function highlightShell(line) {
    var raw = line;
    // Comments
    raw = raw.replace(/(#[^"']*$)/g, function (m) {
      return span(TOKENS.cm, m);
    });
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Variables
    raw = raw.replace(/(\$[\w{}]+)/g, function (m) {
      return span(TOKENS.prop, m);
    });
    // Commands (first word)
    raw = raw.replace(/^\s*(\w+)/gm, function (m) {
      return span(TOKENS.kw, m);
    });
    // Flags
    raw = raw.replace(/(--?\w+)/g, function (m) {
      return span(TOKENS.fn, m);
    });
    return raw;
  }

  function highlightJSON(line) {
    var raw = line;
    // Strings (keys and values)
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    raw = raw.replace(/\b(true|false|null)\b/g, function (m) {
      return span(TOKENS.kw, m);
    });
    return raw;
  }

  function highlightJava(line) {
    var raw = line;
    // Comments
    raw = raw.replace(
      /(\/\/[^"']*$)|(\/\*[\s\S]*?\*\/)/g,
      function (m) {
        return span(TOKENS.cm, m);
      },
    );
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(\d+(?:\.\d+)?[lLfFdD]?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    var javaKeywords =
      "\\b(abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null)\b";
    raw = raw.replace(new RegExp(javaKeywords, "g"), function (m) {
      return span(TOKENS.kw, m);
    });
    // Annotations
    raw = raw.replace(/(@\w+)/g, function (m) {
      return span(TOKENS.prop, m);
    });
    // Function calls
    raw = raw.replace(/([a-zA-Z_][\w]*)\s*\(/g, function (m, id) {
      return span(TOKENS.fn, id) + "(";
    });
    return raw;
  }

  function highlightGo(line) {
    var raw = line;
    // Comments
    raw = raw.replace(
      /(\/\/[^"']*$)|(\/\*[\s\S]*?\*\/)/g,
      function (m) {
        return span(TOKENS.cm, m);
      },
    );
    // Strings
    raw = raw.replace(
      /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)/g,
      function (m) {
        return span(TOKENS.str, m);
      },
    );
    // Numbers
    raw = raw.replace(/\b(\d+(?:\.\d+)?)\b/g, function (m) {
      return span(TOKENS.num, m);
    });
    // Keywords
    var goKeywords =
      "\\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b";
    raw = raw.replace(new RegExp(goKeywords, "g"), function (m) {
      return span(TOKENS.kw, m);
    });
    // Builtin types
    var goBuiltins =
      "\\b(bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr|nil|true|false|iota)\b";
    raw = raw.replace(new RegExp(goBuiltins, "g"), function (m) {
      return span(TOKENS.builtin, m);
    });
    // Function calls
    raw = raw.replace(/([a-zA-Z_][\w]*)\s*\(/g, function (m, id) {
      return span(TOKENS.fn, id) + "(";
    });
    return raw;
  }

  // ── Copy code block handler (event delegation) ───────────
  // Uses click delegation on the chat container to avoid inline onclick
  // which would violate CSP.

  function setupCodeBlockHandlers() {
    chatContainer.addEventListener("click", function (e) {
      // Show-more button for truncated tool results (#6)
      var showMoreBtn = e.target.closest(".show-more-btn");
      if (showMoreBtn) {
        e.preventDefault();
        var truncEl = showMoreBtn.closest(".tool-result-truncated");
        if (!truncEl) return;
        var expanded = truncEl.getAttribute("data-expanded") === "1";
        var id = truncEl.id;
        var stored = truncationTexts[id];
        if (!stored) return;
        var previewEl = truncEl.querySelector(".tool-result-preview");
        if (!previewEl) return;
        if (expanded) {
          previewEl.innerHTML = renderToolResult(stored.preview);
          truncEl.setAttribute("data-expanded", "0");
          showMoreBtn.textContent = "\u25BC " + truncEl.getAttribute("data-hidden") + " more lines";
        } else {
          previewEl.innerHTML = renderToolResult(stored.full);
          truncEl.setAttribute("data-expanded", "1");
          showMoreBtn.textContent = "\u25B2 Show less";
        }
        return;
      }

      var btn = e.target.closest(".code-copy-btn");
      if (!btn) return;
      e.preventDefault();

      var wrapper = btn.closest(".code-block-wrapper");
      if (!wrapper) return;
      var pre = wrapper.querySelector(".code-block");
      if (!pre) return;
      // Collect just the text content (strips all syntax spans)
      var text = pre.textContent || "";
      navigator.clipboard.writeText(text).then(
        function () {
          btn.textContent = "Copied!";
          setTimeout(function () {
            btn.textContent = "Copy";
          }, 2000);
        },
        function () {
          btn.textContent = "Failed";
          setTimeout(function () {
            btn.textContent = "Copy";
          }, 2000);
        },
      );
    });
  }

  // ═══ Input Handling ════════════════════════════════════

  // ═══ Attachment Handling ═══════════════════════════════

  function generateAttId() {
    return "att_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  function clearAttachments() {
    // Revoke blob URLs to free memory
    attachments.forEach(function (a) {
      if (a.blobUrl) URL.revokeObjectURL(a.blobUrl);
    });
    attachments = [];
    renderAttachments();
  }

  function removeAttachment(id) {
    var idx = attachments.findIndex(function (a) { return a.id === id; });
    if (idx === -1) return;
    var att = attachments[idx];
    if (att.blobUrl) URL.revokeObjectURL(att.blobUrl);
    attachments.splice(idx, 1);
    renderAttachments();
  }

  function renderAttachments() {
    if (!attachmentBar) return;

    if (attachments.length === 0) {
      attachmentBar.classList.remove("visible");
      attachmentBar.innerHTML = "";
      return;
    }

    attachmentBar.classList.add("visible");
    var html = "";

    for (var i = 0; i < attachments.length; i++) {
      var a = attachments[i];

      if (a.type === "image") {
        var src = a.blobUrl || "";
        html +=
          '<div class="attachment-item" title="' + escapeHtml(a.name) + '">' +
          '<img class="att-preview" src="' + src + '" alt="">' +
          '<span class="att-name">' + escapeHtml(a.name) + '</span>' +
          '<span class="att-remove" data-att-id="' + a.id + '">&times;</span>' +
          '</div>';
      } else {
        html +=
          '<div class="attachment-item" title="' + escapeHtml(a.name) + '">' +
          '<span class="att-icon">&#128196;</span>' +
          '<span class="att-name">' + escapeHtml(a.name) + '</span>' +
          '<span class="att-remove" data-att-id="' + a.id + '">&times;</span>' +
          '</div>';
      }
    }

    attachmentBar.innerHTML = html;

    // Delegate click events for remove buttons
    attachmentBar.querySelectorAll(".att-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var id = e.target.getAttribute("data-att-id");
        if (id) removeAttachment(id);
      });
    });
  }

  // ── Paste handler ──────────────────────────────────────

  promptInput.addEventListener("paste", function (e) {
    var items = e.clipboardData.items;
    if (!items) return;

    var imageItems = [];
    var fileItems = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type.startsWith("image/")) {
        imageItems.push(item);
      } else if (item.kind === "file") {
        fileItems.push(item);
      }
    }

    if (imageItems.length === 0 && fileItems.length === 0) return;

    e.preventDefault();

    // Capture any text from the clipboard too
    var pastedText = e.clipboardData.getData("text/plain") || "";

    // Process image items
    for (var j = 0; j < imageItems.length; j++) {
      (function (item) {
        var file = item.getAsFile();
        if (!file) return;

        var attId = generateAttId();
        var blobUrl = URL.createObjectURL(file);

        attachments.push({
          id: attId,
          type: "image",
          name: file.name || "pasted-image.png",
          mediaType: item.type,
          data: null,      // will be filled after FileReader
          blobUrl: blobUrl, // immediate preview
        });

        var reader = new FileReader();
        reader.onload = function () {
          var result = reader.result; // "data:image/png;base64,..."
          var att = attachments.find(function (a) { return a.id === attId; });
          if (att) {
            att.data = result.split(",")[1]; // just the base64 payload
          }
          renderAttachments();
        };
        reader.readAsDataURL(file);

        renderAttachments();
      })(imageItems[j]);
    }

    // Process file items
    for (var k = 0; k < fileItems.length; k++) {
      (function (item) {
        var file = item.getAsFile();
        if (!file) return;

        var attId = generateAttId();

        attachments.push({
          id: attId,
          type: "file",
          name: file.name || "unknown-file",
          mediaType: item.type,
          data: null,
          blobUrl: null,
        });

        // Read text files; mark binary files
        if (item.type.startsWith("text/") || !item.type) {
          var reader = new FileReader();
          reader.onload = function () {
            var att = attachments.find(function (a) { return a.id === attId; });
            if (att) {
              att.data = reader.result;
            }
            renderAttachments();
          };
          reader.readAsText(file);
        } else {
          var att = attachments.find(function (a) { return a.id === attId; });
          if (att) {
            att.data = "[Binary file: " + file.name + "]";
          }
          renderAttachments();
        }

        renderAttachments();
      })(fileItems[k]);
    }

    // Insert clipboard text at cursor position
    if (pastedText) {
      var start = promptInput.selectionStart;
      var end = promptInput.selectionEnd;
      var val = promptInput.value;
      promptInput.value = val.slice(0, start) + pastedText + val.slice(end);
      promptInput.selectionStart = promptInput.selectionEnd = start + pastedText.length;
      promptInput.dispatchEvent(new Event("input"));
    }
  });

  // ── Send prompt ───────────────────────────────────────

  function sendPrompt() {
    var text = promptInput.value.trim();
    if (!text && attachments.length === 0) return;

    // Reset scroll tracking — user clearly wants to follow the new response
    hasScrolledUp = false;

    // Intercept local slash commands before sending to LLM
    if (text && localSlashCommands.indexOf(text) !== -1) {
      var cmd = text.slice(1); // strip leading "/"
      vscode.postMessage({
        type: "slashCommand",
        command: cmd,
      });
      promptInput.value = "";
      promptInput.style.height = "auto";
      promptInput.style.overflowY = "hidden";
      clearAttachments();
      return;
    }

    // Build images array from image attachments with loaded data
    var images = attachments
      .filter(function (a) { return a.type === "image" && a.data; })
      .map(function (a) {
        return {
          type: "image",
          source: {
            type: "base64",
            mediaType: a.mediaType,
            data: a.data,
          },
        };
      });

    vscode.postMessage({
      type: "prompt",
      text: text,
      images: images.length > 0 ? images : undefined,
    });

    promptInput.value = "";
    promptInput.style.height = "auto";
    promptInput.style.overflowY = "hidden";
    clearAttachments();
  }

  sendButton.addEventListener("click", sendPrompt);

  abortButton.addEventListener("click", function () {
    vscode.postMessage({ type: "abort" });
  });

  // ── Status bar click handlers (model, thinking, effort) ──

  var statusModelPicker = document.getElementById("status-model-picker");
  var statusThinkingPicker = document.getElementById("status-thinking-picker");
  var statusEffortPicker = document.getElementById("status-effort-picker");

  if (statusModelPicker) {
    statusModelPicker.addEventListener("click", function () {
      vscode.postMessage({ type: "pickModel" });
    });
  }

  if (statusThinkingPicker) {
    statusThinkingPicker.addEventListener("click", function () {
      vscode.postMessage({ type: "pickThinkingLevel" });
    });
  }

  if (statusEffortPicker) {
    statusEffortPicker.addEventListener("click", function () {
      vscode.postMessage({ type: "pickEffort" });
    });
  }

  // Context budget picker — click usage area to change
  var statusUsage = document.getElementById("status-usage");
  if (statusUsage) {
    statusUsage.addEventListener("click", function () {
      vscode.postMessage({ type: "pickContextBudget" });
    });
  }

  // Settings button (#3)
  if (statusSettingsBtn) {
    statusSettingsBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleSettingsPanel();
    });
  }

  // Setup code block copy buttons (event delegation, CSP-safe)
  setupCodeBlockHandlers();

  // Handle external links and close overlays on outside clicks
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (target && target.tagName === "A" && target.href) {
      e.preventDefault();
      vscode.postMessage({ type: "openUrl", url: target.href });
    }
    // Close overlays when clicking outside
    if (settingsOpen && !settingsOverlay.contains(target) && target !== statusSettingsBtn && !statusSettingsBtn.contains(target)) {
      closeAllOverlays();
    }
    if (userMsgSelectorOpen && !userMsgOverlay.contains(target) && target !== promptInput) {
      closeAllOverlays();
    }
    if (slashAutocompleteOpen && !slashAutocomplete.contains(target) && target !== promptInput) {
      closeAllOverlays();
    }
  });

  promptInput.addEventListener("keydown", function (e) {
    // #8: Tab to accept slash autocomplete
    if (slashAutocompleteOpen && e.key === "Tab") {
      e.preventDefault();
      var sel = slashAutocomplete.querySelector(".slash-item.selected");
      if (sel) {
        promptInput.value = sel.getAttribute("data-cmd") + " ";
        promptInput.focus();
      }
      slashAutocomplete.classList.remove("visible");
      slashAutocompleteOpen = false;
      return;
    }
    // #8: Arrow keys in slash autocomplete
    if (slashAutocompleteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.key === "ArrowDown") slashSelectedIdx++;
      else slashSelectedIdx = Math.max(0, slashSelectedIdx - 1);
      updateSlashAutocomplete(slashFilter);
      return;
    }
    // #2: Up arrow in empty input → show user message history
    // Move this BEFORE the slash-autocomplete arrow handling so it takes
    // priority when the input is empty (no slash typed yet)
    if (e.key === "ArrowUp" && promptInput.value === "" && userMessageHistory.length > 0) {
      e.preventDefault();
      showUserMessageSelector();
      return;
    }
    // Esc to close all overlays
    if (e.key === "Escape") {
      if (slashAutocompleteOpen || settingsOpen || userMsgSelectorOpen) {
        closeAllOverlays();
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      closeAllOverlays();
      e.preventDefault();
      sendPrompt();
    }
  });

  promptInput.addEventListener("input", function () {
    // Cap at ~5 lines (approx 20px per line = 100px).
    // Only show scrollbar when the content actually exceeds the cap.
    var maxHeight = 100; // 5 lines ~ 100px
    promptInput.style.height = "auto";
    var newHeight = Math.min(promptInput.scrollHeight, maxHeight);
    promptInput.style.height = newHeight + "px";
    // Only enable overflow scrollbar when content is truncated
    if (promptInput.scrollHeight > maxHeight) {
      promptInput.style.overflowY = "auto";
    } else {
      promptInput.style.overflowY = "hidden";
    }

    // #8: Detect slash commands for autocomplete
    var val = promptInput.value;
    var slashMatch = val.match(/^\/(\w*)$/);
    if (slashMatch) {
      slashFilter = val;
      slashSelectedIdx = 0;
      updateSlashAutocomplete(val);
    } else {
      slashAutocomplete.classList.remove("visible");
      slashAutocompleteOpen = false;
    }
  });

  function resizePromptInput() {
    var maxHeight = 100;
    promptInput.style.height = "auto";
    var newHeight = Math.min(promptInput.scrollHeight, maxHeight);
    promptInput.style.height = newHeight + "px";
    promptInput.style.overflowY = promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function handleInsertCommand(command) {
    promptInput.value = command + " ";
    promptInput.focus();
    resizePromptInput();
  }

  // ═══ #1: Compaction Summary Message ═══════════════════════

  function handleCompactionSummaryMessage(data) {
    hideWelcome();
    var el = document.createElement("div");
    el.className = "compaction-summary";
    if (data.entryId) el.id = "entry-" + data.entryId;
    var tokenStr = (data.tokensBefore || 0).toLocaleString();
    var summaryId = "cs-" + Math.random().toString(36).slice(2, 8);
    el.innerHTML =
      '<div class="cs-header">[compaction]</div>' +
      '<div class="cs-preview" id="' + summaryId + '-toggle">Compacted from ' + tokenStr + ' tokens (click to expand)</div>' +
      '<div class="cs-content" id="' + summaryId + '-content" style="display:none">' + escapeHtml(data.summary || "") + '</div>';
    chatContainer.appendChild(el);

    // Wire toggle
    var toggle = document.getElementById(summaryId + "-toggle");
    var content = document.getElementById(summaryId + "-content");
    if (toggle && content) {
      toggle.addEventListener("click", function () {
        var visible = content.style.display !== "none";
        content.style.display = visible ? "none" : "block";
        toggle.textContent = visible ? "Compacted from " + tokenStr + " tokens (click to expand)" : "Compacted from " + tokenStr + " tokens";
      });
    }
    scrollToBottom();
  }

  // ═══ #2: User Message Selector ════════════════════════════

  function handleUserMessagesList(data) {
    userMessageHistory = (data.messages || []).reverse();
  }

  function showUserMessageSelector() {
    if (userMessageHistory.length === 0) return;
    closeAllOverlays();
    userMsgSelectorOpen = true;
    userMsgOverlay.classList.add("visible");
    var html = "";
    for (var i = 0; i < userMessageHistory.length; i++) {
      var msg = userMessageHistory[i];
      var text = msg.text || "";
      if (text.length > 100) text = text.slice(0, 100) + "\u2026";
      html += '<div class="user-msg-item" data-idx="' + i + '"><span class="msg-idx">' + (i + 1) + '</span>' + escapeHtml(text) + '</div>';
    }
    userMsgOverlay.innerHTML = html;

    // Click handlers
    var items = userMsgOverlay.querySelectorAll(".user-msg-item");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var idx = parseInt(this.getAttribute("data-idx"), 10);
        if (idx >= 0 && idx < userMessageHistory.length) {
          var text = userMessageHistory[idx].text;
          promptInput.value = text;
          promptInput.focus();
          resizePromptInput();
        }
        closeUserMsgSelector();
      });
    });
  }

  function closeUserMsgSelector() {
    userMsgSelectorOpen = false;
    userMsgOverlay.classList.remove("visible");
  }

  // ═══ #3: Settings Panel ═══════════════════════════════════

  function handleSettingsUpdate(data) {
    if (data) {
      settingsState = data;
      renderSettingsPanel();
    }
  }

  function handleScopedModelsUpdate(data) {
    if (data && data.models) {
      scopedModels = data.models;
      renderScopedModels();
      renderSettingsPanel();
    }
  }

  function renderScopedModels() {
    // Scoped models removed from UI
  }

  function renderSettingsPanel() {
    if (!settingsOverlay || !settingsOpen) return;
    var html = '<div class="settings-title">Settings</div>';

    var toggles = [
      { key: "autoCompaction", label: "Auto-compaction" },
      { key: "autoRetry", label: "Auto-retry" },
      { key: "showImages", label: "Show images" },
    ];

    for (var i = 0; i < toggles.length; i++) {
      var t = toggles[i];
      var on = settingsState[t.key];
      html +=
        '<div class="settings-row">' +
        '<span>' + t.label + '</span>' +
        '<span class="settings-toggle' + (on ? " on" : "") + '" data-key="' + t.key + '"></span>' +
        '</div>';
    }



    settingsOverlay.innerHTML = html;

    // Wire toggle clicks
    var togglesEls = settingsOverlay.querySelectorAll(".settings-toggle");
    togglesEls.forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = el.getAttribute("data-key");
        if (key === "autoCompaction") { vscode.postMessage({ type: "toggleAutoCompaction" }); }
        else if (key === "autoRetry") { vscode.postMessage({ type: "toggleAutoRetry" }); }
        else if (key === "showImages") { vscode.postMessage({ type: "toggleShowImages" }); }
      });
    });
  }

  function toggleSettingsPanel() {
    if (settingsOpen) {
      closeAllOverlays();
    } else {
      closeAllOverlays();
      settingsOpen = true;
      settingsOverlay.classList.add("visible");
      vscode.postMessage({ type: "getSettings" });
    }
  }

  function closeAllOverlays() {
    settingsOpen = false;
    userMsgSelectorOpen = false;
    slashAutocompleteOpen = false;
    settingsOverlay.classList.remove("visible");
    userMsgOverlay.classList.remove("visible");
    slashAutocomplete.classList.remove("visible");
  }

  // ═══ #5: Diff Rendering for edit tool results ════════════

  /** Render text with word-level diff highlighting when content looks like a diff */
  function renderDiffIfApplicable(text) {
    if (!text) return renderMarkdown(text);
    // Detect unified diff format: lines starting with + / - / @
    var hasDiff = /(?:^|\n)[+\-@]/.test(text) || /(?:^|\n)---\s/.test(text) || /(?:^|\n)\+\+\+\s/.test(text);
    if (!hasDiff) return renderMarkdown(text);
    return renderDiffMarkup(text);
  }

  function renderDiffMarkup(diffText) {
    var lines = diffText.split("\n");
    var resultLines = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var parsed = parseDiffLine(line);
      if (!parsed) {
        resultLines.push('<span class="diff-line-context">' + escapeHtml(line) + '</span>');
        i++;
        continue;
      }
      if (parsed.prefix === "-") {
        var removedLines = [];
        while (i < lines.length) {
          var p2 = parseDiffLine(lines[i]);
          if (!p2 || p2.prefix !== "-") break;
          removedLines.push(p2);
          i++;
        }
        var addedLines = [];
        while (i < lines.length) {
          var p3 = parseDiffLine(lines[i]);
          if (!p3 || p3.prefix !== "+") break;
          addedLines.push(p3);
          i++;
        }
        // Intra-line diff for single-line modifications
        if (removedLines.length === 1 && addedLines.length === 1) {
          var intra = diffWords(removedLines[0].content, addedLines[0].content);
          resultLines.push(
            '<span class="diff-line-removed">-' + removedLines[0].lineNum + " " + intra.removed + '</span>'
          );
          resultLines.push(
            '<span class="diff-line-added">+' + addedLines[0].lineNum + " " + intra.added + '</span>'
          );
        } else {
          for (var ri = 0; ri < removedLines.length; ri++) {
            resultLines.push('<span class="diff-line-removed">-' + removedLines[ri].lineNum + " " + escapeHtml(removedLines[ri].content) + '</span>');
          }
          for (var ai = 0; ai < addedLines.length; ai++) {
            resultLines.push('<span class="diff-line-added">+' + addedLines[ai].lineNum + " " + escapeHtml(addedLines[ai].content) + '</span>');
          }
        }
      } else if (parsed.prefix === "+") {
        resultLines.push('<span class="diff-line-added">+' + parsed.lineNum + " " + escapeHtml(parsed.content) + '</span>');
        i++;
      } else {
        resultLines.push('<span class="diff-line-context"> ' + parsed.lineNum + " " + escapeHtml(parsed.content) + '</span>');
        i++;
      }
    }
    return '<pre style="white-space:pre;font-family:var(--vscode-editor-font-family);font-size:0.85em;line-height:1.55;overflow-x:auto;padding:8px 0;">' + resultLines.join("\n") + '</pre>';
  }

  function parseDiffLine(line) {
    var match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
    if (!match) return null;
    return { prefix: match[1], lineNum: match[2], content: match[3] };
  }

  function diffWords(oldStr, newStr) {
    // Simple character/word-level diff: find common prefix/suffix, mark middle as changed
    var minLen = Math.min(oldStr.length, newStr.length);
    var prefixLen = 0;
    while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) prefixLen++;
    var suffixLen = 0;
    while (suffixLen < minLen - prefixLen && oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]) suffixLen++;

    var commonPrefix = escapeHtml(oldStr.slice(0, prefixLen));
    var commonSuffix = escapeHtml(oldStr.slice(oldStr.length - suffixLen));
    var removedMiddle = escapeHtml(oldStr.slice(prefixLen, oldStr.length - suffixLen));
    var addedMiddle = escapeHtml(newStr.slice(prefixLen, newStr.length - suffixLen));

    return {
      removed: commonPrefix + '<span class="diff-word-removed">' + removedMiddle + '</span>' + commonSuffix,
      added: commonPrefix + '<span class="diff-word-added">' + addedMiddle + '</span>' + commonSuffix,
    };
  }

  // ═══ #6: Visual Truncation for tool results ═══════════════

  /** Render tool result with "show more" if content is long (#6) */
  function renderToolResultTruncated(text, maxLines) {
    maxLines = maxLines || 50;
    if (!text) return "";
    var lines = text.split("\n");
    if (lines.length <= maxLines) return renderToolResult(text);

    var previewLines = lines.slice(0, maxLines);
    var hiddenCount = lines.length - maxLines;
    var previewText = previewLines.join("\n");
    var id = "trunc-" + (++truncationIdx);
    truncationTexts[id] = { preview: previewText, full: text };

    return (
      '<div class="tool-result-truncated" id="' + id + '" data-expanded="0" data-hidden="' + hiddenCount + '">' +
      '<div class="tool-result-preview">' + renderToolResult(previewText) + '</div>' +
      '<button class="show-more-btn">&dtrif; ' + hiddenCount + ' more lines</button>' +
      '</div>'
    );
  }

  // ═══ #7: Custom Message Rendering ═════════════════════════

  function handleCustomMessage(data) {
    hideWelcome();
    var el = document.createElement("div");
    el.className = "custom-message";
    if (data.entryId) el.id = "entry-" + data.entryId;
    var customType = data.customType || "custom";
    var content = "";
    if (typeof data.content === "string") {
      content = data.content;
    } else if (Array.isArray(data.content)) {
      content = data.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
    }
    el.innerHTML =
      '<div class="custom-label">[' + escapeHtml(customType) + ']</div>' +
      '<div class="custom-content">' + renderMarkdown(content) + '</div>';
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  // ═══ #8: Slash Command Autocomplete ═══════════════════════

  var slashCommands = [
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
  ];

  // Slash commands that should be handled locally (not sent to LLM)
  var localSlashCommands = ["/login", "/logout"];

  function updateSlashAutocomplete(filter) {
    if (!filter || filter.length === 0) {
      slashAutocomplete.classList.remove("visible");
      slashAutocompleteOpen = false;
      return;
    }
    var f = filter.toLowerCase();
    var matches = slashCommands.filter(function (sc) { return sc.cmd.toLowerCase().indexOf(f) === 0; });
    if (matches.length === 0) {
      slashAutocomplete.classList.remove("visible");
      slashAutocompleteOpen = false;
      return;
    }
    slashAutocomplete.classList.add("visible");
    slashAutocompleteOpen = true;
    slashSelectedIdx = Math.min(slashSelectedIdx, matches.length - 1);

    var html = "";
    for (var i = 0; i < matches.length; i++) {
      var sc = matches[i];
      html +=
        '<div class="slash-item' + (i === slashSelectedIdx ? " selected" : "") + '" data-index="' + i + '" data-cmd="' + escapeHtml(sc.cmd) + '">' +
        '<span class="slash-cmd">' + escapeHtml(sc.cmd) + '</span>' +
        '<span class="slash-desc">' + escapeHtml(sc.desc) + '</span>' +
        '</div>';
    }
    slashAutocomplete.innerHTML = html;

    // Wire click handlers
    var items = slashAutocomplete.querySelectorAll(".slash-item");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var cmd = item.getAttribute("data-cmd");
        if (cmd) {
          promptInput.value = cmd + " ";
          promptInput.focus();
          resizePromptInput();
        }
        slashAutocomplete.classList.remove("visible");
        slashAutocompleteOpen = false;
      });
    });
  }

  // ═══ #9: Scroll-to-entry ═══════════════════════════════════

  function handleRevealEntry(entryId) {
    if (!entryId) return;

    // Try multiple ID formats: entry-<id>, tool-<id>, bash-<id>
    var selectors = [
      "entry-" + entryId,
      "tool-" + entryId,
      "bash-" + entryId,
    ];
    var el = null;
    for (var i = 0; i < selectors.length; i++) {
      el = document.getElementById(selectors[i]);
      if (el) break;
    }

    if (el) {
      // Scroll the entry into view with a highlight flash
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background 0.2s, box-shadow 0.2s";
      el.style.background = "var(--vscode-list-hoverBackground)";
      el.style.boxShadow = "0 0 0 2px var(--vscode-focusBorder)";
      el.style.borderRadius = "4px";
      setTimeout(function () {
        el.style.background = "";
        el.style.boxShadow = "";
        el.style.borderRadius = "";
      }, 2500);
    } else {
      // Entry element not found — try searching all elements with entry-like IDs
      console.log("[pi-gui] revealEntry: element for id " + entryId + " not found by direct lookup");
      // Try fuzzy ID match as last resort
      var allChatChildren = chatContainer.querySelectorAll("[id]");
      for (var j = 0; j < allChatChildren.length; j++) {
        if (allChatChildren[j].id.indexOf(entryId) !== -1) {
          el = allChatChildren[j];
          break;
        }
      }
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.transition = "background 0.2s, box-shadow 0.2s";
        el.style.background = "var(--vscode-list-hoverBackground)";
        el.style.boxShadow = "0 0 0 2px var(--vscode-focusBorder)";
        el.style.borderRadius = "4px";
        setTimeout(function () {
          el.style.background = "";
          el.style.boxShadow = "";
          el.style.borderRadius = "";
        }, 2500);
      } else {
        // Last resort: scroll to bottom
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }
  }

  // ═══ #10: Bash Execution Blocks ════════════════════════════

  function handleBashStart(data) {
    hideWelcome();
    var block = document.createElement("div");
    block.className = "bash-execution";
    block.id = data.entryId ? "entry-" + data.entryId : "bash-" + data.toolCallId;
    block.setAttribute("data-status", "running");
    var cmd = data.command || "";
    if (cmd.length > 120) cmd = cmd.slice(0, 120) + "\u2026";
    block.innerHTML =
      '<div class="bash-header">$ ' + escapeHtml(cmd) + '</div>' +
      '<div class="bash-output"></div>' +
      '<div class="bash-footer"><span class="cancel-hint">running\u2026</span></div>';
    chatContainer.appendChild(block);
    bashBlocks[data.toolCallId] = block;
    bashOutputs[data.toolCallId] = "";
    scrollToBottom();
  }

  function handleBashOutput(data) {
    var block = bashBlocks[data.toolCallId];
    if (!block) return;
    bashOutputs[data.toolCallId] = (bashOutputs[data.toolCallId] || "") + (data.output || "");
    var outEl = block.querySelector(".bash-output");
    if (outEl) {
      outEl.innerHTML = escapeHtml(bashOutputs[data.toolCallId]);
    }
    scrollToBottom();
  }

  function handleBashEnd(data) {
    var block = bashBlocks[data.toolCallId];
    if (!block) return;
    var outEl = block.querySelector(".bash-output");
    if (outEl && data.output) {
      outEl.innerHTML = escapeHtml(data.output);
    }
    var footer = block.querySelector(".bash-footer");
    var status = data.isError ? "error" : "complete";
    if (footer) {
      var exitCode = data.exitCode != null ? data.exitCode : 0;
      footer.innerHTML =
        '<span class="exit-code' + (data.isError ? " error" : "") + '">exit: ' + exitCode + '</span>' +
        (data.cancelled ? ' <span>(cancelled)</span>' : "");
    }
    // Update the ID if we now have an entryId and the block doesn't have one
    if (data.entryId && block && !block.id.startsWith("entry-")) {
      block.id = "entry-" + data.entryId;
    }
    block.setAttribute("data-status", status);
    delete bashBlocks[data.toolCallId];
    delete bashOutputs[data.toolCallId];
    scrollToBottom();
  }

})();
