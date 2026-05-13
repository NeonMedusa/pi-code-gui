(function () {
  "use strict";

  // ── Dependencies ────────────────────────────────────────
  var state = window.__pi.state;
  var core = window.__pi.core;
  var tools = window.__pi.tools;
  var app = window.__pi.app = {};

  // ── Local aliases (state — objects/DOM refs) ────────────
  var vscode = state.vscode;
  var chatContainer = state.chatContainer;
  var promptInput = state.promptInput;
  var sendButton = state.sendButton;
  var abortButton = state.abortButton;
  var steerDropdown = state.steerDropdown;
  var attachmentBar = state.attachmentBar;
  var userMsgOverlay = state.userMsgOverlay;
  var settingsOverlay = state.settingsOverlay;
  var slashAutocomplete = state.slashAutocomplete;
  var livePanel = state.livePanel;
  var liveCards = state.liveCards;
  var currentToolBlocks = state.currentToolBlocks;
  var assistantToolCallIds = state.assistantToolCallIds;
  var attachments = state.attachments;
  var userMessageHistory = state.userMessageHistory;
  var bashBlocks = state.bashBlocks;
  var bashOutputs = state.bashOutputs;
  var settingsState = state.settingsState;
  var scopedModels = state.scopedModels;
  var toolRenderers = state.toolRenderers;
  var debugEventLog = state.debugEventLog;
  var debugDomLog = state.debugDomLog;
  var debugMaxEvents = state.debugMaxEvents;
  var debugMaxDomLog = state.debugMaxDomLog;
  var debugEnabled = state.debugEnabled;

  // ── Send mode when streaming: "steer" (default) or "queue" ──
  var queueMode = "steer";

  // read-write primitives already replaced with state.xxx in body

  // ── Local aliases (core functions — NOT defined in app.js) ──
  var renderMarkdown = core.renderMarkdown;
  var renderBlock = core.renderBlock;
  var renderInline = core.renderInline;
  var patchBlockList = core.patchBlockList;
  var escapeHtml = core.escapeHtml;
  var createMessageEl = core.createMessageEl;
  var createThinkingBlock = core.createThinkingBlock;
  var morphRender = core.morphRender;
  var truncate = core.truncate;
  var debugLogEvent = core.debugLogEvent;
  var debugLogDom = core.debugLogDom;
  var debugDumpChatStructure = core.debugDumpChatStructure;
  var formatTokens = core.formatTokens;
  var renderToolResult = core.renderToolResult;
  var renderFileContent = core.renderFileContent;
  var renderDiffMarkup = core.renderDiffMarkup;
  var formatToolError = core.formatToolError;
  var getLangFromPath = core.getLangFromPath;
  var getCompactReadLabel = core.getCompactReadLabel;
  var registerToolRenderer = core.registerToolRenderer;
  var getToolRenderer = core.getToolRenderer;
  var hideWelcome = core.hideWelcome;
  var resetChat = core.resetChat;
  var scrollToBottom = core.scrollToBottom;
  var updateStreamingState = core.updateStreamingState;
  var renderToolResultTruncated = core.renderToolResultTruncated;
  var renderBlockToHTML = core.renderBlockToHTML;
  var syntaxHighlightLine = core.syntaxHighlightLine;
  var shortenPath = core.shortenPath;
  var renderCodeBlockHTML = core.renderCodeBlockHTML;
  var postProcessMarkedHTML = core.postProcessMarkedHTML;
  var renderTableBlock = core.renderTableBlock;
  var setupCodeBlockHandlers = core.setupCodeBlockHandlers;

  // ── Local aliases (tools functions) ─────────────────────
  var handleToolStart = tools.handleToolStart;
  var handleToolUpdate = tools.handleToolUpdate;
  var handleToolEnd = tools.handleToolEnd;
  var bashToolRenderer = tools.bashToolRenderer;

  // ═══ Message Renderer Registry ════════════════════════════
  //
  // Custom message types (from pi extensions) can register
  // renderers that produce DOM for the live panel.

  var messageRenderers = {};

  function registerMessageRenderer(customType, rendererFn) {
    messageRenderers[customType] = rendererFn;
  }

  function getMessageRenderer(customType) {
    return messageRenderers[customType];
  }

  // Expose for pi extensions to register custom message renderers
  window.__piRegisterMessageRenderer = registerMessageRenderer;

  // Default message renderer: creates a collapsible live-panel card
  function defaultMessageRenderer(data) {
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

    // Live-updating card: replace content in-place
    if (liveCards[customType]) {
      liveCards[customType].querySelector(".live-card-content").innerHTML = renderMarkdown(content);
      liveCards[customType].classList.add("live-card-collapsed");
      liveCards[customType].querySelector(".live-card-content").style.display = "none";
      var exp = liveCards[customType].querySelector(".live-card-expando");
      if (exp) { exp.textContent = "\u25B8"; }
      return;
    }

    var label = customType;
    if (customType === "extension-notify") {
      label = content.split("\n")[0].split("  ")[0].substring(0, 60);
    }
    if (customType === "error") { label = "Error"; }

    return createLiveCard(customType, label, content);
  }

  /** Create a collapsible live-panel card. Returns the card element. */
  function createLiveCard(customType, label, content) {
    var card = document.createElement("div");
    card.className = "live-card live-card-collapsed";
    card.setAttribute("data-type", customType);
    card.innerHTML =
      '<div class="live-card-label"><span class="live-card-expando">\u25B8</span> ' + escapeHtml(label) + '</div>' +
      '<button class="live-card-close" title="Dismiss">&times;</button>' +
      '<div class="live-card-content" style="display:none">' + renderMarkdown(content) + '</div>';
    card.querySelector(".live-card-label").addEventListener("click", function () {
      var wasCollapsed = card.classList.contains("live-card-collapsed");
      if (wasCollapsed) {
        card.classList.remove("live-card-collapsed");
        card.querySelector(".live-card-expando").textContent = "\u25BE";
        card.querySelector(".live-card-content").style.display = "";
      } else {
        card.classList.add("live-card-collapsed");
        card.querySelector(".live-card-expando").textContent = "\u25B8";
        card.querySelector(".live-card-content").style.display = "none";
      }
    });
    card.querySelector(".live-card-close").addEventListener("click", function (e) {
      e.stopPropagation();
      dismissLiveCard(customType);
    });
    livePanel.appendChild(card);
    liveCards[customType] = card;
    livePanel.classList.add("visible");
    return card;
  }

  // ═══ Event Router ═══════════════════════════════════════
  // ═══ Event Router ═══════════════════════════════════════

  window.addEventListener("message", function (event) {
    var msg = event.data;
    // Debug: log every incoming extension message (skip high-frequency stream deltas)
    if (msg.type !== "stream-delta" && msg.type !== "thinking-delta" && msg.type !== "tool-update" && msg.type !== "bash-output") {
      debugLogEvent("recv:" + msg.type, msg.data || msg);
    }
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

      // Slash commands from installed extensions
      case "slash-commands-update": handleSlashCommandsUpdate(msg.data); break;

      // Widget bridge from extensions (setWidget calls)
      case "widget-update":      handleWidgetUpdate(msg.data); break;


    }
  });

  // ═══ Agent Lifecycle ═══════════════════════════════════
  // ═══ Agent Lifecycle ═══════════════════════════════════

  function handleAgentStart() {
    debugLogEvent("agent-start", { bashBlocksN: Object.keys(bashBlocks).length, toolBlocksN: Object.keys(currentToolBlocks).length });
    state.isStreaming = true;
    queueMode = "steer";  // reset to default on new stream
    assistantToolCallIds = {};
    // Do NOT clear the live panel here — extension cards (like tldr summaries)
    // should persist across prompts and be replaced only when new output of
    // the same type arrives, or when the extension explicitly removes them.
    removeWorkingIndicator();
    addWorkingIndicator();
    updateStreamingState();
  }

  function handleAgentEnd() {
    // Stop thinking spinner (safety net)
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) thSpinner.remove();
    }

    debugLogEvent("agent-end:BEFORE", {
      bashBlocksN: Object.keys(bashBlocks).length,
      toolBlocksN: Object.keys(currentToolBlocks).length,
      bashKeys: Object.keys(bashBlocks),
      toolKeys: Object.keys(currentToolBlocks),
    });
    state.isStreaming = false;
    state.isRetrying = false;
    assistantToolCallIds = {};
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();

    // Flush any pending batched stream renders
    _flushStreamRender();

    // If there's a stale streaming component (e.g. aborted without message_end), finalize it
    if (state.currentAssistantEl) {
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          var thinkingBlock = mc.querySelector(".thinking-block");
          if (state._markedAvailable) {
            while (mc.firstChild) { mc.removeChild(mc.firstChild); }
            var tokens = marked.lexer(raw);
            for (var ti = 0; ti < tokens.length; ti++) {
              mc.appendChild(renderBlock(tokens[ti]));
            }
            state._streamPrevTokens = [];
          } else {
            mc.innerHTML = renderMarkdown(raw);
          }
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }
      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }

    // Finalize any pending tool blocks
    Object.keys(currentToolBlocks).forEach(function (id) {
      var entry = currentToolBlocks[id];
      var block = entry.el || entry;
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

    // Also finalize any dangling bash blocks that were never closed
    Object.keys(bashBlocks).forEach(function (id) {
      var block = bashBlocks[id];
      if (block && block.getAttribute && block.getAttribute("data-status") === "running") {
        debugLogEvent("agent-end:ORPHAN-BASH", { toolCallId: id, inDOM: !!block.parentElement });
        block.setAttribute("data-status", "done");
        var footer = block.querySelector(".bash-footer");
        if (footer) { footer.innerHTML = '<span class="exit-code">exit: -</span> <span>(ended)</span>'; }
        delete bashBlocks[id];
        delete bashOutputs[id];
      }
    });

    updateStreamingState();
  }

  // ═══ Turn Lifecycle ════════════════════════════════════
  // ═══ Turn Lifecycle ════════════════════════════════════

  function handleTurnStart(data) {
    hideWelcome();
  }

  function handleTurnEnd(data) {
    if (data && data.message && data.message.role === "assistant" && data.message.errorMessage) {
      if (state.currentAssistantEl) {
        addErrorToElement(state.currentAssistantEl, data.message.errorMessage);
      }
    }
  }

  // ═══ Message Lifecycle ═════════════════════════════════
  // ═══ Message Lifecycle ═════════════════════════════════

  function handleChatMessage(data) {
    // Dedup: skip if same role+content as last user message
    if (data.role === "user" && data.content === state.lastUserMessageContent) return;
    if (data.role === "user") {
      state.lastUserMessageContent = data.content;
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
    if (mc) {
      // Use block rendering for user messages (one-shot, no streaming)
      if (state._markedAvailable) {
        var tokens = marked.lexer(data.content);
        for (var ti = 0; ti < tokens.length; ti++) {
          mc.appendChild(renderBlock(tokens[ti]));
        }
      } else {
        mc.innerHTML = renderMarkdown(data.content);
      }
    }
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  function handleAssistantStart(data) {
    hideWelcome();
    removeWorkingIndicator();

    // Create the assistant container eagerly before any content arrives
    state.currentAssistantEl = createMessageEl("assistant");
    // #9: Entry ID for scroll-to
    if (data.entryId) state.currentAssistantEl.id = "entry-" + data.entryId;
    state.currentThinkingEl = null;
    state._streamPrevTokens = [];  // Reset token tracker for new message
    assistantToolCallIds = {};
    chatContainer.appendChild(state.currentAssistantEl);
    scrollToBottom();
  }

  function handleAssistantEnd(data) {
    // Finalize the assistant message
    if (state.currentAssistantEl) {
      // Flush any pending batched renders before finalizing
      _flushStreamRender();
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        // Final clean render from data-raw using block rendering
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          var thinkingBlock = mc.querySelector(".thinking-block");
          if (state._markedAvailable) {
            while (mc.firstChild) { mc.removeChild(mc.firstChild); }
            var tokens = marked.lexer(raw);
            for (var ti = 0; ti < tokens.length; ti++) {
              mc.appendChild(renderBlock(tokens[ti]));
            }
            state._streamPrevTokens = [];
          } else {
            mc.innerHTML = renderMarkdown(raw);
          }
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }

      // Handle error/abort stop reasons (like TUI)
      if (data && data.stopReason) {
        if (data.stopReason === "aborted") {
          addErrorToElement(state.currentAssistantEl, data.errorMessage || "Operation aborted");
          // Mark any pending tool blocks as errored
          if (data.toolCalls) {
            data.toolCalls.forEach(function (tcId) {
              var entry = currentToolBlocks[tcId];
              var block = entry ? (entry.el || entry) : null;
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
          addErrorToElement(state.currentAssistantEl, data.errorMessage || "Error");
        }
      }

      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }
  }

  // ── rAF-batched stream rendering (token-diff) ────────
  // ── rAF-batched stream rendering (token-diff) ────────
  // Uses marked.lexer() to re-parse on every frame, then diffs
  // the token lists: only the last (in-progress) block is morphed;
  // all prior completed blocks are untouched. This avoids O(n²)
  // full-content re-renders during streaming.
  var _streamRafId = null;
  var _streamContentEl = null;

  function _scheduleStreamRender(contentEl) {
    if (_streamRafId) return;
    _streamContentEl = contentEl;
    _streamRafId = requestAnimationFrame(function () {
      _streamRafId = null;
      if (!_streamContentEl) return;
      var el = _streamContentEl;
      _streamContentEl = null;

      // Save thinking block before patching (it's prepended, not part of blocks)
      var savedThinkingBlock = state.currentThinkingEl || el.querySelector(".thinking-block");
      // Temporarily detach thinking block so patchBlockList only sees token children
      if (savedThinkingBlock && savedThinkingBlock.parentNode === el) {
        el.removeChild(savedThinkingBlock);
      }

      var raw = el.getAttribute("data-raw") || "";
      if (state._markedAvailable) {
        var tokens = marked.lexer(raw);
        patchBlockList(el, state._streamPrevTokens, tokens);
        state._streamPrevTokens = tokens;
      } else {
        morphRender(el, renderMarkdown(raw));
      }

      if (savedThinkingBlock) {
        el.prepend(savedThinkingBlock);
        if (!state.currentThinkingEl) {
          state.currentThinkingEl = savedThinkingBlock;
        }
      }
      el.classList.add("streaming-cursor");
      scrollToBottom();
    });
  }

  /** Flush any pending rAF render immediately (called before finalize). */
  function _flushStreamRender() {
    // Flush thinking text first so it's visible in the final render
    _flushThinkingRender();
    if (_streamRafId) {
      cancelAnimationFrame(_streamRafId);
      _streamRafId = null;
      if (_streamContentEl) {
        var el = _streamContentEl;
        _streamContentEl = null;

        var savedThinkingBlock = state.currentThinkingEl || el.querySelector(".thinking-block");
        // Temporarily detach thinking block so patchBlockList only sees token children
        if (savedThinkingBlock && savedThinkingBlock.parentNode === el) {
          el.removeChild(savedThinkingBlock);
        }
        var raw = el.getAttribute("data-raw") || "";
        if (state._markedAvailable) {
          var tokens = marked.lexer(raw);
          patchBlockList(el, state._streamPrevTokens, tokens);
          state._streamPrevTokens = tokens;
        } else {
          morphRender(el, renderMarkdown(raw));
        }

        if (savedThinkingBlock) {
          el.prepend(savedThinkingBlock);
          if (!state.currentThinkingEl) {
            state.currentThinkingEl = savedThinkingBlock;
          }
        }
        el.classList.add("streaming-cursor");
      }
    }
  }

  function handleStreamDelta(data) {
    hideWelcome();
    if (!state.currentAssistantEl) {
      // Safety: create container if assistant-start was missed
      state.currentAssistantEl = createMessageEl("assistant");
      state.currentThinkingEl = null;
      state._streamPrevTokens = [];
      chatContainer.appendChild(state.currentAssistantEl);
    }
    var contentEl = state.currentAssistantEl.querySelector(".message-content");
    if (contentEl) {
      // Accumulate delta into data-raw (the source of truth)
      var raw = contentEl.getAttribute("data-raw") || "";
      raw += data.delta;
      contentEl.setAttribute("data-raw", raw);

      // Schedule a single render per animation frame
      _scheduleStreamRender(contentEl);
    }
    scrollToBottom();
  }

  // ── rAF-batched thinking delta ───────────────────────
  // ── rAF-batched thinking delta ───────────────────────
  // Uses textContent (no HTML parse) for efficiency, batched
  // per animation frame like stream deltas.
  var _thinkingRafId = null;
  var _thinkingEl = null;   // the .thinking-content element

  function _scheduleThinkingRender(tc) {
    if (_thinkingRafId) return;
    _thinkingEl = tc;
    _thinkingRafId = requestAnimationFrame(function () {
      _thinkingRafId = null;
      if (!_thinkingEl) return;
      var el = _thinkingEl;
      _thinkingEl = null;
      // Flush accumulated text via textContent (avoids HTML parse)
      var raw = el.getAttribute("data-raw") || "";
      el.textContent = raw;
      // Update line count and expand button
      var block = el.closest(".thinking-block");
      if (block) {
        var lineCount = block.querySelector(".thinking-line-count");
        var lines = raw ? raw.split("\n").length : 0;
        if (lineCount) lineCount.textContent = lines > 0 ? "(" + lines + " lines)" : "";
        // Toggle gradient overlay when content overflows
        if (el.scrollHeight > el.clientHeight + 2) {
          el.classList.add("overflowing");
        } else {
          el.classList.remove("overflowing");
        }
        // Show expand button ONLY when content overflows the visible area
        var btn = block.querySelector(".thinking-expand-btn");
        if (btn && lines > 0) {
          var overflowing = el.scrollHeight > el.clientHeight + 2;
          if (block.classList.contains("thinking-collapsed")) {
            btn.style.display = overflowing ? "" : "none";
            btn.textContent = "Show more";
          } else {
            btn.style.display = "";
            btn.textContent = "Show less";
          }
        }
        // Auto-scroll to bottom of content area
        el.scrollTop = el.scrollHeight;
      }
      scrollToBottom();
    });
  }

  function _flushThinkingRender() {
    if (_thinkingRafId) {
      cancelAnimationFrame(_thinkingRafId);
      _thinkingRafId = null;
      if (_thinkingEl) {
        var el = _thinkingEl;
        _thinkingEl = null;
        var raw = el.getAttribute("data-raw") || "";
        el.textContent = raw;
      }
    }
  }

  function handleThinkingDelta(data) {
    if (data.done) {
      _flushThinkingRender();
      // Remove spinner when thinking completes, finalize expand button
      if (state.currentThinkingEl) {
        var spinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (spinner) spinner.remove();
        var block = state.currentThinkingEl;
        var contentEl = block.querySelector(".thinking-content");
        var btn = block.querySelector(".thinking-expand-btn");
        if (btn && contentEl) {
          var overflowing = contentEl.scrollHeight > contentEl.clientHeight + 2;
          if (overflowing) {
            contentEl.classList.add("overflowing");
          }
          if (block.classList.contains("thinking-collapsed")) {
            btn.style.display = overflowing ? "" : "none";
            btn.textContent = "Show more";
          } else {
            btn.style.display = "";
            btn.textContent = "Show less";
          }
        }
      }
      return;
    }
    if (!state.currentThinkingEl) {
      state.currentThinkingEl = createThinkingBlock("");
      if (state.currentAssistantEl) {
        var mc = state.currentAssistantEl.querySelector(".message-content");
        if (mc) mc.prepend(state.currentThinkingEl);
      }
    }
    var tc = state.currentThinkingEl.querySelector(".thinking-content");
    if (tc) {
      // Accumulate into data-raw, render once per frame via textContent
      var raw = tc.getAttribute("data-raw") || "";
      raw += data.delta;
      tc.setAttribute("data-raw", raw);
      _scheduleThinkingRender(tc);
    }
    scrollToBottom();
  }

  // ═══ Session Events ════════════════════════════════════

  function handleStatusUpdate(data) {
    if (data.reset) return;
    // Status bar info now shown via VS Code native status bar (extension.ts)
  }

  function handleStatus(data) {
    if (data.ready) {
      promptInput.disabled = false;
      sendButton.disabled = false;
      promptInput.placeholder = "Ask pi to do something...";
      promptInput.focus();
    } else if (data.model === "not installed" || data.model === "init failed") {
      promptInput.disabled = true;
      sendButton.disabled = true;
    }
  }

  function handleQueueUpdate(data) {
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

    var html = "";

    // Steering messages — already interrupting, show with label
    steering.forEach(function (m) {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">' +
        '<span style="font-weight:600;">Steer:</span> ' +
        '<span style="flex:1;">' + escapeHtml(m) + '</span></div>';
    });

    // Follow-up messages — queued, with promote button
    followUp.forEach(function (m, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">' +
        '<span style="font-weight:600;">Queue:</span> ' +
        '<span style="flex:1;">' + escapeHtml(m) + '</span>' +
        '<button class="queue-promote-btn" data-idx="' + i + '" title="Promote to Steer (interrupt now)" style="font-size:0.75em;padding:1px 6px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;">Steer now</button>' +
        '</div>';
    });

    // Clear all button — always show when there are items
    html += '<div style="margin-top:6px;text-align:right;">' +
      '<button class="queue-clear-btn" style="font-size:0.8em;padding:3px 12px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;">✕ Clear all queued</button>' +
      '</div>';

    el.innerHTML = html;

    // Wire promote buttons
    el.querySelectorAll(".queue-promote-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-idx"), 10);
        var msg = (data.followUp || [])[idx];
        if (msg) {
          // Promote: clear all queues, then re-steer this message
          vscode.postMessage({ type: "promoteToSteer", text: msg });
        }
      });
    });

    // Wire clear button
    var clearBtn = el.querySelector(".queue-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        vscode.postMessage({ type: "clearQueue" });
      });
    }

    var inputArea = document.getElementById("input-area");
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(el, inputArea);
    }
  }

  function handleCompactionStart(data) {
    state.isCompacting = true;
    removeCompactionIndicator();
    addCompactionIndicator(data.reason === "manual" ? "Compacting..." : "Auto-compacting...");
    updateStreamingState();
  }

  function handleCompactionEnd(data) {
    state.isCompacting = false;
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
    state.isRetrying = true;
    removeRetryIndicator();
    addRetryIndicator(data.attempt, data.maxAttempts, data.delayMs);
    updateStreamingState();
  }

  function handleAutoRetryEnd(data) {
    state.isRetrying = false;
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
    state.isStreaming = false;
    if (state.currentAssistantEl) {
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) mc.classList.remove("streaming-cursor");
      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }
    updateStreamingState();
    scrollToBottom();
  }

  // ═══ UI Helpers — Indicators ═══════════════════════════
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
      help = '<small>Run <code>npm install -g @earendil-works/pi-coding-agent</code> in a terminal, then reload VS Code.</small>';
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
    state.hasScrolledUp = false;

    // Intercept local slash commands before sending to LLM
    if (text && localSlashCommands.indexOf(text) !== -1) {
      var cmd = text.slice(1); // strip leading "/"

      // /debug: dump webview state as a structured message in chat, plus
      // log to console so it can be inspected from DevTools without copy-paste.
      if (cmd === "debug") {
        handleDebugCommand();
        promptInput.value = "";
        promptInput.style.height = "auto";
        promptInput.style.overflowY = "hidden";
        clearAttachments();
        return;
      }

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
      mode: state.isStreaming ? queueMode : undefined,
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

  // Steer dropdown — toggles between Steer and Queue mode
  steerDropdown.addEventListener("click", function () {
    queueMode = queueMode === "steer" ? "queue" : "steer";
    if (queueMode === "queue") {
      sendButton.textContent = "Queue";
      sendButton.title = "Queue (process after current turn)";
      steerDropdown.title = "Switch to Steer";
    } else {
      sendButton.textContent = "Steer";
      sendButton.title = "Steer (interrupt current request)";
      steerDropdown.title = "Switch to Queue";
    }
  });

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
    if (state.settingsOpen && !settingsOverlay.contains(target)) {
      closeAllOverlays();
    }
    if (state.userMsgSelectorOpen && !userMsgOverlay.contains(target) && target !== promptInput) {
      closeAllOverlays();
    }
    if (state.slashAutocompleteOpen && !slashAutocomplete.contains(target) && target !== promptInput) {
      closeAllOverlays();
    }
  });

  promptInput.addEventListener("keydown", function (e) {
    // #8: Tab to accept slash autocomplete
    if (state.slashAutocompleteOpen && e.key === "Tab") {
      e.preventDefault();
      var sel = slashAutocomplete.querySelector(".slash-item.selected");
      if (sel) {
        promptInput.value = sel.getAttribute("data-cmd") + " ";
        promptInput.focus();
      }
      slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    // #8: Arrow keys in slash autocomplete
    if (state.slashAutocompleteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.key === "ArrowDown") state.slashSelectedIdx++;
      else state.slashSelectedIdx = Math.max(0, state.slashSelectedIdx - 1);
      updateSlashAutocomplete(state.slashFilter);
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
      if (state.slashAutocompleteOpen || state.settingsOpen || state.userMsgSelectorOpen) {
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
      state.slashFilter = val;
      state.slashSelectedIdx = 0;
      updateSlashAutocomplete(val);
    } else {
      slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
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
    state.userMsgSelectorOpen = true;
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
    state.userMsgSelectorOpen = false;
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
    if (!settingsOverlay || !state.settingsOpen) return;
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
    if (state.settingsOpen) {
      closeAllOverlays();
    } else {
      closeAllOverlays();
      state.settingsOpen = true;
      settingsOverlay.classList.add("visible");
      vscode.postMessage({ type: "getSettings" });
    }
  }

  function closeAllOverlays() {
    state.settingsOpen = false;
    state.userMsgSelectorOpen = false;
    state.slashAutocompleteOpen = false;
    settingsOverlay.classList.remove("visible");
    userMsgOverlay.classList.remove("visible");
    slashAutocomplete.classList.remove("visible");
  }

  // ═══ #5: Diff Rendering for edit tool results ════════════
  // ═══ #7: Custom Message Rendering ═════════════════════════

  function handleCustomMessage(data) {
    hideWelcome();
    var customType = data.customType || "custom";

    // "info" type: render as in-chat status message (for slash command feedback)
    if (customType === "info") {
      var infoContent = "";
      if (typeof data.content === "string") {
        infoContent = data.content;
      } else if (Array.isArray(data.content)) {
        infoContent = data.content.filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n");
      }
      if (infoContent) {
        var infoEl = document.createElement("div");
        infoEl.className = "message assistant";
        infoEl.innerHTML = '<div class="message-content" style="color: var(--vscode-descriptionForeground);">' + escapeHtml(infoContent) + '</div>';
        chatContainer.appendChild(infoEl);
        scrollToBottom();
      }
      return;
    }

    // Try the registry first — extensions can register custom renderers
    var renderer = getMessageRenderer(customType);
    if (renderer) {
      renderer(data, livePanel, liveCards, createLiveCard, dismissLiveCard);
      return;
    }

    // Fall back to the default live-card renderer
    defaultMessageRenderer(data);
  }

  function dismissLiveCard(key) {
    var card = liveCards[key];
    if (card) {
      card.remove();
      delete liveCards[key];
    }
    var widgetCard = widgetCards[key];
    if (widgetCard) {
      widgetCard.remove();
      delete widgetCards[key];
    }
    // Hide panel if empty
    var remaining = livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      livePanel.classList.remove("visible");
    }
  }

  function clearLivePanel() {
    // Only clear transient cards (non-widget cards).
    // Widget cards persist until the extension explicitly clears them.
    var toRemove = [];
    for (var key in liveCards) {
      if (liveCards.hasOwnProperty(key)) {
        var card = liveCards[key];
        if (card && card.getAttribute("data-widget") !== "true") {
          toRemove.push(key);
        }
      }
    }
    for (var i = 0; i < toRemove.length; i++) {
      var c = liveCards[toRemove[i]];
      if (c) c.remove();
      delete liveCards[toRemove[i]];
    }
    // Hide the panel if nothing remains
    var remaining = livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      livePanel.classList.remove("visible");
    }
  }

  // ── Widget Bridge ─────────────────────────────────────
  // ── Widget Bridge ─────────────────────────────────────

  var widgetCards = {};  // widget key -> DOM element

  function handleWidgetUpdate(data) {
    if (!data || !data.key) return;

    var key = data.key;
    var content = data.content;

    if (content === null || content === undefined) {
      // Remove widget card
      var existing = widgetCards[key];
      if (existing) {
        existing.remove();
        delete widgetCards[key];
      }
      // Also remove from liveCards
      delete liveCards[key];
      // Hide panel if empty
      var remaining = livePanel.querySelectorAll(".live-card");
      if (remaining.length === 0) {
        livePanel.classList.remove("visible");
      }
      return;
    }

    // Create or update widget card
    var card = widgetCards[key];
    if (card) {
      card.querySelector(".live-card-content").innerHTML = renderMarkdown(content);
    } else {
      card = document.createElement("div");
      card.className = "live-card";
      card.setAttribute("data-widget", "true");
      card.setAttribute("data-type", key);
      card.innerHTML =
        '<div class="live-card-label">' + escapeHtml(key) + '</div>' +
        '<button class="live-card-close" title="Dismiss">&times;</button>' +
        '<div class="live-card-content">' + renderMarkdown(content) + '</div>';
      card.querySelector(".live-card-close").addEventListener("click", function () {
        dismissLiveCard(key);
      });
      livePanel.appendChild(card);
      widgetCards[key] = card;
      liveCards[key] = card;
    }
    livePanel.classList.add("visible");
  }

  function clearWidgetCards() {
    for (var key in widgetCards) {
      if (widgetCards.hasOwnProperty(key)) {
        widgetCards[key].remove();
      }
    }
    widgetCards = {};
  }

  // ═══ #8: Slash Command Autocomplete ═══════════════════════
  // ═══ #8: Slash Command Autocomplete ═══════════════════════

  // Built-in slash commands (always available)
  var builtinSlashCommands = [
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
  ];

  // Dynamic slash commands populated from installed extensions (e.g. /tldr)
  var extensionSlashCommands = [];

  // Full slash command list (builtins + extensions, with extensions first for dedup)
  function getSlashCommands() {
    var all = [];
    var seen = {};
    // Extensions come first so they take precedence
    extensionSlashCommands.forEach(function (sc) {
      seen[sc.cmd] = true;
      all.push(sc);
    });
    builtinSlashCommands.forEach(function (sc) {
      if (!seen[sc.cmd]) {
        all.push(sc);
      }
    });
    return all;
  }

  // Slash commands that should be handled locally (not sent to LLM)
  var localSlashCommands = ["/login", "/logout", "/debug", "/model", "/thinking", "/sessions", "/settings"];

  function handleSlashCommandsUpdate(data) {
    if (data && data.commands && Array.isArray(data.commands)) {
      extensionSlashCommands = data.commands;
      // Re-filter autocomplete if it's currently open
      if (state.slashAutocompleteOpen) {
        updateSlashAutocomplete(state.slashFilter);
      }
    }
  }

  function updateSlashAutocomplete(filter) {
    if (!filter || filter.length === 0) {
      slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    var f = filter.toLowerCase();
    var matches = getSlashCommands().filter(function (sc) { return sc.cmd.toLowerCase().indexOf(f) === 0; });
    if (matches.length === 0) {
      slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    slashAutocomplete.classList.add("visible");
    state.slashAutocompleteOpen = true;
    state.slashSelectedIdx = Math.min(state.slashSelectedIdx, matches.length - 1);

    var html = "";
    for (var i = 0; i < matches.length; i++) {
      var sc = matches[i];
      html +=
        '<div class="slash-item' + (i === state.slashSelectedIdx ? " selected" : "") + '" data-index="' + i + '" data-cmd="' + escapeHtml(sc.cmd) + '">' +
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
        state.slashAutocompleteOpen = false;
      });
    });
  }

  // ═══ #9: Scroll-to-entry ═══════════════════════════════════
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

    if (!el) return;

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
  }

  // ═══ #10: Bash Execution Blocks ════════════════════════════
  // ═══ #10: Bash Execution Blocks ════════════════════════════
  //
  // These dedicated bash handlers exist for backward compatibility
  // with the extension host's bash-* event stream.  They delegate
  // to the bash tool renderer registered in the tool renderer registry.

  function handleBashStart(data) {
    // Stop thinking spinner — bash execution means thinking is done
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) thSpinner.remove();
    }

    var callId = data.toolCallId;

    // DEDUP: If tool-start already created a block for this callId, don't create a second.
    if (currentToolBlocks[callId]) {
      var entry = currentToolBlocks[callId];
      bashBlocks[callId] = entry.el || entry;
      bashOutputs[callId] = bashOutputs[callId] || "";
      return;
    }
    if (bashBlocks[callId]) return;

    var block = bashToolRenderer.create({
      toolName: "bash",
      toolCallId: callId,
      args: { command: data.command || "" },
      entryId: data.entryId,
      fromMessage: false,
    });
    chatContainer.appendChild(block);
    bashBlocks[callId] = block;
    bashOutputs[callId] = "";
    chatContainer.scrollTop = chatContainer.scrollHeight;
    scrollToBottom();
  }

  function handleBashOutput(data) {
    var callId = data.toolCallId;
    var block = bashBlocks[callId];
    if (!block) {
      var entry = currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      if (!block) return;
    }
    bashOutputs[callId] = (bashOutputs[callId] || "") + (data.output || "");
    var outEl = block.querySelector(".bash-output");
    if (outEl) morphRender(outEl, escapeHtml(bashOutputs[callId]));
    scrollToBottom();
  }

  function handleBashEnd(data) {
    var callId = data.toolCallId;
    var block = bashBlocks[callId];
    if (!block) {
      var entry = currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      if (!block) return;
    }
    var result = {
      content: data.output ? [{ type: "text", text: data.output }] : [],
      details: { exitCode: data.exitCode, cancelled: data.cancelled },
    };
    bashToolRenderer.finalize(block, result, data.isError, data.entryId);
    delete currentToolBlocks[callId];
    delete bashBlocks[callId];
    delete bashOutputs[callId];
    scrollToBottom();
  }

  // ═══ /debug command ═════════════════════════════════════
  // ═══ /debug command ═════════════════════════════════════
  //
  // Renders the current webview state as a collapsible message in chat.
  // No copy-paste needed — it appears inline with:
  //   • Chat DOM structure summary (tags, IDs, statuses — no text content)
  //   • Bash block tracker state
  //   • Tool block tracker state
  //   • Last 20 events received
  //   • Last 20 DOM mutations
  //   • Duplicate / orphan analysis
  //
  // Also dumps the same data to console.log for DevTools inspection.

  function handleDebugCommand() {
    hideWelcome();
    var summary = window.__piDebug.summary();

    // Also log to console so DevTools users can inspect without copy-paste
    console.log("[pi-debug] === Webview State Dump ===");
    console.log("[pi-debug] Chat structure:", JSON.stringify(summary.chat, null, 2));
    console.log("[pi-debug] Dupes (in both trackers):", summary.dupes);
    console.log("[pi-debug] Orphan bashBlocks:", summary.orphanBash);
    console.log("[pi-debug] Orphan toolBlocks:", summary.orphanTool);
    console.log("[pi-debug] Last events:", JSON.stringify(summary.lastEvents, null, 2));
    console.log("[pi-debug] Last DOM changes:", JSON.stringify(summary.lastDomChanges, null, 2));
    console.log("[pi-debug] Full event log (-100):", JSON.stringify(debugEventLog.slice(-100), null, 2));

    var el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content">' +
      '<details class="thinking-block" open>' +
      '<summary>🔍 Debug: Webview State</summary>' +
      '<div style="font-family:var(--vscode-editor-font-family);font-size:0.85em;line-height:1.5;max-height:500px;overflow-y:auto;">' +

      '<h4 style="margin:8px 0 4px">Chat Container</h4>' +
      '<pre style="white-space:pre-wrap;font-size:0.8em;margin:0;">' +
      escapeHtml(JSON.stringify(summary.chat, null, 2)) +
      '</pre>' +

      '<h4 style="margin:12px 0 4px">Tracker State</h4>' +
      '<pre style="white-space:pre-wrap;font-size:0.8em;margin:0;">' +
      'bashBlocks: ' + JSON.stringify(Object.keys(bashBlocks)) + '\n' +
      'currentToolBlocks: ' + JSON.stringify(Object.keys(currentToolBlocks)) + '\n' +
      'bashOutputs: ' + JSON.stringify(Object.keys(bashOutputs)) + '\n' +
      'Duplicates: ' + JSON.stringify(summary.dupes) + '\n' +
      'Orphan bash: ' + JSON.stringify(summary.orphanBash) + '\n' +
      'Orphan tool: ' + JSON.stringify(summary.orphanTool) +
      '</pre>' +

      '<h4 style="margin:12px 0 4px">Last 20 Events</h4>' +
      '<pre style="white-space:pre-wrap;font-size:0.8em;margin:0;max-height:200px;overflow-y:auto;">' +
      escapeHtml(JSON.stringify(summary.lastEvents, null, 2)) +
      '</pre>' +

      '<h4 style="margin:12px 0 4px">Last 20 DOM Mutations</h4>' +
      '<pre style="white-space:pre-wrap;font-size:0.8em;margin:0;max-height:200px;overflow-y:auto;">' +
      escapeHtml(JSON.stringify(summary.lastDomChanges, null, 2)) +
      '</pre>' +

      '<p style="margin-top:8px;color:var(--vscode-descriptionForeground);font-size:0.8em;">' +
      'Tip: <code>window.__piDebug.summary()</code> in DevTools, or <code>/debug</code> again.' +
      '</p>' +

      '</div>' +
      '</details>' +
      '</div>';
    chatContainer.appendChild(el);
    scrollToBottom();
  }

  // ── Export app handlers ──────────────────────────────────
  app.handleAgentStart = typeof handleAgentStart !== "undefined" ? handleAgentStart : null;
  app.handleAgentEnd = typeof handleAgentEnd !== "undefined" ? handleAgentEnd : null;
  app.handleTurnStart = typeof handleTurnStart !== "undefined" ? handleTurnStart : null;
  app.handleTurnEnd = typeof handleTurnEnd !== "undefined" ? handleTurnEnd : null;
  app.handleChatMessage = typeof handleChatMessage !== "undefined" ? handleChatMessage : null;
  app.handleAssistantStart = typeof handleAssistantStart !== "undefined" ? handleAssistantStart : null;
  app.handleAssistantEnd = typeof handleAssistantEnd !== "undefined" ? handleAssistantEnd : null;
  app.handleStreamDelta = typeof handleStreamDelta !== "undefined" ? handleStreamDelta : null;
  app.handleThinkingDelta = typeof handleThinkingDelta !== "undefined" ? handleThinkingDelta : null;
  app.handleStatusUpdate = typeof handleStatusUpdate !== "undefined" ? handleStatusUpdate : null;
  app.handleStatus = typeof handleStatus !== "undefined" ? handleStatus : null;
  app.handleQueueUpdate = typeof handleQueueUpdate !== "undefined" ? handleQueueUpdate : null;
  app.handleCompactionStart = typeof handleCompactionStart !== "undefined" ? handleCompactionStart : null;
  app.handleCompactionEnd = typeof handleCompactionEnd !== "undefined" ? handleCompactionEnd : null;
  app.handleAutoRetryStart = typeof handleAutoRetryStart !== "undefined" ? handleAutoRetryStart : null;
  app.handleAutoRetryEnd = typeof handleAutoRetryEnd !== "undefined" ? handleAutoRetryEnd : null;
  app.handleThinkingLevelChanged = typeof handleThinkingLevelChanged !== "undefined" ? handleThinkingLevelChanged : null;
  app.handleCompactionSummaryMessage = typeof handleCompactionSummaryMessage !== "undefined" ? handleCompactionSummaryMessage : null;
  app.handleCustomMessage = typeof handleCustomMessage !== "undefined" ? handleCustomMessage : null;
  app.handleUserMessagesList = typeof handleUserMessagesList !== "undefined" ? handleUserMessagesList : null;
  app.handleScopedModelsUpdate = typeof handleScopedModelsUpdate !== "undefined" ? handleScopedModelsUpdate : null;
  app.handleSettingsUpdate = typeof handleSettingsUpdate !== "undefined" ? handleSettingsUpdate : null;
  app.handleRevealEntry = typeof handleRevealEntry !== "undefined" ? handleRevealEntry : null;
  app.handleError = typeof handleError !== "undefined" ? handleError : null;
  app.handleInsertCommand = typeof handleInsertCommand !== "undefined" ? handleInsertCommand : null;
  app.handleSlashCommandsUpdate = typeof handleSlashCommandsUpdate !== "undefined" ? handleSlashCommandsUpdate : null;
  app.handleWidgetUpdate = typeof handleWidgetUpdate !== "undefined" ? handleWidgetUpdate : null;

})();
