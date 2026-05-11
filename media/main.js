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
  var attachments = [];                // { id, type, name, mediaType, data, blobUrl }

  // DOM refs
  var chatContainer = document.getElementById("chat-container");
  var promptInput = document.getElementById("prompt-input");
  var sendButton = document.getElementById("send-button");
  var abortButton = document.getElementById("abort-button");
  var welcome = document.getElementById("welcome");
  var attachmentBar = document.getElementById("attachment-bar");
  var userMsgOverlay = document.getElementById("user-msg-overlay");
  var settingsOverlay = document.getElementById("settings-overlay");
  var slashAutocomplete = document.getElementById("slash-autocomplete");
  var livePanel = document.getElementById("live-panel");
  var liveCards = {};  // customType -> DOM element, updated in-place

  // Bash execution blocks (#10)
  var bashBlocks = {};             // toolCallId -> bash block element
  var bashOutputs = {};            // toolCallId -> accumulated output string

  // ═══ Debug Infrastructure ══════════════════════════════
  //
  // Tracks every inbound message, DOM mutations, and internal state
  // so we can answer "why did a block disappear?" without copy-pasting
  // massive DOM trees.  See also: window.__piDebug, /debug slash command.

  var debugEventLog = [];          // [{ ts, type, dataKeys, callId, stackDepth }]
  var debugMaxEvents = 500;        // circular buffer cap
  var debugDomLog = [];            // [{ ts, action, elInfo }]
  var debugMaxDomLog = 200;
  var debugEnabled = true;         // toggle via /debug on|off

  function debugLogEvent(type, data) {
    if (!debugEnabled) return;
    var entry = {
      ts: Date.now(),
      type: type,
      dataKeys: data ? Object.keys(data).slice(0, 10) : [],
      callId: data ? (data.toolCallId || data.entryId || "") : "",
      // Capture key identifiers for bash/tool dedup analysis
      id: data ? (data.entryId || data.toolCallId || "") : "",
      fromMessage: data ? !!data.fromMessage : false,
      toolName: data ? (data.toolName || "") : "",
      stackDepth: new Error().stack ? new Error().stack.split("\n").length : 0,
    };
    debugEventLog.push(entry);
    if (debugEventLog.length > debugMaxEvents) debugEventLog.shift();
  }

  function debugLogDom(action, el) {
    if (!debugEnabled || !el || !el.tagName) return;
    var entry = {
      ts: Date.now(),
      action: action,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: el.className || "",
      status: el.getAttribute ? el.getAttribute("data-status") : "",
      text: (el.textContent || "").slice(0, 80),
      parentId: el.parentElement ? (el.parentElement.id || el.parentElement.className) : "",
    };
    debugDomLog.push(entry);
    if (debugDomLog.length > debugMaxDomLog) debugDomLog.shift();
  }

  // Snapshot all children of chatContainer (just tag/id/status — no text content)
  function debugDumpChatStructure() {
    var children = [];
    for (var i = 0; i < chatContainer.children.length; i++) {
      var c = chatContainer.children[i];
      // For bash-execution blocks, capture the inner structure too
      var bashDetail = null;
      if (c.className && c.className.indexOf("bash-execution") !== -1) {
        var header = c.querySelector(".bash-header");
        var output = c.querySelector(".bash-output");
        var footer = c.querySelector(".bash-footer");
        bashDetail = {
          headerText: header ? header.textContent.slice(0, 120) : "MISSING",
          outputLen: output ? output.innerHTML.length : -1,
          outputText: output ? output.textContent.slice(0, 200) : "MISSING",
          footerText: footer ? footer.textContent : "MISSING",
          offsetHeight: c.offsetHeight,
          computedDisplay: c.style.display || (typeof getComputedStyle !== "undefined" ? getComputedStyle(c).display : "?"),
          computedVisibility: typeof getComputedStyle !== "undefined" ? getComputedStyle(c).visibility : "?",
        };
      }
      children.push({
        idx: i,
        tag: c.tagName.toLowerCase(),
        id: c.id || "",
        classes: c.className || "",
        status: c.getAttribute ? c.getAttribute("data-status") : "",
        childCount: c.children.length,
        bashDetail: bashDetail,
      });
    }
    return {
      totalChildren: chatContainer.children.length,
      children: children,
      bashBlocksKeys: Object.keys(bashBlocks),
      currentToolBlocksKeys: Object.keys(currentToolBlocks),
      trackers: {
        bashBlocksCount: Object.keys(bashBlocks).length,
        currentToolBlocksCount: Object.keys(currentToolBlocks).length,
        bashOutputsCount: Object.keys(bashOutputs).length,
      },
    };
  }

  // Expose structured debug API (no DOM copy-paste needed)
  window.__piDebug = {
    enabled: function (on) { debugEnabled = on; return debugEnabled; },
    dumpState: debugDumpChatStructure,
    eventLog: function (n) { return debugEventLog.slice(-(n || 50)); },
    domLog: function (n) { return debugDomLog.slice(-(n || 50)); },
    bashBlocks: function () { return Object.keys(bashBlocks).map(function (k) { return { id: k, status: bashBlocks[k].getAttribute ? bashBlocks[k].getAttribute("data-status") : "?", tag: bashBlocks[k].tagName }; }); },
    toolBlocks: function () { return Object.keys(currentToolBlocks).map(function (k) { var e = currentToolBlocks[k]; var el = e.el || e; return { id: k, status: el.getAttribute ? el.getAttribute("data-status") : "?", tag: el.tagName, hasRenderer: !!e.renderer }; }); },
    summary: function () {
      var s = debugDumpChatStructure();
      var el = debugEventLog.slice(-30);
      var dl = debugDomLog.slice(-30);
      // Correlate: find ids that appear in both bashBlocks and currentToolBlocks (duplicates)
      var bKeys = new Set(Object.keys(bashBlocks));
      var tKeys = new Set(Object.keys(currentToolBlocks));
      var dupes = [];
      bKeys.forEach(function (k) { if (tKeys.has(k)) dupes.push(k); });
      var orphanBash = [];
      bKeys.forEach(function (k) { if (!tKeys.has(k)) orphanBash.push(k); });
      var orphanTool = [];
      tKeys.forEach(function (k) { if (!bKeys.has(k)) orphanTool.push(k); });
      return {
        chat: s,
        dupes: dupes,
        orphanBash: orphanBash,
        orphanTool: orphanTool,
        lastEvents: el,
        lastDomChanges: dl,
      };
    },
  };

  // MutationObserver: track additions/removals from chatContainer in real time
  if (typeof MutationObserver !== "undefined") {
    var debugObserver = new MutationObserver(function (mutations) {
      if (!debugEnabled) return;
      mutations.forEach(function (m) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          debugLogDom("added", m.addedNodes[i]);
        }
        for (var j = 0; j < m.removedNodes.length; j++) {
          debugLogDom("removed", m.removedNodes[j]);
        }
      });
    });
    debugObserver.observe(chatContainer, { childList: true });
  }

  // ═══ End Debug Infrastructure ═══════════════════════════

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

  // ═══ Tool Renderer Registry ════════════════════════════════
  //
  // Each tool renderer handles its own create → update → finalize
  // lifecycle.  The event router delegates to the registry instead
  // of switching on toolName inline.  Pi extensions can register
  // custom tool renderers via window.__piRegisterToolRenderer.

  /**
   * A tool renderer knows how to create, update, and finalize a tool block.
   *
   *   create(data)          → HTMLElement  (called on tool-start)
   *   update(el, partial)   → void         (called on tool-update, streaming output)
   *   finalize(el, result)  → void         (called on tool-end)
   *
   * `data` shape: { toolName, toolCallId, args, entryId, fromMessage }
   * `result` shape: { content, details, isError }
   */

  var toolRenderers = {};

  function registerToolRenderer(toolName, renderer) {
    toolRenderers[toolName] = renderer;
  }

  function getToolRenderer(toolName) {
    return toolRenderers[toolName] || defaultToolRenderer;
  }

  // Expose for pi extensions to register custom tool renderers
  window.__piRegisterToolRenderer = registerToolRenderer;

  // ── Default (generic) tool renderer ──────────────────────

  var defaultToolRenderer = {
    create: function (data) {
      return createToolBlock(data.toolName, data.toolCallId, "pending", data.args);
    },
    update: function (el, partialResult) {
      var tr = el.querySelector(".tool-result");
      if (!tr || !partialResult || !partialResult.content) return;
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) return;
      var lines = text.split("\n");
      var displayText = lines.length > 60 ? "...\n" + lines.slice(-60).join("\n") : text;
      tr.innerHTML = renderToolResult(displayText);
    },
    finalize: function (el, result, isError, entryId) {
      var statusEl = el.querySelector(".tool-status");
      if (statusEl) {
        statusEl.textContent = isError ? "error" : "done";
        statusEl.className = "tool-status " + (isError ? "error" : "success");
      }
      el.setAttribute("data-status", isError ? "error" : "done");
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }
      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
      }
      var tr = el.querySelector(".tool-result");
      if (tr) {
        var lines = text.split("\n");
        tr.innerHTML = lines.length > 50 ? renderToolResultTruncated(text) : renderToolResult(text);
      }
    },
  };

  // ── Bash tool renderer ───────────────────────────────────

  var bashToolRenderer = {
    create: function (data) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "bash-execution";
      block.id = data.entryId ? "entry-" + data.entryId : "bash-" + data.toolCallId;
      block.setAttribute("data-status", "running");
      var cmd = data.args && data.args.command ? data.args.command : "";
      if (cmd.length > 120) cmd = cmd.slice(0, 120) + "\u2026";
      block.innerHTML =
        '<div class="bash-header">$ ' + escapeHtml(cmd) + '</div>' +
        '<div class="bash-output"></div>' +
        '<div class="bash-footer"><span class="cancel-hint">running\u2026</span></div>';
      bashBlocks[data.toolCallId] = block;
      bashOutputs[data.toolCallId] = "";
      return block;
    },
    update: function (el, partialResult) {
      // Only accumulate from bash-output events, not from tool-update.
      // tool-update events contain JSON-serialized args that would
      // leak noise ({}{}{}{}) into the output div.
      // Output is handled exclusively by handleBashOutput.
    },
    finalize: function (el, result, isError, entryId) {
      var toolCallId = el.id.replace(/^(entry-|bash-)/, "");
      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
      }
      var outEl = el.querySelector(".bash-output");
      if (outEl && text) outEl.innerHTML = escapeHtml(text);
      var footer = el.querySelector(".bash-footer");
      var details = result && result.details ? result.details : {};
      var exitCode = details.exitCode != null ? details.exitCode : 0;
      if (footer) {
        footer.innerHTML =
          '<span class="exit-code' + (isError ? " error" : "") + '">exit: ' + exitCode + '</span>' +
          (details.cancelled ? ' <span>(cancelled)</span>' : "");
      }
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }
      el.setAttribute("data-status", isError ? "error" : "complete");
      delete bashBlocks[toolCallId];
      delete bashOutputs[toolCallId];
    },
  };

  registerToolRenderer("bash", bashToolRenderer);

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

  function handleAgentStart() {
    debugLogEvent("agent-start", { bashBlocksN: Object.keys(bashBlocks).length, toolBlocksN: Object.keys(currentToolBlocks).length });
    isStreaming = true;
    assistantToolCallIds = {};
    // Do NOT clear the live panel here — extension cards (like tldr summaries)
    // should persist across prompts and be replaced only when new output of
    // the same type arrives, or when the extension explicitly removes them.
    removeWorkingIndicator();
    addWorkingIndicator();
    updateStreamingState();
  }

  function handleAgentEnd() {
    debugLogEvent("agent-end:BEFORE", {
      bashBlocksN: Object.keys(bashBlocks).length,
      toolBlocksN: Object.keys(currentToolBlocks).length,
      bashKeys: Object.keys(bashBlocks),
      toolKeys: Object.keys(currentToolBlocks),
    });
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

  function handleTurnStart(data) {
    hideWelcome();
  }

  function handleTurnEnd(data) {
    if (data && data.message && data.message.role === "assistant" && data.message.errorMessage) {
      if (currentAssistantEl) {
        addErrorToElement(currentAssistantEl, data.message.errorMessage);
      }
    }
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

    var callId = data.toolCallId;
    debugLogEvent("tool-start", {
      callId: callId,
      toolName: data.toolName,
      entryId: data.entryId,
      fromMessage: data.fromMessage,
      inToolBlocks: !!currentToolBlocks[callId],
      inBashBlocks: !!bashBlocks[callId],
    });

    // Guard against duplicates — check BOTH trackers (#fix: bash blocks
    // created by handleBashStart were invisible to this dedup, causing
    // orphaned duplicate DOM nodes that never finalize).
    var existingTool = currentToolBlocks[callId];
    var existingBash = bashBlocks[callId];

    if (existingTool || existingBash) {
      debugLogEvent("tool-start:DEDUP", {
        callId: callId,
        inTool: !!existingTool,
        inBash: !!existingBash,
        bashStatus: existingBash ? (existingBash.getAttribute ? existingBash.getAttribute("data-status") : "?") : "N/A",
      });
      // If we have a bash block, promote it into currentToolBlocks so the
      // tool-end handler can finalize it through the normal path.
      if (existingBash && !existingTool) {
        currentToolBlocks[callId] = { el: existingBash, renderer: bashToolRenderer };
      }
      // Update status on whichever block we have
      var block = existingTool ? (existingTool.el || existingTool) : existingBash;
      if (block && block.getAttribute && block.getAttribute("data-status") === "pending") {
        block.setAttribute("data-status", "running");
        var statusEl = block.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = "running";
          statusEl.className = "tool-status running";
        }
      }
      if (data.entryId && block && block.id && !block.id.startsWith("entry-")) {
        block.id = "entry-" + data.entryId;
      }
      return;
    }

    // Look up the renderer for this tool name
    var renderer = getToolRenderer(data.toolName);
    var block = renderer.create(data);
    if (!block) { console.warn("[pi-gui] tool renderer returned null for", data.toolName); return; }

    if (data.entryId && !block.id.startsWith("entry-")) {
      block.id = "entry-" + data.entryId;
    }
    chatContainer.appendChild(block);

    // Store both the element and its renderer for update/finalize
    currentToolBlocks[callId] = { el: block, renderer: renderer };

    // If fromMessage=false (actual execution), mark as running
    if (!data.fromMessage && renderer === defaultToolRenderer) {
      var statusEl2 = block.querySelector(".tool-status");
      if (statusEl2) {
        statusEl2.textContent = "running";
        statusEl2.className = "tool-status running";
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
    var entry = currentToolBlocks[data.toolCallId];
    if (!entry) return;
    var block = entry.el || entry;
    var renderer = entry.renderer || defaultToolRenderer;
    renderer.update(block, data.partialResult);
    scrollToBottom();
  }

  function handleToolEnd(data) {
    var callId = data.toolCallId;
    var entry = currentToolBlocks[callId];
    debugLogEvent("tool-end", {
      callId: callId,
      found: !!entry,
      isError: !!data.isError,
      inBashBlocks: !!bashBlocks[callId],
      entryId: data.entryId,
    });
    if (!entry) {
      // Fallback: check bashBlocks for blocks created via the legacy path
      var bashBlock = bashBlocks[callId];
      if (bashBlock) {
        debugLogEvent("tool-end:FALLBACK-BASH", { callId: callId });
        bashToolRenderer.finalize(bashBlock, data.result, data.isError, data.entryId);
        delete bashBlocks[callId];
        delete bashOutputs[callId];
      }
      return;
    }
    var block = entry.el || entry;
    var renderer = entry.renderer || defaultToolRenderer;
    renderer.finalize(block, data.result, data.isError, data.entryId);
    delete currentToolBlocks[callId];
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
    debugLogEvent("resetChat", { bashBlocksN: Object.keys(bashBlocks).length, toolBlocksN: Object.keys(currentToolBlocks).length });
    chatContainer.innerHTML =
      '<div id="welcome" class="welcome-message"><h2>Pi coding agent</h2></div>';
    welcome = document.getElementById("welcome");
    currentAssistantEl = null;
    currentThinkingEl = null;
    currentToolBlocks = {};
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
    clearWidgetCards();
    clearLivePanel();
    updateStreamingState();
  }

  function updateStreamingState() {
    if (isStreaming || isCompacting || isRetrying) {
      sendButton.classList.add("hidden");
      abortButton.classList.remove("hidden");
    } else {
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
    if (settingsOpen && !settingsOverlay.contains(target)) {
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
  var localSlashCommands = ["/login", "/logout", "/debug"];

  function handleSlashCommandsUpdate(data) {
    if (data && data.commands && Array.isArray(data.commands)) {
      extensionSlashCommands = data.commands;
      // Re-filter autocomplete if it's currently open
      if (slashAutocompleteOpen) {
        updateSlashAutocomplete(slashFilter);
      }
    }
  }

  function updateSlashAutocomplete(filter) {
    if (!filter || filter.length === 0) {
      slashAutocomplete.classList.remove("visible");
      slashAutocompleteOpen = false;
      return;
    }
    var f = filter.toLowerCase();
    var matches = getSlashCommands().filter(function (sc) { return sc.cmd.toLowerCase().indexOf(f) === 0; });
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
  //
  // These dedicated bash handlers exist for backward compatibility
  // with the extension host's bash-* event stream.  They delegate
  // to the bash tool renderer registered in the tool renderer registry.

  function handleBashStart(data) {
    var callId = data.toolCallId;
    debugLogEvent("bash-start", {
      callId: callId,
      command: (data.command || "").slice(0, 60),
      entryId: data.entryId,
      inToolBlocks: !!currentToolBlocks[callId],
      inBashBlocks: !!bashBlocks[callId],
    });

    // DEDUP: If tool-start already created a block for this callId (promoted
    // from bashBlocks or created fresh), don't create a second DOM element.
    if (currentToolBlocks[callId]) {
      debugLogEvent("bash-start:DEDUP-TOOL", { callId: callId });
      // But still track it in bashBlocks so bash-output/end can reach it
      var entry = currentToolBlocks[callId];
      bashBlocks[callId] = entry.el || entry;
      bashOutputs[callId] = bashOutputs[callId] || "";
      return;
    }
    if (bashBlocks[callId]) {
      debugLogEvent("bash-start:DEDUP-BASH", { callId: callId });
      return;
    }

    // Build a tool-start-compatible data shape for the renderer
    var toolData = {
      toolName: "bash",
      toolCallId: callId,
      args: { command: data.command || "" },
      entryId: data.entryId,
      fromMessage: false,
    };
    var block = bashToolRenderer.create(toolData);
    chatContainer.appendChild(block);
    bashBlocks[callId] = block;
    bashOutputs[callId] = "";
    scrollToBottom();
  }

  function handleBashOutput(data) {
    var callId = data.toolCallId;
    var block = bashBlocks[callId];
    if (!block) {
      // Fallback: try currentToolBlocks (bash block may have been promoted)
      var entry = currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      if (!block) return;
    }
    bashOutputs[callId] = (bashOutputs[callId] || "") + (data.output || "");
    var outEl = block.querySelector(".bash-output");
    if (outEl) {
      outEl.innerHTML = escapeHtml(bashOutputs[callId]);
    }
    scrollToBottom();
  }

  function handleBashEnd(data) {
    var callId = data.toolCallId;
    var block = bashBlocks[callId];
    var fromToolBlocks = false;
    if (!block) {
      // Fallback: check currentToolBlocks (promoted during dedup)
      var entry = currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      fromToolBlocks = !!block;
    }
    debugLogEvent("bash-end", {
      callId: callId,
      found: !!block,
      fromToolBlocks: fromToolBlocks,
      isError: !!data.isError,
      exitCode: data.exitCode,
      cancelled: !!data.cancelled,
      inToolBlocks: !!currentToolBlocks[callId],
      inBashBlocks: !!bashBlocks[callId],
    });
    if (!block) return;
    var result = {
      content: data.output ? [{ type: "text", text: data.output }] : [],
      details: { exitCode: data.exitCode, cancelled: data.cancelled },
    };
    bashToolRenderer.finalize(block, result, data.isError, data.entryId);
    // Clean up both trackers to prevent stale references
    delete currentToolBlocks[callId];
    delete bashBlocks[callId];
    delete bashOutputs[callId];
    scrollToBottom();
  }

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

})();
