import { state } from "../state.js";
import { logEvent } from "../debug.js";
import {
  createToolBlock, morphRender, escapeHtml, renderToolResult,
  renderFileContent, renderDiffMarkup, renderDiffIfApplicable,
  formatToolError, getLangFromPath, getCompactReadLabel,
  renderMarkdown, renderMarkdownSafe, hideWelcome, scrollToBottom, renderToolResultTruncated,
  registerToolRenderer, getToolRenderer,
} from "../render/engine.js";
import { highlightCode } from "../highlight.js";





  // ═══ Write Tool Renderer ══════════════════════════════════
  //
  // Shows file content inline with syntax highlighting as the
  // model streams the write call.  The result area only shows
  // error output (matching the pi TUI behaviour).

export const writeToolRenderer = {
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
      if (!partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) {return;}

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

      // Re-render final content, scroll to top
      renderWriteContentBlock(el);
      var sv = el.querySelector(".tool-scroll-view");
      if (sv) { sv.scrollTop = 0; }

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
export function processWriteUpdate(el, text) {
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
        if (pathEl) {pathEl.textContent = args.path;}
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
export function renderWriteContentBlock(el) {
    var tc = el.querySelector(".tool-content");
    if (!tc) {return;}
    var writeState = el._writeState || {};
    var content = writeState.content || "";
    var lang = writeState.lang;
    var active = el.getAttribute("data-status") !== "done" && el.getAttribute("data-status") !== "error";

    // Fixed-size scrollable container — same height active and done.
    // The code block is rendered at full natural height inside a scroll-view
    // that caps the visible area.  Auto-scrolls to bottom during streaming.
    var scrollView = tc.querySelector(".tool-scroll-view");
    if (!scrollView) {
      tc.innerHTML = '<div class="tool-scroll-view" style="max-height:15rem;overflow-y:auto;">'
        + renderFileContent(content, lang) + '</div>';
      scrollView = tc.querySelector(".tool-scroll-view");
    } else {
      // Persist the .code-block so scroll state survives across renders
      var cb = scrollView.querySelector(".code-block");
      if (!cb) {
        scrollView.innerHTML = renderFileContent(content, lang);
      } else {
        var tmp = document.createElement("div");
        tmp.innerHTML = renderFileContent(content, lang);
        var freshCode = tmp.querySelector(".code-block code");
        var existingCode = cb.querySelector("code");
        if (freshCode && existingCode) {
          existingCode.innerHTML = freshCode.innerHTML;
        }
      }
    }

    if (active) {
      scrollView.scrollTop = scrollView.scrollHeight;
    }
  }

  // ═══ Edit Tool Renderer ══════════════════════════════════
  //
  // Shows each edit as a mini-diff with word-level change
  // highlighting in the call block.  The result area shows the
  // actual computed diff when execution finishes.

export const editToolRenderer = {
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
        block._editEdits = edits;
        block._editLang = rawPath ? getLangFromPath(rawPath) : undefined;
        renderEditPreviews(block, edits);
      }

      return block;
    },
    update: function (el, partialResult) {
      if (!partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) {return;}

      try {
        var args = JSON.parse(text);
        var edits = args.edits;
        if (Array.isArray(edits) && edits.length > 0) {
          el._editEdits = edits;
          // Update edit count in header
          var editLabel = edits.length > 1 ? " (" + edits.length + " edits)" : "";
          var pathEl = el.querySelector(".tool-path");
          if (pathEl) {pathEl.textContent = (args.path || "...") + editLabel;}
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

      // Re-render previews to collapse to max 3 now that streaming is done
      if (el._editEdits) { renderEditPreviews(el, el._editEdits); }

      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c) { return c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("\n");
      }
      if (!text && result && typeof result.text === "string") {text = result.text;}
      if (!text && result && typeof result === "string") {text = result;}
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
export function renderEditPreviews(el, edits) {
    var tc = el.querySelector(".tool-content");
    if (!tc) {return;}
    var active = el.getAttribute("data-status") !== "done" && el.getAttribute("data-status") !== "error";
    var lang = el._editLang;
    var maxVisible = active ? edits.length : Math.min(edits.length, 3);
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
      html += '<div class="edit-old">- ' + (lang ? highlightCode(oldText, lang) : escapeHtml(oldText)) + '</div>';
      html += '<div class="edit-new">+ ' + (lang ? highlightCode(newText, lang) : escapeHtml(newText)) + '</div>';
      html += '</div>';
    }

    if (remaining > 0) {
      html += '<div style="text-align:center;margin-top:4px;font-size:0.85em;color:var(--vscode-descriptionForeground);">' +
        '\u2026 ' + remaining + ' more edit(s) not shown' +
        '</div>';
    }

    // Persistent scroll wrapper — same whether active or done (no morph).
    var scrollView = tc.querySelector(".tool-scroll-view");
    if (!scrollView) {
      tc.innerHTML = '<div class="tool-scroll-view" style="max-height:15rem;overflow-y:auto;">' + html + '</div>';
      scrollView = tc.querySelector(".tool-scroll-view");
    } else {
      scrollView.innerHTML = html;
    }

    if (active && scrollView) {
      scrollView.scrollTop = scrollView.scrollHeight;
      requestAnimationFrame(function () {
        var blocks = scrollView.querySelectorAll(".edit-old, .edit-new");
        for (var b = 0; b < blocks.length; b++) {
          if (blocks[b].scrollHeight > blocks[b].clientHeight) {
            blocks[b].scrollTop = blocks[b].scrollHeight;
          }
        }
      });
    }
  }

  // ═══ Read Tool Renderer ═══════════════════════════════════
  //
  // Shows the file path with optional line range in the header.
  // Results are syntax-highlighted from the file extension with
  // expand / collapse for long content.  Compact labels are used
  // for SKILL.md, AGENTS.md, and other resource files.

export const readToolRenderer = {
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
        if (limit !== undefined) {rangeLabel += "-" + (offset + limit - 1);}
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
      if (!tr) {return;}

      if (isError) {
        tr.innerHTML = '<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;">' + escapeHtml(formatToolError(text, "read")) + '</div>';
        return;
      }

      if (!text) {
        tr.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:0.85em;">(empty)</div>';
        return;
      }

      var readState = el._readState || {};
      var lang = readState.lang;

      // Syntax-highlighted code in scrollable container.
      tr.style.maxHeight = "15rem";
      tr.innerHTML = renderFileContent(text, lang);
      var cb = tr.querySelector(".code-block");
      if (cb) { cb.style.maxHeight = "none"; cb.style.overflowY = "visible"; }

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
          tc.innerHTML += note;
        }
      }
    },
  };

  // ── Default (generic) tool renderer ──────────────────────
  // ── Default (generic) tool renderer ──────────────────────

export const defaultToolRenderer = {
    create: function (data) {
      return createToolBlock(data.toolName, data.toolCallId, "pending", data.args);
    },
    update: function (el, partialResult) {
      var tr = el.querySelector(".tool-result");
      if (!tr || !partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c) { return c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("\n");
      if (!text) {return;}
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

export const bashToolRenderer = {
    create: function (data) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "bash-execution";
      block.id = data.entryId ? "entry-" + data.entryId : "bash-" + data.toolCallId;
      block.setAttribute("data-status", "running");
      var cmd = data.args && data.args.command ? data.args.command : "";
      if (cmd.length > 120) {cmd = cmd.slice(0, 120) + "\u2026";}
      block.innerHTML =
        '<div class="bash-header">$ ' + escapeHtml(cmd) + '</div>' +
        '<div class="bash-output"></div>' +
        '<div class="bash-footer"><span class="bash-spinner"></span> <span class="cancel-hint">running\u2026</span></div>';
      state.bashBlocks[data.toolCallId] = block;
      state.bashOutputs[data.toolCallId] = "";
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
      if (outEl && text) {morphRender(outEl, escapeHtml(text));}
      var footer = el.querySelector(".bash-footer");
      var details = result && result.details ? result.details : {};
      var exitCode = details.exitCode !== undefined ? details.exitCode : 0;
      if (footer) {
        footer.innerHTML =
          '<span class="exit-code' + (isError ? " error" : "") + '">exit: ' + exitCode + '</span>' +
          (details.cancelled ? ' <span>(cancelled)</span>' : "");
      }
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }
      el.setAttribute("data-status", isError ? "error" : "complete");
      delete state.bashBlocks[toolCallId];
      delete state.bashOutputs[toolCallId];
    },
  };

  registerToolRenderer("bash", bashToolRenderer);
  registerToolRenderer("write", writeToolRenderer);
  registerToolRenderer("edit", editToolRenderer);
  registerToolRenderer("read", readToolRenderer);

  // ═══ Message Renderer Registry ════════════════════════════
  // ═══ Tool Lifecycle ════════════════════════════════════

export function handleToolStart(data) {
    hideWelcome();

    // Stop thinking spinner — tool execution means thinking is done
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) {thSpinner.remove();}
    }

    var callId = data.toolCallId;
    logEvent("tool-start", {
      callId: callId,
      toolName: data.toolName,
      entryId: data.entryId,
      fromMessage: data.fromMessage,
      inToolBlocks: !!state.currentToolBlocks[callId],
      inBashBlocks: !!state.bashBlocks[callId],
    });

    // Guard against duplicates — check BOTH trackers (#fix: bash blocks
    // created by handleBashStart were invisible to this dedup, causing
    // orphaned duplicate DOM nodes that never finalize).
    var existingTool = state.currentToolBlocks[callId];
    var existingBash = state.bashBlocks[callId];

    if (existingTool || existingBash) {
      logEvent("tool-start:DEDUP", {
        callId: callId,
        inTool: !!existingTool,
        inBash: !!existingBash,
        bashStatus: existingBash ? (existingBash.getAttribute ? existingBash.getAttribute("data-status") : "?") : "N/A",
      });
      // If we have a bash block, promote it into currentToolBlocks so the
      // tool-end handler can finalize it through the normal path.
      if (existingBash && !existingTool) {
        state.currentToolBlocks[callId] = { el: existingBash, renderer: bashToolRenderer };
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
    state.chatContainer.appendChild(block);

    // Store both the element and its renderer for update/finalize
    state.currentToolBlocks[callId] = { el: block, renderer: renderer };

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

export function handleToolUpdate(data) {
    // Ensure thinking spinner stays hidden during tool execution
    if (state.currentThinkingEl) {
      var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
      if (thSpinner) {thSpinner.remove();}
    }

    var entry = state.currentToolBlocks[data.toolCallId];
    if (!entry) {return;}
    var block = entry.el || entry;
    var renderer = entry.renderer || defaultToolRenderer;
    renderer.update(block, data.partialResult);
    scrollToBottom();
  }

export function handleToolEnd(data) {
    var callId = data.toolCallId;
    var entry = state.currentToolBlocks[callId];
    logEvent("tool-end", {
      callId: callId,
      found: !!entry,
      isError: !!data.isError,
      inBashBlocks: !!state.bashBlocks[callId],
      entryId: data.entryId,
    });
    if (!entry) {
      // Fallback: check bashBlocks for blocks created via the legacy path
      var bashBlock = state.bashBlocks[callId];
      if (bashBlock) {
        logEvent("tool-end:FALLBACK-BASH", { callId: callId });
        bashToolRenderer.finalize(bashBlock, data.result, data.isError, data.entryId);
        delete state.bashBlocks[callId];
        delete state.bashOutputs[callId];
        return;
      }
      // Second fallback: find block by DOM ID (tool-{callId} or entry-{entryId})
      var domBlock = document.getElementById("tool-" + callId) || (data.entryId ? document.getElementById("entry-" + data.entryId) : null);
      if (domBlock) {
        logEvent("tool-end:FALLBACK-DOM", { callId: callId, tag: domBlock.tagName, classes: domBlock.className });
        // Use defaultToolRenderer to finalize
        defaultToolRenderer.finalize(domBlock, data.result, data.isError, data.entryId);
      }
      return;
    }
    var block = entry.el || entry;
    var renderer = entry.renderer || defaultToolRenderer;
    renderer.finalize(block, data.result, data.isError, data.entryId);
    delete state.currentToolBlocks[callId];
    scrollToBottom();
  }

  // ═══ Session Events ════════════════════════════════════

  