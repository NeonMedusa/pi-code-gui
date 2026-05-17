import { state } from "../state.js";
import { logEvent, logDom, summary as debugSummary, debugEventLog } from "../debug.js";
import {
  renderMarkdown, renderBlock, renderInline, patchBlockList,
  escapeHtml, createMessageEl, createThinkingBlock, morphRender,
  truncate, formatTokens, renderToolResult, renderFileContent,
  renderDiffMarkup, formatToolError, getLangFromPath,
  getCompactReadLabel, registerToolRenderer, getToolRenderer,
  hideWelcome, resetChat, scrollToBottom, updateStreamingState,
  renderToolResultTruncated, renderBlockToHTML,
  shortenPath, renderCodeBlockHTML,
  setupCodeBlockHandlers,
} from "../render/engine.js";
import {
  handleToolStart, handleToolUpdate, handleToolEnd,
  writeToolRenderer, editToolRenderer, readToolRenderer,
  bashToolRenderer, defaultToolRenderer,
} from "../tools/index.js";




  // ── Send mode when streaming: "steer" (default) or "queue" ──

  // read-write primitives already replaced with state.xxx in body



  // ═══ Message Renderer Registry ════════════════════════════
  //
  // Custom message types (from pi extensions) can register
  // renderers that produce DOM for the live panel.


export function registerMessageRenderer(customType, rendererFn) {
    state.messageRenderers[customType] = rendererFn;
  }

export function getMessageRenderer(customType) {
    return state.messageRenderers[customType];
  }

  // Expose for pi extensions to register custom message renderers
  window.__piRegisterMessageRenderer = registerMessageRenderer;

  // Default message renderer: creates a collapsible live-panel card
export function defaultMessageRenderer(data) {
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
    if (state.liveCards[customType]) {
      state.liveCards[customType].querySelector(".live-card-content").innerHTML = renderMarkdown(content);
      state.liveCards[customType].classList.add("live-card-collapsed");
      state.liveCards[customType].querySelector(".live-card-content").style.display = "none";
      var exp = state.liveCards[customType].querySelector(".live-card-expando");
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
export function createLiveCard(customType, label, content) {
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
        (card.querySelector(".live-card-expando") as HTMLElement).textContent = "\u25BE";
        (card.querySelector(".live-card-content") as HTMLElement).style.display = "";
      } else {
        card.classList.add("live-card-collapsed");
        (card.querySelector(".live-card-expando") as HTMLElement).textContent = "\u25B8";
        (card.querySelector(".live-card-content") as HTMLElement).style.display = "none";
      }
    });
    card.querySelector(".live-card-close").addEventListener("click", function (e) {
      e.stopPropagation();
      dismissLiveCard(customType);
    });
    state.livePanel.appendChild(card);
    state.liveCards[customType] = card;
    state.livePanel.classList.add("visible");
    return card;
  }

  // ═══ Event Router ═══════════════════════════════════════
  // ═══ Event Router ═══════════════════════════════════════

  window.addEventListener("message", function (event) {
    var msg = event.data;
    // Debug: log every incoming extension message (skip high-frequency stream deltas)
    if (msg.type !== "stream-delta" && msg.type !== "thinking-delta" && msg.type !== "tool-update" && msg.type !== "bash-output") {
      logEvent("recv:" + msg.type, msg.data || msg);
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
      case "queue-update":        logEvent("queue-update", { s: msg.data?.steering?.length, f: msg.data?.followUp?.length }); handleQueueUpdate(msg.data); break;
      case "compaction-start":    handleCompactionStart(msg.data); break;
      case "compaction-end":      handleCompactionEnd(msg.data); break;
      case "auto-retry-start":    handleAutoRetryStart(msg.data); break;
      case "auto-retry-end":      handleAutoRetryEnd(msg.data); break;
      case "thinking-level-changed": handleThinkingLevelChanged(msg.data); break;
      case "batch-start":         handleBatchStart(msg.data); break;
      case "batch-end":           handleBatchEnd(msg.data); break;

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
      case "registerMessageRenderer": handleRegisterMessageRenderer(msg.data); break;


    }
  });

  // ═══ Agent Lifecycle ═══════════════════════════════════
  // ═══ Agent Lifecycle ═══════════════════════════════════

export function handleAgentStart() {
    logEvent("agent-start", { bashBlocksN: Object.keys(state.bashBlocks).length, toolBlocksN: Object.keys(state.currentToolBlocks).length });
    state.isStreaming = true;
    state.queueMode = "steer";  // reset to default on new stream
    state.assistantToolCallIds = {};
    // Do NOT clear the live panel here — extension cards (like tldr summaries)
    // should persist across prompts and be replaced only when new output of
    // the same type arrives, or when the extension explicitly removes them.
    removeWorkingIndicator();
    addWorkingIndicator();
    updateStreamingState();
    setSbDot("streaming");
  }

export function handleAgentEnd() {
    setSbDot("idle");
    // Stop thinking spinner (safety net)
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) {thSpinner.remove();}
    }

    logEvent("agent-end:BEFORE", {
      bashBlocksN: Object.keys(state.bashBlocks).length,
      toolBlocksN: Object.keys(state.currentToolBlocks).length,
      bashKeys: Object.keys(state.bashBlocks),
      toolKeys: Object.keys(state.currentToolBlocks),
    });
    state.isStreaming = false;
    state.isRetrying = false;
    state.assistantToolCallIds = {};
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
    Object.keys(state.currentToolBlocks).forEach(function (id) {
      var entry = state.currentToolBlocks[id];
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
    state.currentToolBlocks = {};

    // Also finalize any dangling bash blocks that were never closed
    Object.keys(state.bashBlocks).forEach(function (id) {
      var block = state.bashBlocks[id];
      if (block && block.getAttribute && block.getAttribute("data-status") === "running") {
        logEvent("agent-end:ORPHAN-BASH", { toolCallId: id, inDOM: !!block.parentElement });
        block.setAttribute("data-status", "done");
        var footer = block.querySelector(".bash-footer");
        if (footer) { footer.innerHTML = '<span class="exit-code">exit: -</span> <span>(ended)</span>'; }
        delete state.bashBlocks[id];
        delete state.bashOutputs[id];
      }
    });

    updateStreamingState();
  }

  // ═══ Turn Lifecycle ════════════════════════════════════
  // ═══ Turn Lifecycle ════════════════════════════════════

export function handleTurnStart(data) {
    hideWelcome();
  }

export function handleTurnEnd(data) {
    if (data && data.message && data.message.role === "assistant" && data.message.errorMessage) {
      if (state.currentAssistantEl) {
        addErrorToElement(state.currentAssistantEl, data.message.errorMessage);
      }
    }
  }

  // ═══ Message Lifecycle ═════════════════════════════════
  // ═══ Message Lifecycle ═════════════════════════════════

export function handleChatMessage(data) {
    // Dedup: skip if same role+content as last user message
    if (data.role === "user" && data.content === state.lastUserMessageContent) {return;}
    if (data.role === "user") {
      state.lastUserMessageContent = data.content;
      // Populate state.userMessageHistory for up-arrow recall (#2)
      state.userMessageHistory.unshift({ text: data.content });
      if (state.userMessageHistory.length > 50) {state.userMessageHistory.pop();}
    }

    hideWelcome();
    removeWorkingIndicator(); // Hide working indicator when we get a response

    var el = createMessageEl(data.role);
    // #9: Entry ID for scroll-to
    if (data.entryId) {el.id = "entry-" + data.entryId;}
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
    state.chatContainer.appendChild(el);
    scrollToBottom();
  }

export function handleAssistantStart(data) {
    hideWelcome();
    removeWorkingIndicator();

    // Create the assistant container eagerly before any content arrives
    state.currentAssistantEl = createMessageEl("assistant");
    // #9: Entry ID for scroll-to
    if (data.entryId) {state.currentAssistantEl.id = "entry-" + data.entryId;}
    state.currentThinkingEl = null;
    state._streamPrevTokens = [];  // Reset token tracker for new message
    state.assistantToolCallIds = {};
    state.chatContainer.appendChild(state.currentAssistantEl);
    scrollToBottom();
  }

export function handleAssistantEnd(data) {
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
              var entry = state.currentToolBlocks[tcId];
              var block = entry ? (entry.el || entry) : null;
              if (block) {
                var statusEl = block.querySelector(".tool-status");
                if (statusEl) {
                  statusEl.textContent = "error";
                  statusEl.className = "tool-status error";
                }
                block.setAttribute("data-status", "error");
                delete state.currentToolBlocks[tcId];
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

export function _scheduleStreamRender(contentEl) {
    if (state._streamRafId) {return;}
    state._streamContentEl = contentEl;
    state._streamRafId = requestAnimationFrame(function () {
      state._streamRafId = null;
      if (!state._streamContentEl) {return;}
      var el = state._streamContentEl;
      state._streamContentEl = null;

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
export function _flushStreamRender() {
    // Flush thinking text first so it's visible in the final render
    _flushThinkingRender();
    if (state._streamRafId) {
      cancelAnimationFrame(state._streamRafId);
      state._streamRafId = null;
      if (state._streamContentEl) {
        var el = state._streamContentEl;
        state._streamContentEl = null;

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

export function handleStreamDelta(data) {
    hideWelcome();
    if (!state.currentAssistantEl) {
      // Safety: create container if assistant-start was missed
      state.currentAssistantEl = createMessageEl("assistant");
      state.currentThinkingEl = null;
      state._streamPrevTokens = [];
      state.chatContainer.appendChild(state.currentAssistantEl);
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

export function _scheduleThinkingRender(tc) {
    if (state._thinkingRafId) {return;}
    state._thinkingEl = tc;
    state._thinkingRafId = requestAnimationFrame(function () {
      state._thinkingRafId = null;
      if (!state._thinkingEl) {return;}
      var el = state._thinkingEl;
      state._thinkingEl = null;
      // Flush accumulated text via textContent (avoids HTML parse)
      var raw = el.getAttribute("data-raw") || "";
      el.textContent = raw;
      // Update line count and expand button
      var block = el.closest(".thinking-block");
      if (block) {
        var lineCount = block.querySelector(".thinking-line-count");
        var lines = raw ? raw.split("\n").length : 0;
        if (lineCount) {lineCount.textContent = lines > 0 ? "(" + lines + " lines)" : "";}
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

export function _flushThinkingRender() {
    if (state._thinkingRafId) {
      cancelAnimationFrame(state._thinkingRafId);
      state._thinkingRafId = null;
      if (state._thinkingEl) {
        var el = state._thinkingEl;
        state._thinkingEl = null;
        var raw = el.getAttribute("data-raw") || "";
        el.textContent = raw;
      }
    }
  }

export function handleThinkingDelta(data) {
    if (data.done) {
      _flushThinkingRender();
      // Remove spinner when thinking completes, finalize expand button
      if (state.currentThinkingEl) {
        var spinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (spinner) {spinner.remove();}
        var block = state.currentThinkingEl;
        var contentEl = block.querySelector(".thinking-content");
        var btn = block.querySelector(".thinking-expand-btn");
        if (btn && contentEl) {
          var overflowing = contentEl.scrollHeight > contentEl.clientHeight + 2;
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
        if (mc) {mc.prepend(state.currentThinkingEl);}
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

  // ═══ In-webview status bar ═══════════════════════════

let sbDot = document.getElementById("pi-sb-dot");
let sbModel = document.getElementById("pi-sb-model");
let sbThinking = document.getElementById("pi-sb-thinking");
let sbEffort = document.getElementById("pi-sb-effort");
let sbUsage = document.getElementById("pi-sb-usage");

export function setSbDot(state) {
    if (!sbDot) {return;}
    sbDot.textContent = state === "streaming" ? "\u25CF" : "\u25CB";
  }

export function sbModelText(modelId) {
    var short = modelId || "Pi";
    // Shorten known prefixes for compact display
    if (short.startsWith("anthropic/")) {short = short.slice(10);}
    else if (short.startsWith("openai/")) {short = short.slice(7);}
    else if (short.startsWith("google/")) {short = short.slice(7);}
    if (short.length > 24) {short = short.slice(0, 22) + "\u2026";}
    return "\u03C0 " + short;
  }

export function handleStatusUpdate(data) {
    if (data.reset) {return;}

    if (sbModel && data.model) {
      sbModel.textContent = sbModelText(data.model);
    }
    if (sbThinking) {
      sbThinking.textContent = "thinking: " + (data.thinkingLevel || "off");
    }
    if (sbEffort) {
      sbEffort.textContent = "effort: " + (data.effort || "auto");
    }
    if (sbUsage && data.usage) {
      var parts = [];
      var u = data.usage;
      if (u.input > 0) {parts.push("\u2191" + formatTokens(u.input));}
      if (u.output > 0) {parts.push("\u2193" + formatTokens(u.output));}
      if (u.cost > 0) {parts.push("$" + u.cost.toFixed(2));}
      if (u.contextPercent !== undefined) {parts.push(u.contextPercent.toFixed(0) + "%");}
      sbUsage.textContent = parts.length > 0 ? parts.join(" ") : "0%";
    }
    setSbDot(data.state.isStreaming ? "streaming" : "idle");
  }

export function handleStatus(data) {
    if (data.ready) {
      state.promptInput.disabled = false;
      state.sendButton.disabled = false;
      state.promptInput.placeholder = "Ask pi to do something...";
      state.promptInput.focus();
      if (sbModel && data.model) {
        sbModel.textContent = sbModelText(data.model);
      }
      if (sbThinking) {
        sbThinking.textContent = "thinking: " + (data.thinkingLevel || "off");
      }
      if (sbEffort) {
        sbEffort.textContent = "effort: " + (data.effort || "auto");
      }
      setSbDot("idle");
    } else if (data.model === "not installed" || data.model === "init failed") {
      state.promptInput.disabled = true;
      state.sendButton.disabled = true;
    }
  }

export function handleBatchStart(data) {
    state._inBatch = true;
    // If restoring history, hide state.welcome immediately — no flash
    if (data.hasEntries) { hideWelcome(); }
    document.body.classList.add("no-animate");
  }

export function handleBatchEnd(data) {
    state._inBatch = false;
    document.body.classList.remove("no-animate");
    // For fresh sessions, state.welcome was never hidden — keep it visible
    // For restores, state.welcome is already hidden
    // Force-scroll to bottom after batch replay (ignores state.hasScrolledUp).
    // Use a double-rAF so layout has settled before reading scrollHeight.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        state.chatContainer.scrollTop = state.chatContainer.scrollHeight;
      });
    });
  }

export function handleQueueUpdate(data) {
    // Track for /debug inspection
    (window.__piDebug._queueEvents = window.__piDebug._queueEvents || []).push({
      ts: Date.now(),
      steering: (data.steering || []).length,
      followUp: (data.followUp || []).length,
      streaming: state.isStreaming,
    });
    if (window.__piDebug._queueEvents.length > 20) {window.__piDebug._queueEvents.shift();}

    var existing = document.getElementById("pending-queue-indicator");
    if (existing) {existing.remove();}

    var steering = data.steering || [];
    var followUp = data.followUp || [];
    if (steering.length === 0 && followUp.length === 0) {return;}

    var el = document.createElement("div");
    el.id = "pending-queue-indicator";
    el.className = "queue-indicator";

    var html = "";

    // Steering messages — already interrupting, show with label
    steering.forEach(function (m) {
      html += '<div class="queue-row">' +
        '<span class="queue-label">Steer:</span> ' +
        '<span class="queue-text">' + escapeHtml(m) + '</span></div>';
    });

    // Follow-up messages — queued, with promote button
    followUp.forEach(function (m, i) {
      html += '<div class="queue-row">' +
        '<span class="queue-label">Queue:</span> ' +
        '<span class="queue-text">' + escapeHtml(m) + '</span>' +
        '<button class="queue-promote-btn" data-idx="' + i + '" title="Promote to Steer (interrupt now)">Steer now</button>' +
        '</div>';
    });

    // Clear all button — always show when there are items
    html += '<div class="queue-actions">' +
      '<button class="queue-clear-btn">✕ Clear all queued</button>' +
      '</div>';

    el.innerHTML = html;

    // Wire promote buttons
    el.querySelectorAll(".queue-promote-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-idx"), 10);
        var msg = (data.followUp || [])[idx];
        if (msg) {
          // Promote: clear all queues, then re-steer this message
          window.__vscode.postMessage({ type: "promoteToSteer", text: msg });
        }
      });
    });

    // Wire clear button
    var clearBtn = el.querySelector(".queue-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        window.__vscode.postMessage({ type: "clearQueue" });
      });
    }

    var inputArea = document.getElementById("input-area");
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(el, inputArea);
    }
  }

export function handleCompactionStart(data) {
    state.isCompacting = true;
    removeCompactionIndicator();
    addCompactionIndicator(data.reason === "manual" ? "Compacting..." : "Auto-compacting...");
    updateStreamingState();
  }

export function handleCompactionEnd(data) {
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

export function handleAutoRetryStart(data) {
    state.isRetrying = true;
    removeRetryIndicator();
    addRetryIndicator(data.attempt, data.maxAttempts, data.delayMs);
    updateStreamingState();
  }

export function handleAutoRetryEnd(data) {
    state.isRetrying = false;
    removeRetryIndicator();
    if (!data.success) {
      addErrorMessage("Retry failed after " + data.attempt + " attempts: " + (data.finalError || "Unknown error"));
    }
    updateStreamingState();
  }

export function handleThinkingLevelChanged(data) {
    if (sbThinking && data.level) {
      sbThinking.textContent = "thinking: " + data.level;
    }
  }

  // ═══ Error Handling ════════════════════════════════════

export function handleError(data) {
    hideWelcome();
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();

    addErrorMessage(data.message || "Unknown error");
    state.isStreaming = false;
    if (state.currentAssistantEl) {
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) {mc.classList.remove("streaming-cursor");}
      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }
    updateStreamingState();
    scrollToBottom();
  }

  // ═══ UI Helpers — Indicators ═══════════════════════════
  // ═══ UI Helpers — Indicators ═══════════════════════════

export function addWorkingIndicator() {
    var existing = document.getElementById("working-indicator");
    if (existing) {return;}
    var el = document.createElement("div");
    el.id = "working-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content"><span class="working-spinner">○</span> Working...</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();

    // Animate spinner
    var frames = ["○", "◔", "◐", "◓"];
    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = (frame + 1) % frames.length;
      var s = el.querySelector(".working-spinner");
      if (s) {s.textContent = frames[frame];}
    }, 300);
  }

export function removeWorkingIndicator() {
    var el = document.getElementById("working-indicator");
    if (el) {
      if (el._spinnerInterval) {clearInterval(el._spinnerInterval);}
      el.remove();
    }
  }

export function addCompactionIndicator(message) {
    var existing = document.getElementById("compaction-indicator");
    if (existing) {existing.remove();}
    var el = document.createElement("div");
    el.id = "compaction-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content warning">' +
      '<span class="working-spinner">◆</span> ' + escapeHtml(message) + '</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();

    var frames = ["◇", "◆", "◇", "◆"];
    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = (frame + 1) % frames.length;
      var s = el.querySelector(".working-spinner");
      if (s) {s.textContent = frames[frame];}
    }, 400);
  }

export function removeCompactionIndicator() {
    var el = document.getElementById("compaction-indicator");
    if (el) {
      if (el._spinnerInterval) {clearInterval(el._spinnerInterval);}
      el.remove();
    }
  }

export function addRetryIndicator(attempt, maxAttempts, delayMs) {
    var existing = document.getElementById("retry-indicator");
    if (existing) {existing.remove();}
    var el = document.createElement("div");
    el.id = "retry-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content warning">' +
      '<span class="working-spinner">↻</span> Retrying (' + attempt + '/' + maxAttempts +
      ') in ' + Math.ceil(delayMs / 1000) + 's...</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();

    // Countdown
    var remaining = delayMs;
    el._countdownInterval = setInterval(function () {
      remaining -= 1000;
      if (remaining <= 0) {
        var span = el.querySelector(".retry-countdown");
        if (span) {span.textContent = "0s";}
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

export function removeRetryIndicator() {
    var el = document.getElementById("retry-indicator");
    if (el) {
      if (el._countdownInterval) {clearInterval(el._countdownInterval);}
      el.remove();
    }
  }

  // ═══ UI Helpers — Chat additions ═══════════════════════
  // ═══ UI Helpers — Chat additions ═══════════════════════

export function addStatusMessage(message) {
    var el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = '<div class="message-content muted">' +
      escapeHtml(message) + '</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();
  }

export function showQuickstartGuide() {
    // Remove any previous guide
    var existing = document.getElementById("quickstart-guide");
    if (existing) {existing.remove();}

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

      '<p style="margin-top:12px"><a href="https://pi.dev/docs/latest/quickstart">📚 Full quickstart guide →</a>  ·  ' +
      '<a href="https://pi.dev/docs/latest/providers">🔑 All supported providers →</a></p>' +

      '</div>' +
      '</details>';
    state.chatContainer.appendChild(el);
  }

export function addErrorMessage(message) {
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
      '<div class="message-content error">' +
      '⚠ ' + heading + '<br><br>' +
      renderMarkdown(msg) +
      '<br><br>' + help +
      '</div>';
    state.chatContainer.appendChild(el);

    // Show inline quickstart guide for API key errors
    if (isApiKeyError) {
      showQuickstartGuide();
    }

    scrollToBottom();
  }

export function addErrorToElement(parentEl, message) {
    if (!parentEl) {return;}
    var errorEl = document.createElement("div");
    errorEl.className = 'message-content error'; errorEl.style.cssText = 'margin-top: 8px; padding: 4px 0;';
    errorEl.textContent = "\u26A0 " + message;
    parentEl.appendChild(errorEl);
  }

  // ═══ UI Helpers — Tool Block ═══════════════════════════
  // ═══ Input Handling ════════════════════════════════════

  // ═══ Attachment Handling ═══════════════════════════════

export function generateAttId() {
    return "att_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

export function clearAttachments() {
    // Revoke blob URLs to free memory
    state.attachments.forEach(function (a) {
      if (a.blobUrl) {URL.revokeObjectURL(a.blobUrl);}
    });
    state.attachments = [];
    renderAttachments();
  }

export function removeAttachment(id) {
    var idx = state.attachments.findIndex(function (a) { return a.id === id; });
    if (idx === -1) {return;}
    var att = state.attachments[idx];
    if (att.blobUrl) {URL.revokeObjectURL(att.blobUrl);}
    state.attachments.splice(idx, 1);
    renderAttachments();
  }

export function renderAttachments() {
    if (!state.attachmentBar) {return;}

    if (state.attachments.length === 0) {
      state.attachmentBar.classList.remove("visible");
      state.attachmentBar.innerHTML = "";
      return;
    }

    state.attachmentBar.classList.add("visible");
    var html = "";

    for (var i = 0; i < state.attachments.length; i++) {
      var a = state.attachments[i];

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

    state.attachmentBar.innerHTML = html;

    // Delegate click events for remove buttons
    state.attachmentBar.querySelectorAll(".att-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var id = e.target.getAttribute("data-att-id");
        if (id) {removeAttachment(id);}
      });
    });
  }

  // ── Paste handler ──────────────────────────────────────

  state.promptInput.addEventListener("paste", function (e) {
    var items = e.clipboardData.items;
    if (!items) {return;}

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

    if (imageItems.length === 0 && fileItems.length === 0) {return;}

    e.preventDefault();

    // Capture any text from the clipboard too
    var pastedText = e.clipboardData.getData("text/plain") || "";

    // Process image items
    for (var j = 0; j < imageItems.length; j++) {
      (function (item) {
        var file = item.getAsFile();
        if (!file) {return;}

        var attId = generateAttId();
        var blobUrl = URL.createObjectURL(file);

        state.attachments.push({
          id: attId,
          type: "image",
          name: file.name || "pasted-image.png",
          mediaType: item.type,
          data: null,      // will be filled after FileReader
          blobUrl: blobUrl, // immediate preview
        });

        var reader = new FileReader(); reader.onload = function () { var result = reader.result as string; // "data:image/png;base64,..."
          var att = state.attachments.find(function (a) { return a.id === attId; });
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
        if (!file) {return;}

        var attId = generateAttId();

        state.attachments.push({
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
            var att = state.attachments.find(function (a) { return a.id === attId; });
            if (att) {
              att.data = reader.result;
            }
            renderAttachments();
          };
          reader.readAsText(file);
        } else {
          var att = state.attachments.find(function (a) { return a.id === attId; });
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
      var start = state.promptInput.selectionStart;
      var end = state.promptInput.selectionEnd;
      var val = state.promptInput.value;
      state.promptInput.value = val.slice(0, start) + pastedText + val.slice(end);
      state.promptInput.selectionStart = state.promptInput.selectionEnd = start + pastedText.length;
      state.promptInput.dispatchEvent(new Event("input"));
    }
  });

  // ── Send prompt ───────────────────────────────────────

export function sendPrompt() {
    console.log("[pi-gui] sendPrompt called");
    var text = state.promptInput.value.trim();
    if (!text && state.attachments.length === 0) {return;}

    // Reset scroll tracking — user clearly wants to follow the new response
    state.hasScrolledUp = false;

    // Intercept local slash commands before sending to LLM
    if (text && state.localSlashCommands.indexOf(text) !== -1) {
      var cmd = text.slice(1); // strip leading "/"

      // /debug: dump webview state as a structured message in chat, plus
      // log to console so it can be inspected from DevTools without copy-paste.
      if (cmd === "debug") {
        handleDebugCommand();
        state.promptInput.value = "";
        state.promptInput.style.height = "auto";
        state.promptInput.style.overflowY = "hidden";
        clearAttachments();
        return;
      }

      window.__vscode.postMessage({
        type: "slashCommand",
        command: cmd,
      });
      state.promptInput.value = "";
      state.promptInput.style.height = "auto";
      state.promptInput.style.overflowY = "hidden";
      clearAttachments();
      return;
    }

    // Build images array from image state.attachments with loaded data
    var images = state.attachments
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

    window.__vscode.postMessage({
      type: "prompt",
      text: text,
      images: images.length > 0 ? images : undefined,
      mode: state.isStreaming ? state.queueMode : undefined,
    });

    state.promptInput.value = "";
    state.promptInput.style.height = "auto";
    state.promptInput.style.overflowY = "hidden";
    clearAttachments();
  }

  state.sendButton.addEventListener("click", sendPrompt);

  state.abortButton.addEventListener("click", function () {
    window.__vscode.postMessage({ type: "abort" });
  });

  // Steer dropdown — toggles between Steer and Queue mode
  state.steerDropdown.addEventListener("click", function () {
    state.queueMode = state.queueMode === "steer" ? "queue" : "steer";
    if (state.queueMode === "queue") {
      state.sendButton.textContent = "Queue";
      state.sendButton.title = "Queue (process after current turn)";
      state.steerDropdown.title = "Switch to Steer";
    } else {
      state.sendButton.textContent = "Steer";
      state.sendButton.title = "Steer (interrupt current request)";
      state.steerDropdown.title = "Switch to Queue";
    }
  });

  // ── In-webview status bar click handlers ─────────────
  if (sbModel) {
    sbModel.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickModel" });
    });
  }
  if (sbThinking) {
    sbThinking.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickThinkingLevel" });
    });
  }
  if (sbEffort) {
    sbEffort.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickEffort" });
    });
  }
  if (sbUsage) {
    sbUsage.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickContextBudget" });
    });
  }
let sbSettings = document.getElementById("pi-sb-settings");
  if (sbSettings) {
    sbSettings.addEventListener("click", function () {
      toggleSettingsPanel();
    });
  }

  // Setup code block copy buttons (event delegation, CSP-safe)
  setupCodeBlockHandlers();

  // Handle external links and close overlays on outside clicks
  document.addEventListener("click", function (e) {
    var target = e.target as HTMLElement;
    if (target && target.tagName === "A" && (target as HTMLAnchorElement).href) {
      e.preventDefault();
      window.__vscode.postMessage({ type: "openUrl", url: (target as HTMLAnchorElement).href });
    }
    // Close overlays when clicking outside (except the status bar gear)
    if (state.settingsOpen && !state.settingsOverlay.contains(target) && target !== sbSettings && !sbSettings.contains(target)) {
      closeAllOverlays();
    }
    if (state.userMsgSelectorOpen && !state.userMsgOverlay.contains(target) && target !== state.promptInput) {
      closeAllOverlays();
    }
    if (state.slashAutocompleteOpen && !state.slashAutocomplete.contains(target) && target !== state.promptInput) {
      closeAllOverlays();
    }
  });

  state.promptInput.addEventListener("keydown", function (e) {
    // #8: Tab to accept slash autocomplete
    if (state.slashAutocompleteOpen && e.key === "Tab") {
      e.preventDefault();
      var sel = state.slashAutocomplete.querySelector(".slash-item.selected");
      if (sel) {
        state.promptInput.value = sel.getAttribute("data-cmd") + " ";
        state.promptInput.focus();
      }
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    // #8: Arrow keys in slash autocomplete
    if (state.slashAutocompleteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.key === "ArrowDown") {state.slashSelectedIdx++;}
      else {state.slashSelectedIdx = Math.max(0, state.slashSelectedIdx - 1);}
      updateSlashAutocomplete(state.slashFilter);
      return;
    }
    // #2: Up arrow in empty input → show user message history
    // Move this BEFORE the slash-autocomplete arrow handling so it takes
    // priority when the input is empty (no slash typed yet)
    if (e.key === "ArrowUp" && state.promptInput.value === "" && state.userMessageHistory.length > 0) {
      e.preventDefault();
      if (!state.userMsgSelectorOpen) {
        showUserMessageSelector();
      } else {
        state.userMsgSelectedIdx = Math.max(0, state.userMsgSelectedIdx - 1);
        highlightUserMsgItem();
      }
      return;
    }
    // ArrowDown: navigate user message list if open
    if (e.key === "ArrowDown" && state.userMsgSelectorOpen) {
      e.preventDefault();
      state.userMsgSelectedIdx = Math.min(state.userMessageHistory.length - 1, state.userMsgSelectedIdx + 1);
      highlightUserMsgItem();
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
    // Enter: accept user msg or slash autocomplete if open, otherwise send
    if (e.key === "Enter" && !e.shiftKey) {
      if (state.userMsgSelectorOpen) {
        e.preventDefault();
        var idx = state.userMsgSelectedIdx;
        if (idx >= 0 && idx < state.userMessageHistory.length) {
          state.promptInput.value = state.userMessageHistory[idx].text;
          state.promptInput.focus();
          resizePromptInput();
        }
        closeUserMsgSelector();
        return;
      }
      if (state.slashAutocompleteOpen) {
        e.preventDefault();
        var sel = state.slashAutocomplete.querySelector(".slash-item.selected");
        if (sel) {
          state.promptInput.value = sel.getAttribute("data-cmd") + " ";
        }
        state.slashAutocomplete.classList.remove("visible");
        state.slashAutocompleteOpen = false;
        state.promptInput.focus();
        return;
      }
      closeAllOverlays();
      e.preventDefault();
      sendPrompt();
    }
  });

  state.promptInput.addEventListener("input", function () {
    // Cap at ~5 lines (approx 20px per line = 100px).
    // Only show scrollbar when the content actually exceeds the cap.
    var maxHeight = 100; // 5 lines ~ 100px
    state.promptInput.style.height = "auto";
    var newHeight = Math.min(state.promptInput.scrollHeight, maxHeight);
    state.promptInput.style.height = newHeight + "px";
    // Only enable overflow scrollbar when content is truncated
    if (state.promptInput.scrollHeight > maxHeight) {
      state.promptInput.style.overflowY = "auto";
    } else {
      state.promptInput.style.overflowY = "hidden";
    }

    // #8: Detect slash commands for autocomplete
    var val = state.promptInput.value;
    var slashMatch = val.match(/^\/(\w*)$/);
    if (slashMatch) {
      state.slashFilter = val;
      state.slashSelectedIdx = 0;
      updateSlashAutocomplete(val);
    } else {
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
    }
  });

export function resizePromptInput() {
    var maxHeight = 100;
    state.promptInput.style.height = "auto";
    var newHeight = Math.min(state.promptInput.scrollHeight, maxHeight);
    state.promptInput.style.height = newHeight + "px";
    state.promptInput.style.overflowY = state.promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
  }

export function handleInsertCommand(command) {
    state.promptInput.value = command + " ";
    state.promptInput.focus();
    resizePromptInput();
  }

  // ═══ #1: Compaction Summary Message ═══════════════════════
  // ═══ #1: Compaction Summary Message ═══════════════════════

export function handleCompactionSummaryMessage(data) {
    hideWelcome();
    var el = document.createElement("div");
    el.className = "compaction-summary";
    if (data.entryId) {el.id = "entry-" + data.entryId;}
    var tokenStr = (data.tokensBefore || 0).toLocaleString();
    var summaryId = "cs-" + Math.random().toString(36).slice(2, 8);
    el.innerHTML =
      '<div class="cs-header">[compaction]</div>' +
      '<div class="cs-preview" id="' + summaryId + '-toggle">Compacted from ' + tokenStr + ' tokens (click to expand)</div>' +
      '<div class="cs-content" id="' + summaryId + '-content" style="display:none">' + escapeHtml(data.summary || "") + '</div>';
    state.chatContainer.appendChild(el);

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

export function handleUserMessagesList(data) {
    state.userMessageHistory = (data.messages || []).reverse();
  }

export function showUserMessageSelector() {
    if (state.userMessageHistory.length === 0) {return;}
    closeAllOverlays();
    state.userMsgSelectorOpen = true;
    state.userMsgSelectedIdx = 0;
    state.userMsgOverlay.classList.add("visible");
    var html = "";
    for (var i = 0; i < state.userMessageHistory.length; i++) {
      var msg = state.userMessageHistory[i];
      var text = msg.text || "";
      if (text.length > 100) {text = text.slice(0, 100) + "\u2026";}
      html += '<div class="user-msg-item" data-idx="' + i + '"><span class="msg-idx">' + (i + 1) + '</span>' + escapeHtml(text) + '</div>';
    }
    state.userMsgOverlay.innerHTML = html;

    // Click handlers
    var items = state.userMsgOverlay.querySelectorAll(".user-msg-item");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var idx = parseInt(this.getAttribute("data-idx"), 10);
        if (idx >= 0 && idx < state.userMessageHistory.length) {
          var text = state.userMessageHistory[idx].text;
          state.promptInput.value = text;
          state.promptInput.focus();
          resizePromptInput();
        }
        closeUserMsgSelector();
      });
    });
  }

export function highlightUserMsgItem() {
    var items = state.userMsgOverlay.querySelectorAll(".user-msg-item");
    items.forEach(function (item, i) {
      if (i === state.userMsgSelectedIdx) {
        item.classList.add("selected");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("selected");
      }
    });
  }

export function closeUserMsgSelector() {
    state.userMsgSelectorOpen = false;
    state.userMsgSelectedIdx = 0;
    state.userMsgOverlay.classList.remove("visible");
  }

  // ═══ #3: Settings Panel ═══════════════════════════════════

export function handleSettingsUpdate(data) {
    if (data) {
      state.settingsState = data;
      renderSettingsPanel();
    }
  }

export function handleScopedModelsUpdate(data) {
    if (data && data.models) {
      state.scopedModels = data.models;
      renderScopedModels();
      renderSettingsPanel();
    }
  }

export function renderScopedModels() {
    // Scoped models removed from UI
  }

export function renderSettingsPanel() {
    if (!state.settingsOverlay || !state.settingsOpen) {return;}
    var html = '<div class="settings-title">Settings</div>';

    var toggles = [
      { key: "autoCompaction", label: "Auto-compaction" },
      { key: "autoRetry", label: "Auto-retry" },
      { key: "showImages", label: "Show images" },
    ];

    for (var i = 0; i < toggles.length; i++) {
      var t = toggles[i];
      var on = state.settingsState[t.key];
      html +=
        '<div class="settings-row">' +
        '<span>' + t.label + '</span>' +
        '<span class="settings-toggle' + (on ? " on" : "") + '" data-key="' + t.key + '"></span>' +
        '</div>';
    }



    state.settingsOverlay.innerHTML = html;

    // Wire toggle clicks
    var togglesEls = state.settingsOverlay.querySelectorAll(".settings-toggle");
    togglesEls.forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = el.getAttribute("data-key");
        if (key === "autoCompaction") { window.__vscode.postMessage({ type: "toggleAutoCompaction" }); }
        else if (key === "autoRetry") { window.__vscode.postMessage({ type: "toggleAutoRetry" }); }
        else if (key === "showImages") { window.__vscode.postMessage({ type: "toggleShowImages" }); }
      });
    });
  }

export function toggleSettingsPanel() {
    if (state.settingsOpen) {
      closeAllOverlays();
    } else {
      closeAllOverlays();
      state.settingsOpen = true;
      state.settingsOverlay.classList.add("visible");
      window.__vscode.postMessage({ type: "getSettings" });
    }
  }

export function closeAllOverlays() {
    state.settingsOpen = false;
    state.userMsgSelectorOpen = false;
    state.slashAutocompleteOpen = false;
    state.settingsOverlay.classList.remove("visible");
    state.userMsgOverlay.classList.remove("visible");
    state.slashAutocomplete.classList.remove("visible");
  }

  // ═══ #5: Diff Rendering for edit tool results ════════════
  // ═══ #7: Custom Message Rendering ═════════════════════════

/**
 * Render a custom message inline in the conversation stream.
 * Supports per-customType renderers registered via
 * window.__piRegisterMessageRenderer, and updates existing
 * cards in-place when the same customType reappears (polling).
 * Action buttons with data-command execute slash commands.
 */
export function renderInlineCustomMessage(data) {
    var customType = data.customType || "custom";
    var details = data.details;
    var content = typeof data.content === "string"
      ? data.content
      : (Array.isArray(data.content) ? data.content.filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n") : "");

    // Check for existing card to update in-place (polling refresh)
    var existing = state.chatContainer.querySelector('[data-custom-type="' + customType + '"]');

    var renderer = getMessageRenderer(customType);

    if (existing) {
      // Update existing card
      if (renderer) {
        // Re-run registered renderer on the existing container
        var body = existing.querySelector(".custom-message-body");
        if (body) { body.innerHTML = ""; renderer(data, body); }
      } else {
        existing.querySelector(".custom-message-body").innerHTML = renderMarkdown(content);
      }
      return;
    }

    // Create new inline card
    var el = document.createElement("div");
    el.className = "custom-message-inline";
    el.setAttribute("data-custom-type", customType);

    var label = escapeHtml(customType);
    el.innerHTML =
      '<div class="custom-message-header">' +
      '<span class="custom-message-label">' + label + '</span>' +
      '</div>' +
      '<div class="custom-message-body"></div>';

    var body = el.querySelector(".custom-message-body");
    if (renderer) {
      renderer(data, body);
    } else {
      body.innerHTML = renderMarkdown(content);
    }

    // Wire action buttons: data-command sends slash command
    el.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-command]");
      if (btn) {
        e.preventDefault();
        var cmd = btn.getAttribute("data-command");
        if (cmd && window.__vscode) {
          window.__vscode.postMessage({ type: "slashCommand", command: cmd });
        }
      }
    });

    state.chatContainer.appendChild(el);
    scrollToBottom();
  }

export function handleCustomMessage(data) {
    hideWelcome();
    var customType = data.customType || "custom";

    // ── display: true → inline in conversation stream ──────
    if (data.display === true) {
      renderInlineCustomMessage(data);
      return;
    }

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
        infoEl.innerHTML = '<div class="message-content muted">' + escapeHtml(infoContent) + '</div>';
        state.chatContainer.appendChild(infoEl);
        scrollToBottom();
      }
      return;
    }

    // Try the registry first — extensions can register custom renderers
    var renderer = getMessageRenderer(customType);
    if (renderer) {
      renderer(data, state.livePanel, state.liveCards, createLiveCard, dismissLiveCard);
      return;
    }

    // Fall back to the default live-card renderer
    defaultMessageRenderer(data);
  }

export function dismissLiveCard(key) {
    var card = state.liveCards[key];
    if (card) {
      card.remove();
      delete state.liveCards[key];
    }
    var widgetCard = state.widgetCards[key];
    if (widgetCard) {
      widgetCard.remove();
      delete state.widgetCards[key];
    }
    // Hide panel if empty
    var remaining = state.livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      state.livePanel.classList.remove("visible");
    }
  }

export function clearLivePanel() {
    // Only clear transient cards (non-widget cards).
    // Widget cards persist until the extension explicitly clears them.
    var toRemove = [];
    for (var key in state.liveCards) {
      if (state.liveCards.hasOwnProperty(key)) {
        var card = state.liveCards[key];
        if (card && card.getAttribute("data-widget") !== "true") {
          toRemove.push(key);
        }
      }
    }
    for (var i = 0; i < toRemove.length; i++) {
      var c = state.liveCards[toRemove[i]];
      if (c) {c.remove();}
      delete state.liveCards[toRemove[i]];
    }
    // Hide the panel if nothing remains
    var remaining = state.livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      state.livePanel.classList.remove("visible");
    }
  }

  // ── Widget Bridge ─────────────────────────────────────
  // ── Widget Bridge ─────────────────────────────────────


/** Bridge: extension host registers a renderer by source code. */
export function handleRegisterMessageRenderer(data) {
    if (!data.customType || !data.sourceCode) {return;}
    try {
      // eslint-disable-next-line no-eval
      var renderer = eval("(function(data, containerEl) { " + data.sourceCode + " })");
      registerMessageRenderer(data.customType, renderer);
    } catch (e) {
      console.warn("[pi-gui] Failed to register message renderer for", data.customType, e);
    }
  }

export function handleWidgetUpdate(data) {
    if (!data || !data.key) {return;}

    var key = data.key;
    var content = data.content;

    if (content === null || content === undefined) {
      // Remove widget card
      var existing = state.widgetCards[key];
      if (existing) {
        existing.remove();
        delete state.widgetCards[key];
      }
      // Also remove from state.liveCards
      delete state.liveCards[key];
      // Hide panel if empty
      var remaining = state.livePanel.querySelectorAll(".live-card");
      if (remaining.length === 0) {
        state.livePanel.classList.remove("visible");
      }
      return;
    }

    // Create or update widget card
    var card = state.widgetCards[key];
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
      state.livePanel.appendChild(card);
      state.widgetCards[key] = card;
      state.liveCards[key] = card;
    }
    state.livePanel.classList.add("visible");
  }

export function clearWidgetCards() {
    for (var key in state.widgetCards) {
      if (state.widgetCards.hasOwnProperty(key)) {
        state.widgetCards[key].remove();
      }
    }
    state.widgetCards = {};
  }

  // ═══ #8: Slash Command Autocomplete ═══════════════════════
  // ═══ #8: Slash Command Autocomplete ═══════════════════════

  // Built-in slash commands (always available)

  // Dynamic slash commands populated from installed extensions (e.g. /tldr)

  // Full slash command list (builtins + extensions, with extensions first for dedup)
export function getSlashCommands() {
    var all = [];
    var seen = {};
    // Extensions come first so they take precedence
    state.extensionSlashCommands.forEach(function (sc) {
      seen[sc.cmd] = true;
      all.push(sc);
    });
    state.builtinSlashCommands.forEach(function (sc) {
      if (!seen[sc.cmd]) {
        all.push(sc);
      }
    });
    return all;
  }

  // Slash commands that should be handled locally (not sent to LLM)

export function handleSlashCommandsUpdate(data) {
    if (data && data.commands && Array.isArray(data.commands)) {
      state.extensionSlashCommands = data.commands;
      // Re-filter autocomplete if it's currently open
      if (state.slashAutocompleteOpen) {
        updateSlashAutocomplete(state.slashFilter);
      }
    }
  }

export function updateSlashAutocomplete(filter) {
    if (!filter || filter.length === 0) {
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    var f = filter.toLowerCase();
    var matches = getSlashCommands().filter(function (sc) { return sc.cmd.toLowerCase().indexOf(f) === 0; });
    if (matches.length === 0) {
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    state.slashAutocomplete.classList.add("visible");
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
    state.slashAutocomplete.innerHTML = html;

    // Wire click handlers
    var items = state.slashAutocomplete.querySelectorAll(".slash-item");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var cmd = item.getAttribute("data-cmd");
        if (cmd) {
          state.promptInput.value = cmd + " ";
          state.promptInput.focus();
          resizePromptInput();
        }
        state.slashAutocomplete.classList.remove("visible");
        state.slashAutocompleteOpen = false;
      });
    });
  }

  // ═══ #9: Scroll-to-entry ═══════════════════════════════════
  // ═══ #9: Scroll-to-entry ═══════════════════════════════════

export function handleRevealEntry(entryId) {
    if (!entryId) {return;}

    // Try multiple ID formats: entry-<id>, tool-<id>, bash-<id>
    var selectors = [
      "entry-" + entryId,
      "tool-" + entryId,
      "bash-" + entryId,
    ];
    var el = null;
    for (var i = 0; i < selectors.length; i++) {
      el = document.getElementById(selectors[i]);
      if (el) {break;}
    }

    if (!el) {return;}

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

export function handleBashStart(data) {
    // Stop thinking spinner — bash execution means thinking is done
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) {thSpinner.remove();}
    }

    var callId = data.toolCallId;

    // DEDUP: If tool-start already created a block for this callId, don't create a second.
    if (state.currentToolBlocks[callId]) {
      var entry = state.currentToolBlocks[callId];
      state.bashBlocks[callId] = entry.el || entry;
      state.bashOutputs[callId] = state.bashOutputs[callId] || "";
      return;
    }
    if (state.bashBlocks[callId]) {return;}

    var block = bashToolRenderer.create({
      toolName: "bash",
      toolCallId: callId,
      args: { command: data.command || "" },
      entryId: data.entryId,
      fromMessage: false,
    });
    state.chatContainer.appendChild(block);
    state.bashBlocks[callId] = block;
    state.bashOutputs[callId] = "";
    state.chatContainer.scrollTop = state.chatContainer.scrollHeight;
    scrollToBottom();
  }

export function handleBashOutput(data) {
    var callId = data.toolCallId;
    var block = state.bashBlocks[callId];
    if (!block) {
      var entry = state.currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      if (!block) {return;}
    }
    state.bashOutputs[callId] = (state.bashOutputs[callId] || "") + (data.output || "");
    var outEl = block.querySelector(".bash-output");
    if (outEl) {morphRender(outEl, escapeHtml(state.bashOutputs[callId]));}
    scrollToBottom();
  }

export function handleBashEnd(data) {
    var callId = data.toolCallId;
    var block = state.bashBlocks[callId];
    if (!block) {
      var entry = state.currentToolBlocks[callId];
      block = entry ? (entry.el || entry) : null;
      if (!block) {return;}
    }
    var result = {
      content: data.output ? [{ type: "text", text: data.output }] : [],
      details: { exitCode: data.exitCode, cancelled: data.cancelled },
    };
    bashToolRenderer.finalize(block, result, data.isError, data.entryId);
    delete state.currentToolBlocks[callId];
    delete state.bashBlocks[callId];
    delete state.bashOutputs[callId];
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

export function handleDebugCommand() {
    hideWelcome();
    var summary = window.__piDebug.summary() as { chat: any; dupes: string[]; orphanBash: string[]; orphanTool: string[]; lastEvents: any[]; lastDomChanges: any[] };

    // Also log to console so DevTools users can inspect without copy-paste
    console.log("[pi-debug] === Webview State Dump ===");
    console.log("[pi-debug] Chat structure:", JSON.stringify(summary.chat, null, 2));
    console.log("[pi-debug] Dupes (in both trackers):", summary.dupes);
    console.log("[pi-debug] Orphan state.bashBlocks:", summary.orphanBash);
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
      '<div class="debug-output">' +

      '<h4>Chat Container</h4>' +
      '<pre>' +
      escapeHtml(JSON.stringify(summary.chat, null, 2)) +
      '</pre>' +

      '<h4>Tracker State</h4>' +
      '<pre>' +
      'state.bashBlocks: ' + JSON.stringify(Object.keys(state.bashBlocks)) + '\n' +
      'state.currentToolBlocks: ' + JSON.stringify(Object.keys(state.currentToolBlocks)) + '\n' +
      'state.bashOutputs: ' + JSON.stringify(Object.keys(state.bashOutputs)) + '\n' +
      'Duplicates: ' + JSON.stringify(summary.dupes) + '\n' +
      'Orphan bash: ' + JSON.stringify(summary.orphanBash) + '\n' +
      'Orphan tool: ' + JSON.stringify(summary.orphanTool) +
      '</pre>' +

      '<h4>Last 20 Events</h4>' +
      '<pre class="scrollable">' +
      escapeHtml(JSON.stringify(summary.lastEvents, null, 2)) +
      '</pre>' +

      '<h4>Queue / Steer State</h4>' +
      '<pre>' +
      'state.isStreaming: ' + state.isStreaming + '\n' +
      'state.queueMode: ' + state.queueMode + '\n' +
      'pending-queue-indicator exists: ' + !!document.getElementById("pending-queue-indicator") + '\n' +
      'queue events (' + ((window.__piDebug._queueEvents || []).length) + '): ' + JSON.stringify((window.__piDebug._queueEvents || []).slice(-10), null, 2) + '\n' +
      '</pre>' +

      '<h4>Last 20 DOM Mutations</h4>' +
      '<pre class="scrollable">' +
      escapeHtml(JSON.stringify(summary.lastDomChanges, null, 2)) +
      '</pre>' +

      '<p class=\"debug-tip\">' +
      'Tip: <code>window.__piDebug.summary()</code> in DevTools, or <code>/debug</code> again.' +
      '</p>' +

      '</div>' +
      '</details>' +
      '</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();
  }
