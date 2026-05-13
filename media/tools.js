(function () {
  "use strict";

  // ── Dependencies ────────────────────────────────────────
  var state = window.__pi.state;
  var core = window.__pi.core;
  var tools = window.__pi.tools = {};

  // ── Local aliases (state) ───────────────────────────────
  var chatContainer = state.chatContainer;
  var currentToolBlocks = state.currentToolBlocks;
  var bashBlocks = state.bashBlocks;
  var bashOutputs = state.bashOutputs;

  // ── Local aliases (core functions) ──────────────────────
  var createToolBlock = core.createToolBlock;
  var morphRender = core.morphRender;
  var escapeHtml = core.escapeHtml;
  var renderToolResult = core.renderToolResult;
  var renderFileContent = core.renderFileContent;
  var renderDiffMarkup = core.renderDiffMarkup;
  var renderDiffIfApplicable = core.renderDiffIfApplicable;
  var formatToolError = core.formatToolError;
  var getLangFromPath = core.getLangFromPath;
  var getCompactReadLabel = core.getCompactReadLabel;
  var renderMarkdown = core.renderMarkdown;
  var debugLogEvent = core.debugLogEvent;
  var hideWelcome = core.hideWelcome;
  var scrollToBottom = core.scrollToBottom;
  var registerToolRenderer = core.registerToolRenderer;
  var getToolRenderer = core.getToolRenderer;

  // ═══ Write Tool Renderer ══════════════════════════════════
  //
  // Shows file content inline with syntax highlighting as the
  // model streams the write call.  The result area only shows
  // error output (matching the pi TUI behaviour).

  var writeToolRenderer = {
    create: function (data) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "tool-block";
      block.id = data.entryId ? "entry-" + data.entryId : "tool-" + data.toolCallId;
      block.setAttribute("data-status", "running");

      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var fileContent = data.args && data.args.content;
      var pathDisplay = rawPath || "...";
      var lang = rawPath ? getLangFromPath(rawPath) : undefined;

      block.innerHTML =
        '<div class="tool-header">' +
        '<span class="tool-name">write</span>' +
        '<span class="tool-path" data-path="' + escapeHtml(rawPath || "") + '" title="Click to open file">' + escapeHtml(pathDisplay) + '</span>' +
        '<span class="tool-status running">running</span>' +
        '</div>' +
        '<div class="tool-content"></div>' +
        '<div class="tool-result"></div>';

      block._writeState = { lang: lang, content: "", rawPath: rawPath };

      if (typeof fileContent === "string" && fileContent) {
        block._writeState.content = fileContent;
        renderWriteContentBlock(block);
      }

      return block;
    },
    update: function (el, partialResult) {
      if (!partialResult || !partialResult.content) return;
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) return;

      // rAF-batched: accumulate latest args JSON, flush once per frame.
      // Prevents bursty re-renders when write-tool args stream token by token.
      el._writePending = text;
      if (!el._writeRafId) {
        el._writeRafId = requestAnimationFrame(function () {
          el._writeRafId = null;
          if (el._writePending) {
            processWriteUpdate(el, el._writePending);
            el._writePending = null;
          }
        });
      }
    },
    finalize: function (el, result, isError, entryId) {
      // Flush any pending rAF render
      if (el._writeRafId) { cancelAnimationFrame(el._writeRafId); el._writeRafId = null; }
      if (el._writePending) { processWriteUpdate(el, el._writePending); el._writePending = null; }

      var statusEl = el.querySelector(".tool-status");
      if (statusEl) {
        statusEl.textContent = isError ? "error" : "done";
        statusEl.className = "tool-status " + (isError ? "error" : "success");
      }
      el.setAttribute("data-status", isError ? "error" : "done");
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }

      // Only show error output (matching TUI: result hidden on success)
      if (isError && result && result.content) {
        var errorText = result.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
        var tr = el.querySelector(".tool-result");
        if (tr && errorText) {
          tr.innerHTML = '<div style="color:var(--vscode-errorForeground);margin-top:6px;white-space:pre-wrap;font-size:0.85em;">' + escapeHtml(formatToolError(errorText, "write")) + '</div>';
        }
      }
    },
  };

  /** Process a write tool update from streaming JSON args. */
  function processWriteUpdate(el, text) {
    try {
      var args = JSON.parse(text);
      if (args.content && typeof args.content === "string") {
        el._writeState.content = args.content;
        renderWriteContentBlock(el);
      }
      if (args.path) {
        el._writeState.rawPath = args.path;
        el._writeState.lang = getLangFromPath(args.path);
        var pathEl = el.querySelector(".tool-path");
        if (pathEl) pathEl.textContent = args.path;
      }
    } catch (e) {
      // JSON incomplete (mid-stream) — try heuristic extraction of content
      var match = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) {
        el._writeState.content = match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        renderWriteContentBlock(el);
      }
    }
  }

  /** Update the .tool-content area of a write block with highlighted file content. */
  function renderWriteContentBlock(el) {
    var tc = el.querySelector(".tool-content");
    if (!tc) return;
    var state = el._writeState || {};
    var content = state.content || "";
    var lang = state.lang;
    var displayContent = content;
    var maxCollapsedLines = 10;
    var allLines = content.split("\n");
    var collapsed = allLines.length > maxCollapsedLines + 5;

    if (collapsed) {
      displayContent = allLines.slice(0, maxCollapsedLines).join("\n");
    }

    tc.innerHTML = renderFileContent(displayContent, lang);
    tc.scrollTop = tc.scrollHeight;

    if (collapsed) {
      var remaining = allLines.length - maxCollapsedLines;
      tc.innerHTML += '<div style="text-align:center;margin-top:4px;">' +
        '<button class="tool-expand-btn" type="button">' +
        '\u25BC ' + remaining + ' more lines (' + allLines.length + ' total)' +
        '</button></div>';

      // Wire the expand button
      var btn = tc.querySelector(".tool-expand-btn");
      if (btn) {
        btn.addEventListener("click", function () {
          tc.innerHTML = renderFileContent(content, lang);
          tc.scrollTop = tc.scrollHeight;
          var collapsedBtn = tc.querySelector(".tool-expand-btn");
          if (!collapsedBtn) {
            tc.innerHTML += '<div style="text-align:center;margin-top:4px;">' +
              '<button class="tool-expand-btn" type="button">\u25B2 Show less</button></div>';
            var cb = tc.querySelector(".tool-expand-btn");
            if (cb) {
              cb.addEventListener("click", function () {
                renderWriteContentBlock(el);
              });
            }
          }
        });
      }
    }
  }

  // ═══ Edit Tool Renderer ══════════════════════════════════
  //
  // Shows each edit as a mini-diff with word-level change
  // highlighting in the call block.  The result area shows the
  // actual computed diff when execution finishes.

  var editToolRenderer = {
    create: function (data) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "tool-block";
      block.id = data.entryId ? "entry-" + data.entryId : "tool-" + data.toolCallId;
      block.setAttribute("data-status", "running");

      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var edits = data.args && data.args.edits;
      var pathDisplay = rawPath || "...";
      var editCount = Array.isArray(edits) ? edits.length : 0;
      var editLabel = editCount > 1 ? " (" + editCount + " edits)" : "";

      block.innerHTML =
        '<div class="tool-header">' +
        '<span class="tool-name">edit</span>' +
        '<span class="tool-path" data-path="' + escapeHtml(rawPath || "") + '" title="Click to open file">' + escapeHtml(pathDisplay) + editLabel + '</span>' +
        '<span class="tool-status running">running</span>' +
        '</div>' +
        '<div class="tool-content"></div>' +
        '<div class="tool-result"></div>';

      if (Array.isArray(edits) && edits.length > 0) {
        renderEditPreviews(block, edits);
      }

      return block;
    },
    update: function (el, partialResult) {
      if (!partialResult || !partialResult.content) return;
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) return;

      try {
        var args = JSON.parse(text);
        var edits = args.edits;
        if (Array.isArray(edits) && edits.length > 0) {
          // Update edit count in header
          var editLabel = edits.length > 1 ? " (" + edits.length + " edits)" : "";
          var pathEl = el.querySelector(".tool-path");
          if (pathEl) pathEl.textContent = (args.path || "...") + editLabel;
          renderEditPreviews(el, edits);
        }
      } catch (e) {
        // JSON incomplete — ignore
      }
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
      if (!text && result && typeof result.text === "string") text = result.text;
      if (!text && result && typeof result === "string") text = result;
      if (!text && result && result.content && result.content.length > 0) {
        try { text = JSON.stringify(result.content, null, 2); } catch (e) {}
      }

      var tr = el.querySelector(".tool-result");
      if (tr && text) {
        if (isError) {
          tr.innerHTML = '<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;">' + escapeHtml(formatToolError(text, "edit")) + '</div>';
        } else {
          tr.innerHTML = '<div style="margin-top:4px;">' + renderDiffIfApplicable(text) + '</div>';
        }
      }
    },
  };

  /** Render per-edit mini-diffs into the .tool-content of an edit block. */
  function renderEditPreviews(el, edits) {
    var tc = el.querySelector(".tool-content");
    if (!tc) return;
    var maxVisible = 3;  // Show at most 3 edit previews inline
    var html = "";
    var remaining = edits.length - maxVisible;

    for (var i = 0; i < Math.min(edits.length, maxVisible); i++) {
      var edit = edits[i];
      var oldText = edit.oldText || "";
      var newText = edit.newText || "";
      html += '<div class="edit-change">';
      if (edits.length > 1) {
        html += '<div class="edit-header">Edit ' + (i + 1) + ' of ' + edits.length + '</div>';
      }
      html += '<div class="edit-old">- ' + escapeHtml(oldText.slice(0, 300)) + (oldText.length > 300 ? '\u2026' : '') + '</div>';
      html += '<div class="edit-new">+ ' + escapeHtml(newText.slice(0, 300)) + (newText.length > 300 ? '\u2026' : '') + '</div>';
      html += '</div>';
    }

    if (remaining > 0) {
      html += '<div style="text-align:center;margin-top:4px;font-size:0.85em;color:var(--vscode-descriptionForeground);">' +
        '\u2026 ' + remaining + ' more edit(s) not shown' +
        '</div>';
    }

    tc.innerHTML = html;
    tc.scrollTop = tc.scrollHeight;
  }

  // ═══ Read Tool Renderer ═══════════════════════════════════
  //
  // Shows the file path with optional line range in the header.
  // Results are syntax-highlighted from the file extension with
  // expand / collapse for long content.  Compact labels are used
  // for SKILL.md, AGENTS.md, and other resource files.

  var readToolRenderer = {
    create: function (data) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "tool-block";
      block.id = data.entryId ? "entry-" + data.entryId : "tool-" + data.toolCallId;
      block.setAttribute("data-status", "running");

      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var offset = data.args && data.args.offset;
      var limit = data.args && data.args.limit;
      var pathDisplay = rawPath || "...";
      var rangeLabel = "";
      if (offset !== undefined) {
        rangeLabel = ":" + offset;
        if (limit !== undefined) rangeLabel += "-" + (offset + limit - 1);
      }

      var compact = getCompactReadLabel(rawPath);

      block.innerHTML =
        '<div class="tool-header">' +
        '<span class="tool-name">read</span>' +
        '<span class="tool-path" data-path="' + escapeHtml(rawPath || "") + '" title="Click to open file">' + escapeHtml(pathDisplay) + rangeLabel + '</span>' +
        '<span class="tool-status running">running</span>' +
        '</div>' +
        (compact ? '<div class="compact-label">[' + compact.kind + '] ' + escapeHtml(compact.label) + '</div>' : '') +
        '<div class="tool-content"></div>' +
        '<div class="tool-result"></div>';

      // Store path for result rendering
      block._readState = { rawPath: rawPath, lang: rawPath ? getLangFromPath(rawPath) : undefined, compact: compact };

      return block;
    },
    update: function (el, partialResult) {
      // Read tool results come via tool-end, not incremental updates
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
      if (!tr) return;

      if (isError) {
        tr.innerHTML = '<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;">' + escapeHtml(formatToolError(text, "read")) + '</div>';
        return;
      }

      if (!text) {
        tr.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:0.85em;">(empty)</div>';
        return;
      }

      var state = el._readState || {};
      var lang = state.lang;

      // For read results, render with syntax highlighting inline (not as markdown code block)
      var lines = text.split("\n");
      var maxCollapsed = 10;
      var collapsed = lines.length > maxCollapsed + 5;

      if (collapsed) {
        var previewLines = lines.slice(0, maxCollapsed);
        var previewText = previewLines.join("\n");
        var remaining = lines.length - maxCollapsed;

        // Store state on the element for simple toggle
        el._readCollapseState = {
          previewText: previewText,
          fullText: text,
          lang: lang,
          remaining: remaining,
          totalLines: lines.length,
          expanded: false,
        };

        tr.innerHTML = '<div class="tool-result-collapsed" style="max-height:220px;overflow-y:auto;">' +
          renderMarkdown(text) +
          '</div>' +
          '<button class="tool-expand-btn" type="button">' +
          '\u25BC ' + remaining + ' more lines (' + lines.length + ' total)' +
          '</button>';

        var btn = tr.querySelector(".tool-expand-btn");
        if (btn) {
          function toggleReadCollapse() {
            var st = el._readCollapseState;
            if (!st) return;
            st.expanded = !st.expanded;
            if (st.expanded) {
              // For markdown files, render instead of showing code
              var expandedContent = (st.lang === "markdown" || st.lang === "md")
                ? renderMarkdown(st.fullText)
                : renderFileContent(st.fullText, st.lang);
              tr.innerHTML = expandedContent +
                '<button class="tool-expand-btn" type="button">\u25B2 Show less</button>';
              tr.scrollTop = 0;
            } else {
              tr.innerHTML = '<div class="tool-result-collapsed" style="max-height:220px;overflow-y:auto;">' +
                renderMarkdown(st.fullText) +
                '</div>' +
                '<button class="tool-expand-btn" type="button">' +
                '\u25BC ' + st.remaining + ' more lines (' + st.totalLines + ' total)' +
                '</button>';
            }
            var newBtn = tr.querySelector(".tool-expand-btn");
            if (newBtn) newBtn.addEventListener("click", toggleReadCollapse);
            if (!st.expanded) {
              tr.scrollTop = 0;
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }
          btn.addEventListener("click", toggleReadCollapse);
        }
      } else {
        tr.innerHTML = renderFileContent(text, lang);
      }

      // Truncation note from details
      if (result && result.details && result.details.truncation) {
        var t = result.details.truncation;
        if (t.truncated) {
          var note = '<div style="margin-top:6px;font-size:0.8em;color:var(--vscode-editorWarning-foreground);">';
          if (t.truncatedBy === "lines") {
            note += '[' + t.outputLines + ' of ' + t.totalLines + ' lines shown (line limit)]';
          } else {
            note += '[Truncated: ' + t.outputLines + ' lines shown]';
          }
          note += '</div>';
          tr.innerHTML += note;
        }
      }
    },
  };

  // ── Default (generic) tool renderer ──────────────────────
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
      morphRender(tr, renderToolResult(displayText));
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
        if (isError) {
          var displayText = formatToolError(text, el.querySelector(".tool-name") ? el.querySelector(".tool-name").textContent : "");
          tr.innerHTML = '<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;margin-top:4px;">' + escapeHtml(displayText) + '</div>';
        } else {
          var lines = text.split("\n");
          tr.innerHTML = lines.length > 50 ? renderToolResultTruncated(text) : renderToolResult(text);
        }
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
      if (outEl && text) morphRender(outEl, escapeHtml(text));
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
  registerToolRenderer("write", writeToolRenderer);
  registerToolRenderer("edit", editToolRenderer);
  registerToolRenderer("read", readToolRenderer);

  // ═══ Message Renderer Registry ════════════════════════════
  // ═══ Tool Lifecycle ════════════════════════════════════

  function handleToolStart(data) {
    hideWelcome();

    // Stop thinking spinner — tool execution means thinking is done
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) thSpinner.remove();
    }

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
      // If the new data has a path but the existing block shows "...", update it
      var newPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      if (newPath && block) {
        var pathEl = block.querySelector(".tool-path");
        if (pathEl && pathEl.textContent === "...") {
          pathEl.textContent = newPath;
          pathEl.setAttribute("data-path", newPath);
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
    // Ensure thinking spinner stays hidden during tool execution
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) thSpinner.remove();
    }

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
        return;
      }
      // Second fallback: find block by DOM ID (tool-{callId} or entry-{entryId})
      var domBlock = document.getElementById("tool-" + callId) || (data.entryId ? document.getElementById("entry-" + data.entryId) : null);
      if (domBlock) {
        debugLogEvent("tool-end:FALLBACK-DOM", { callId: callId, tag: domBlock.tagName, classes: domBlock.className });
        // Use defaultToolRenderer to finalize
        defaultToolRenderer.finalize(domBlock, data.result, data.isError, data.entryId);
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

  // ── Export tool renderers ────────────────────────────────
  tools.defaultToolRenderer = typeof defaultToolRenderer !== "undefined" ? defaultToolRenderer : null;
  tools.bashToolRenderer = typeof bashToolRenderer !== "undefined" ? bashToolRenderer : null;
  tools.writeToolRenderer = typeof writeToolRenderer !== "undefined" ? writeToolRenderer : null;
  tools.editToolRenderer = typeof editToolRenderer !== "undefined" ? editToolRenderer : null;
  tools.readToolRenderer = typeof readToolRenderer !== "undefined" ? readToolRenderer : null;
  tools.handleToolStart = typeof handleToolStart !== "undefined" ? handleToolStart : null;
  tools.handleToolUpdate = typeof handleToolUpdate !== "undefined" ? handleToolUpdate : null;
  tools.handleToolEnd = typeof handleToolEnd !== "undefined" ? handleToolEnd : null;
  tools.handleBashStart = typeof handleBashStart !== "undefined" ? handleBashStart : null;
  tools.handleBashOutput = typeof handleBashOutput !== "undefined" ? handleBashOutput : null;
  tools.handleBashEnd = typeof handleBashEnd !== "undefined" ? handleBashEnd : null;

})();
