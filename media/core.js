/*global acquireVsCodeApi*/
(function () {
  "use strict";

  // ── Shared namespace ────────────────────────────────────
  window.__pi = window.__pi || {};
  var state = window.__pi.state = {};
  var core = window.__pi.core = {};

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
  var steerDropdown = document.getElementById("steer-dropdown");
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

  // ── Helpers for tool content rendering ──────────────────
  // ── Error message formatting ────────────────────────────

  /** Replace raw SDK validation errors with user-friendly messages. */
  function formatToolError(text, toolName) {
    if (!text) return text;

    // SDK validation errors (model used wrong field names / structure)
    if (text.indexOf("Validation failed for tool") !== -1) {
      var issues = [];
      var missingRe = /must have required propert(?:y|ies) (\w+)/g;
      var extraRe = /must not have additional propert(?:y|ies)/g;
      var match;
      while ((match = missingRe.exec(text)) !== null) {
        issues.push("missing \u201C" + match[1] + "\u201D");
      }
      if (extraRe.test(text)) {
        // Extract the extra property name if possible
        var extraMatch = text.match(/additional properties.*?(\w+)/g);
        if (!extraMatch) issues.push("unexpected field(s)");
      }
      var hint = issues.length > 0
        ? " (" + issues.join(", ") + ")"
        : "";
      return "\u26A0 Argument structure mismatch" + hint + " \u2014 the agent will self-correct.";
    }

    // Aborted / cancelled
    if (/abort|aborted|cancell?ed/i.test(text)) {
      return "\u2717 Operation cancelled.";
    }

    // Permission / access errors
    if (/permission denied|EACCES|not permitted/i.test(text)) {
      return "\u26D4 Permission denied \u2014 cannot access the file.";
    }

    // File not found
    if (/no such file|ENOENT|not found/i.test(text) && text.indexOf("Validation") === -1) {
      return "\uD83D\uDD0D File not found \u2014 check the path.";
    }

    // Timeout
    if (/timed?\s*out/i.test(text)) {
      return "\u23F0 Command timed out.";
    }

    return text;
  }

  // ── Helpers for tool content rendering ──────────────────

  function shortenPath(filePath) {
    if (!filePath) return "";
    // Try to make path relative to common workspace indicators
    return filePath;
  }

  /** Map file extension to language for syntax highlighting. */
  function getLangFromPath(filePath) {
    if (!filePath) return undefined;
    var ext = filePath.split(".").pop().toLowerCase();
    var extToLang = {
      ts: "typescript", tsx: "typescript",
      js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      c: "c", h: "c",
      cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
      cs: "csharp",
      sh: "bash", bash: "bash", zsh: "bash",
      html: "html", htm: "html",
      css: "css", scss: "scss", less: "less",
      json: "json",
      yaml: "yaml", yml: "yaml",
      toml: "toml",
      xml: "xml", svg: "svg",
      md: "markdown", markdown: "markdown",
      sql: "sql",
      php: "php",
      rb: "ruby",
      swift: "swift",
      kt: "kotlin",
      lua: "lua",
      r: "r",
      scala: "scala",
      hs: "haskell",
      ex: "elixir", exs: "elixir",
      erl: "erlang",
      dockerfile: "dockerfile",
      makefile: "makefile",
      proto: "protobuf",
      graphql: "graphql",
      tf: "hcl", hcl: "hcl",
      ps1: "powershell",
    };
    return extToLang[ext];
  }

  /** Compact read classifications (skills/docs/resources get abbreviated labels). */
  function getCompactReadLabel(filePath) {
    if (!filePath) return undefined;
    var name = filePath.split("/").pop() || filePath;
    // SKILL.md files — show parent dir as label
    if (name === "SKILL.md") {
      var parts = filePath.split("/");
      var parent = parts.length >= 2 ? parts[parts.length - 2] : name;
      return { kind: "skill", label: parent };
    }
    // AGENTS.md, CLAUDE.md — show as resource
    if (name === "AGENTS.md" || name === "AGENTS.MD" || name === "CLAUDE.md" || name === "CLAUDE.MD") {
      return { kind: "resource", label: filePath };
    }
    // README.md or docs/ paths — show as docs
    if (name === "README.md" || filePath.indexOf("docs/") !== -1 || filePath.indexOf("examples/") !== -1) {
      return { kind: "docs", label: filePath };
    }
    return undefined;
  }

  /** Render file content with syntax-highlighted line numbers into a code-block-wrapper. */
  function renderFileContent(content, lang) {
    if (!content) return "";
    content = content.replace(/\r\n?/g, "\n");
    content = content.replace(/\n+$/, "");
    if (!content) return "";
    var lines = content.split("\n");
    var langLabel = lang ? '<span class="code-lang-label">' + escapeHtml(lang) + '</span>' : "";
    var numbered = lines.map(function (line) {
      return '<span class="code-ln"></span>' +
        '<span class="code-text" data-lang="' + escapeHtml(lang || "") + '">' +
        syntaxHighlightLine(line, lang) +
        '</span>';
    }).join("\n");
    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' + langLabel +
      '<button class="code-copy-btn" type="button">Copy</button></div>' +
      '<pre class="code-block" data-lang="' + escapeHtml(lang || "") + '"><code>' +
      numbered + '</code></pre></div>';
  }

  // ═══ Write Tool Renderer ══════════════════════════════════
  function morphRender(el, html) {
    if (!el || html === undefined || html === null) return;
    var temp = document.createElement("div");
    temp.innerHTML = html;
    window.morphdom(el, temp, { childrenOnly: true });
  }

  // ── Error message formatting ────────────────────────────

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
  // ═══ UI Helpers — General ══════════════════════════════



  function createMessageEl(role) {
    var el = document.createElement("div");
    el.className = "message " + role;
    el.innerHTML = '<div class="message-content"></div>';
    return el;
  }

  function createThinkingBlock(content) {
    var el = document.createElement("div");
    el.className = "thinking-block thinking-collapsed";
    el.innerHTML =
      '<div class="thinking-header">' +
      '<span class="thinking-label">Thinking</span>' +
      '<span class="thinking-spinner"></span>' +
      '<span class="thinking-line-count"></span>' +
      '</div>' +
      '<div class="thinking-content">' +
      escapeHtml(content) +
      '</div>' +
      '<button class="thinking-expand-btn" style="display:none;">Show more</button>';
    // Wire expand button
    var btn = el.querySelector(".thinking-expand-btn");
    var contentEl = el.querySelector(".thinking-content");
    btn.addEventListener("click", function () {
      var wasCollapsed = el.classList.contains("thinking-collapsed");
      if (wasCollapsed) {
        el.classList.remove("thinking-collapsed");
        contentEl.classList.remove("overflowing");
        btn.textContent = "Show less";
      } else {
        el.classList.add("thinking-collapsed");
        btn.textContent = "Show more";
        contentEl.scrollTop = 0;
        if (contentEl.scrollHeight > contentEl.clientHeight + 2) {
          contentEl.classList.add("overflowing");
        }
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    return el;
  }

  function hideWelcome() {
    // During batch replay, keep welcome as loading screen
    if (state._inBatch) return;
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
      sendButton.textContent = "Steer";
      sendButton.title = "Steer (interrupt current request)";
      steerDropdown.classList.remove("hidden");
      abortButton.classList.remove("hidden");
    } else {
      sendButton.textContent = "↵";
      sendButton.title = "Submit (Enter)";
      steerDropdown.classList.add("hidden");
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
  // ═══ Markdown Rendering ═════════════════════════════════
  //
  // Code blocks get lang-aware, line-numbered, copyable editors.
  // We avoid complex dependencies — just clean HTML with proper CSS
  // and a "copy" button.  Users can click to open the snippet in
  // a real VS Code editor via the extension host.

  // ── Markdown rendering (marked-based) ─────────────────
  // Uses marked.parse() for correctness, then post-processes
  // to add custom code block wrappers, line numbers, and syntax
  // highlighting. Used for non-streaming contexts (user messages,
  // tool results, live cards, compaction summaries, etc.).

  /** Configure marked once at load time, or bail gracefully. */
  var _markedAvailable = typeof marked !== "undefined" && marked && marked.parse && marked.lexer;
  if (_markedAvailable) {
    marked.setOptions({ gfm: true, breaks: false });
  }

  /** Render markdown text to HTML string.
   *  Uses marked.parse() when available; falls back to plain escape. */
  function renderMarkdown(text) {
    if (!text) return "";
    if (!_markedAvailable) { return escapeHtml(text).replace(/\n/g, "<br>"); }
    var html = marked.parse(text);
    return postProcessMarkedHTML(html);
  }

  /** Post-process marked output: add code block wrappers, line
   *  numbers, syntax highlighting, and copy buttons. */
  function postProcessMarkedHTML(html) {
    // Replace marked's <pre><code> with our rich code block wrapper
    html = html.replace(
      /<pre><code(?: class="language-(\w*)")?>([\s\S]*?)<\/code><\/pre>/g,
      function (m, lang, code) {
        // Unescape HTML entities that marked re-escaped inside code
        var decoded = code
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        return renderCodeBlockHTML(decoded, lang || "");
      }
    );
    return html;
  }

  /** Build the rich code block HTML (wrapper, header, copy button,
   *  line numbers, syntax highlighting). */
  function renderCodeBlockHTML(code, lang) {
    code = code.replace(/\r\n?/g, "\n");
    code = code.replace(/\n+$/, "");
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
  }

  // ── Block-level rendering (for structured streaming) ───
  // These functions convert marked tokens directly to DOM nodes
  // instead of HTML strings, enabling incremental append during
  // streaming without full re-renders.

  /** Render a single marked token (block) to a DOM element. */
  function renderBlock(token) {
    var el;
    switch (token.type) {
      case "heading":
        el = document.createElement("h" + token.depth);
        el.innerHTML = renderInline(token.tokens);
        return el;

      case "paragraph":
        el = document.createElement("p");
        el.innerHTML = renderInline(token.tokens);
        return el;

      case "code":
        // Fenced code block — use our rich wrapper
        var wrapper = document.createElement("div");
        wrapper.innerHTML = renderCodeBlockHTML(token.text, token.lang || "");
        return wrapper.firstChild;

      case "list":
        el = document.createElement(token.ordered ? "ol" : "ul");
        for (var i = 0; i < token.items.length; i++) {
          var li = document.createElement("li");
          li.innerHTML = renderInline(token.items[i].tokens);
          el.appendChild(li);
        }
        return el;

      case "table":
        return renderTableBlock(token);

      case "blockquote":
        el = document.createElement("blockquote");
        for (var j = 0; j < token.tokens.length; j++) {
          el.appendChild(renderBlock(token.tokens[j]));
        }
        return el;

      case "hr":
        return document.createElement("hr");

      case "space":
        return document.createTextNode("");

      default:
        el = document.createElement("div");
        el.textContent = token.raw || "";
        return el;
    }
  }

  /** Render a marked table token to a <table> DOM element. */
  function renderTableBlock(token) {
    var table = document.createElement("table");

    // <thead>
    var thead = document.createElement("thead");
    var headerRow = document.createElement("tr");
    for (var h = 0; h < token.header.length; h++) {
      var th = document.createElement("th");
      th.style.textAlign = token.align[h] || "left";
      th.innerHTML = renderInline(token.header[h].tokens);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // <tbody>
    if (token.rows.length > 0) {
      var tbody = document.createElement("tbody");
      for (var r = 0; r < token.rows.length; r++) {
        var tr = document.createElement("tr");
        for (var c = 0; c < token.rows[r].length; c++) {
          var td = document.createElement("td");
          td.style.textAlign = token.align[c] || "left";
          td.innerHTML = renderInline(token.rows[r][c].tokens);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    return table;
  }

  /** Render inline tokens to an HTML string.
   *  Called by renderBlock for headings, paragraphs, list items, etc. */
  function renderInline(tokens) {
    if (!tokens || tokens.length === 0) return "";
    var html = "";
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      switch (t.type) {
        case "text":       html += escapeHtml(t.text); break;
        case "strong":     html += "<strong>" + renderInline(t.tokens) + "</strong>"; break;
        case "em":         html += "<em>" + renderInline(t.tokens) + "</em>"; break;
        case "codespan":   html += "<code>" + escapeHtml(t.text) + "</code>"; break;
        case "link":       html += '<a href="' + escapeHtml(t.href) + '">' + renderInline(t.tokens) + '</a>'; break;
        case "del":        html += "<del>" + renderInline(t.tokens) + "</del>"; break;
        case "image":      html += '<img src="' + escapeHtml(t.href) + '" alt="' + escapeHtml(t.text) + '">'; break;
        case "br":         html += "<br>"; break;
        case "html":       html += t.text || t.raw || ""; break;
        case "escape":     html += escapeHtml(t.text); break;
        default:           html += escapeHtml(t.raw || t.text || "");
      }
    }
    return html;
  }

  // ── Token-diff streaming ───────────────────────────────
  // During streaming, we re-lex the full accumulated text with
  // marked.lexer() on every frame, then diff the token lists:
  // - Completed blocks (all but last): static, untouched
  // - Last block: morphed in-place to reflect growing text
  // - New blocks: appended when they appear
  // - Type changes: morphdom replaces element (imperceptible at 60fps)

  var _streamPrevTokens = [];

  /** Diff prev/new token lists and patch the DOM container efficiently.
   *  Only modifies blocks that changed — typically just the last one.
   *  Falls back to full morphRender when marked is unavailable. */
  function patchBlockList(container, prevTokens, newTokens) {
    if (!_markedAvailable) {
      // Fallback: use the old full-render approach
      var raw = container.getAttribute("data-raw") || "";
      morphRender(container, renderMarkdown(raw));
      return;
    }
    // Remove stale blocks if newTokens is shorter (shouldn't happen normally)
    while (container.children.length > newTokens.length) {
      container.removeChild(container.lastChild);
    }

    // Patch existing blocks where content changed
    var commonLen = Math.min(prevTokens.length, newTokens.length);
    for (var i = 0; i < commonLen; i++) {
      var child = container.children[i];
      if (!child) {
        // Safety: missing child — append
        container.appendChild(renderBlock(newTokens[i]));
      } else if (prevTokens[i].raw !== newTokens[i].raw ||
                 prevTokens[i].type !== newTokens[i].type) {
        // Content or type changed — morph this single block
        morphRender(child, renderBlockToHTML(newTokens[i]));
      }
      // else: block is unchanged, skip
    }

    // Append new blocks
    for (var i = prevTokens.length; i < newTokens.length; i++) {
      container.appendChild(renderBlock(newTokens[i]));
    }
  }

  /** Render a single block token to an HTML string (for morphdom patching).
   *  This is the bridge between structured block rendering and morphdom's
   *  string-based diff. */
  function renderBlockToHTML(token) {
    var temp = document.createElement("div");
    temp.appendChild(renderBlock(token));
    return temp.innerHTML;
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
          previewEl.innerHTML = renderMarkdown(stored.preview);
          truncEl.setAttribute("data-expanded", "0");
          showMoreBtn.textContent = "\u25BC " + truncEl.getAttribute("data-hidden") + " more lines";
        } else {
          previewEl.innerHTML = renderMarkdown(stored.full);
          truncEl.setAttribute("data-expanded", "1");
          showMoreBtn.textContent = "\u25B2 Show less";
        }
        return;
      }

      var btn = e.target.closest(".code-copy-btn");
      if (!btn) {
        // Check for clickable tool-path (file link in tool headers)
        var pathEl = e.target.closest(".tool-path");
        if (pathEl && pathEl.dataset.path) {
          e.preventDefault();
          vscode.postMessage({ type: "openFile", path: pathEl.dataset.path });
        }
        return;
      }
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

  // ── Export state (object refs — mutations propagate) ────
  state.vscode = typeof vscode !== "undefined" ? vscode : null;
  state.welcome = typeof welcome !== "undefined" ? welcome : null;
  state.promptInput = typeof promptInput !== "undefined" ? promptInput : null;
  state.sendButton = typeof sendButton !== "undefined" ? sendButton : null;
  state.abortButton = typeof abortButton !== "undefined" ? abortButton : null;
  state.steerDropdown = typeof steerDropdown !== "undefined" ? steerDropdown : null;
  state.attachmentBar = typeof attachmentBar !== "undefined" ? attachmentBar : null;
  state.userMsgOverlay = typeof userMsgOverlay !== "undefined" ? userMsgOverlay : null;
  state.settingsOverlay = typeof settingsOverlay !== "undefined" ? settingsOverlay : null;
  state.slashAutocomplete = typeof slashAutocomplete !== "undefined" ? slashAutocomplete : null;
  state.livePanel = typeof livePanel !== "undefined" ? livePanel : null;
  state.liveCards = typeof liveCards !== "undefined" ? liveCards : null;
  state.chatContainer = typeof chatContainer !== "undefined" ? chatContainer : null;
  state.currentToolBlocks = typeof currentToolBlocks !== "undefined" ? currentToolBlocks : null;
  state.assistantToolCallIds = typeof assistantToolCallIds !== "undefined" ? assistantToolCallIds : null;
  state.attachments = typeof attachments !== "undefined" ? attachments : null;
  state.bashBlocks = typeof bashBlocks !== "undefined" ? bashBlocks : null;
  state.bashOutputs = typeof bashOutputs !== "undefined" ? bashOutputs : null;
  state.debugEventLog = typeof debugEventLog !== "undefined" ? debugEventLog : null;
  state.debugDomLog = typeof debugDomLog !== "undefined" ? debugDomLog : null;
  state.truncationTexts = typeof truncationTexts !== "undefined" ? truncationTexts : null;
  state.userMessageHistory = typeof userMessageHistory !== "undefined" ? userMessageHistory : null;
  state.settingsState = typeof settingsState !== "undefined" ? settingsState : null;
  state.scopedModels = typeof scopedModels !== "undefined" ? scopedModels : null;
  state.toolRenderers = typeof toolRenderers !== "undefined" ? toolRenderers : null;

  // ── Export state (primitives — getters for live reactivity) ──
  if (typeof isStreaming !== "undefined") Object.defineProperty(state, "isStreaming", { get: function() { return isStreaming; }, set: function(v) { isStreaming = v; }, enumerable: true, configurable: true });
  if (typeof isCompacting !== "undefined") Object.defineProperty(state, "isCompacting", { get: function() { return isCompacting; }, set: function(v) { isCompacting = v; }, enumerable: true, configurable: true });
  if (typeof isRetrying !== "undefined") Object.defineProperty(state, "isRetrying", { get: function() { return isRetrying; }, set: function(v) { isRetrying = v; }, enumerable: true, configurable: true });
  if (typeof lastUserMessageContent !== "undefined") Object.defineProperty(state, "lastUserMessageContent", { get: function() { return lastUserMessageContent; }, set: function(v) { lastUserMessageContent = v; }, enumerable: true, configurable: true });
  if (typeof userMessagesSeen !== "undefined") Object.defineProperty(state, "userMessagesSeen", { get: function() { return userMessagesSeen; }, set: function(v) { userMessagesSeen = v; }, enumerable: true, configurable: true });
  if (typeof debugEnabled !== "undefined") Object.defineProperty(state, "debugEnabled", { get: function() { return debugEnabled; }, set: function(v) { debugEnabled = v; }, enumerable: true, configurable: true });
  if (typeof debugMaxEvents !== "undefined") Object.defineProperty(state, "debugMaxEvents", { get: function() { return debugMaxEvents; }, set: function(v) { debugMaxEvents = v; }, enumerable: true, configurable: true });
  if (typeof debugMaxDomLog !== "undefined") Object.defineProperty(state, "debugMaxDomLog", { get: function() { return debugMaxDomLog; }, set: function(v) { debugMaxDomLog = v; }, enumerable: true, configurable: true });
  if (typeof truncationIdx !== "undefined") Object.defineProperty(state, "truncationIdx", { get: function() { return truncationIdx; }, set: function(v) { truncationIdx = v; }, enumerable: true, configurable: true });
  if (typeof settingsOpen !== "undefined") Object.defineProperty(state, "settingsOpen", { get: function() { return settingsOpen; }, set: function(v) { settingsOpen = v; }, enumerable: true, configurable: true });
  if (typeof userMsgSelectorOpen !== "undefined") Object.defineProperty(state, "userMsgSelectorOpen", { get: function() { return userMsgSelectorOpen; }, set: function(v) { userMsgSelectorOpen = v; }, enumerable: true, configurable: true });
  if (typeof slashAutocompleteOpen !== "undefined") Object.defineProperty(state, "slashAutocompleteOpen", { get: function() { return slashAutocompleteOpen; }, set: function(v) { slashAutocompleteOpen = v; }, enumerable: true, configurable: true });
  if (typeof slashFilter !== "undefined") Object.defineProperty(state, "slashFilter", { get: function() { return slashFilter; }, set: function(v) { slashFilter = v; }, enumerable: true, configurable: true });
  if (typeof slashSelectedIdx !== "undefined") Object.defineProperty(state, "slashSelectedIdx", { get: function() { return slashSelectedIdx; }, set: function(v) { slashSelectedIdx = v; }, enumerable: true, configurable: true });
  if (typeof _markedAvailable !== "undefined") Object.defineProperty(state, "_markedAvailable", { get: function() { return _markedAvailable; }, set: function(v) { _markedAvailable = v; }, enumerable: true, configurable: true });
  if (typeof _streamRafId !== "undefined") Object.defineProperty(state, "_streamRafId", { get: function() { return _streamRafId; }, set: function(v) { _streamRafId = v; }, enumerable: true, configurable: true });
  if (typeof _streamContentEl !== "undefined") Object.defineProperty(state, "_streamContentEl", { get: function() { return _streamContentEl; }, set: function(v) { _streamContentEl = v; }, enumerable: true, configurable: true });
  if (typeof _thinkingRafId !== "undefined") Object.defineProperty(state, "_thinkingRafId", { get: function() { return _thinkingRafId; }, set: function(v) { _thinkingRafId = v; }, enumerable: true, configurable: true });
  if (typeof _thinkingEl !== "undefined") Object.defineProperty(state, "_thinkingEl", { get: function() { return _thinkingEl; }, set: function(v) { _thinkingEl = v; }, enumerable: true, configurable: true });
  if (typeof hasScrolledUp !== "undefined") Object.defineProperty(state, "hasScrolledUp", { get: function() { return hasScrolledUp; }, set: function(v) { hasScrolledUp = v; }, enumerable: true, configurable: true });
  if (typeof currentAssistantEl !== "undefined") Object.defineProperty(state, "currentAssistantEl", { get: function() { return currentAssistantEl; }, set: function(v) { currentAssistantEl = v; }, enumerable: true, configurable: true });
  if (typeof currentThinkingEl !== "undefined") Object.defineProperty(state, "currentThinkingEl", { get: function() { return currentThinkingEl; }, set: function(v) { currentThinkingEl = v; }, enumerable: true, configurable: true });
  if (typeof _streamPrevTokens !== "undefined") Object.defineProperty(state, "_streamPrevTokens", { get: function() { return _streamPrevTokens; }, set: function(v) { _streamPrevTokens = v; }, enumerable: true, configurable: true });

  // ── Export core functions ───────────────────────────────
  core.renderMarkdown = typeof renderMarkdown !== "undefined" ? renderMarkdown : null;
  core.renderBlock = typeof renderBlock !== "undefined" ? renderBlock : null;
  core.renderInline = typeof renderInline !== "undefined" ? renderInline : null;
  core.renderCodeBlockHTML = typeof renderCodeBlockHTML !== "undefined" ? renderCodeBlockHTML : null;
  core.syntaxHighlightLine = typeof syntaxHighlightLine !== "undefined" ? syntaxHighlightLine : null;
  core.renderToolResult = typeof renderToolResult !== "undefined" ? renderToolResult : null;
  core.renderFileContent = typeof renderFileContent !== "undefined" ? renderFileContent : null;
  core.renderDiffMarkup = typeof renderDiffMarkup !== "undefined" ? renderDiffMarkup : null;
  core.renderDiffIfApplicable = typeof renderDiffIfApplicable !== "undefined" ? renderDiffIfApplicable : null;
  core.renderToolResultTruncated = typeof renderToolResultTruncated !== "undefined" ? renderToolResultTruncated : null;
  core.formatToolError = typeof formatToolError !== "undefined" ? formatToolError : null;
  core.formatTokens = typeof formatTokens !== "undefined" ? formatTokens : null;
  core.getLangFromPath = typeof getLangFromPath !== "undefined" ? getLangFromPath : null;
  core.getCompactReadLabel = typeof getCompactReadLabel !== "undefined" ? getCompactReadLabel : null;
  core.shortenPath = typeof shortenPath !== "undefined" ? shortenPath : null;
  core.escapeHtml = typeof escapeHtml !== "undefined" ? escapeHtml : null;
  core.truncate = typeof truncate !== "undefined" ? truncate : null;
  core.morphRender = typeof morphRender !== "undefined" ? morphRender : null;
  core.createToolBlock = typeof createToolBlock !== "undefined" ? createToolBlock : null;
  core.createMessageEl = typeof createMessageEl !== "undefined" ? createMessageEl : null;
  core.createThinkingBlock = typeof createThinkingBlock !== "undefined" ? createThinkingBlock : null;
  core.hideWelcome = typeof hideWelcome !== "undefined" ? hideWelcome : null;
  core.resetChat = typeof resetChat !== "undefined" ? resetChat : null;
  core.scrollToBottom = typeof scrollToBottom !== "undefined" ? scrollToBottom : null;
  core.updateStreamingState = typeof updateStreamingState !== "undefined" ? updateStreamingState : null;
  core.debugLogEvent = typeof debugLogEvent !== "undefined" ? debugLogEvent : null;
  core.debugLogDom = typeof debugLogDom !== "undefined" ? debugLogDom : null;
  core.debugDumpChatStructure = typeof debugDumpChatStructure !== "undefined" ? debugDumpChatStructure : null;
  core.registerToolRenderer = typeof registerToolRenderer !== "undefined" ? registerToolRenderer : null;
  core.getToolRenderer = typeof getToolRenderer !== "undefined" ? getToolRenderer : null;
  core.patchBlockList = typeof patchBlockList !== "undefined" ? patchBlockList : null;
  core.renderBlockToHTML = typeof renderBlockToHTML !== "undefined" ? renderBlockToHTML : null;
  core.postProcessMarkedHTML = typeof postProcessMarkedHTML !== "undefined" ? postProcessMarkedHTML : null;
  core.renderTableBlock = typeof renderTableBlock !== "undefined" ? renderTableBlock : null;
  core.setupCodeBlockHandlers = typeof setupCodeBlockHandlers !== "undefined" ? setupCodeBlockHandlers : null;

  // Backward compat
  window.__piRegisterToolRenderer = core.registerToolRenderer || (function() {});

})();
