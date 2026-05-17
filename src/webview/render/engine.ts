// ── Rendering engine ───────────────────────────────────────
//
// All markdown rendering, syntax highlighting, diff viewing,
// code blocks, and UI helper functions extracted from core.js.
//
// Internal helpers (syntax highlighters, parseDiffLine, etc.)
// stay private; only the public API is exported.

import { state } from "../state.js";
import { logEvent, logDom } from "../debug.js";
import { highlightCode } from "../highlight.js";

// ═══ Utilities ══════════════════════════════════════════════

export function formatTokens(count) {
  if (!count || count === 0) {return "0";}
  if (count < 1000) {return count.toString();}
  if (count < 10000) {return (count / 1000).toFixed(1) + "k";}
  if (count < 100000) {return Math.round(count / 1000) + "k";}
  if (count < 1000000) {return (count / 1000000).toFixed(1) + "M";}
  return Math.round(count / 1000000) + "M";
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) {return text || "";}
  return text.substring(0, maxLen) + "...";
}

export function shortenPath(filePath) {
  if (!filePath) {return "";}
  return filePath;
}

export function getLangFromPath(filePath) {
  if (!filePath) {return undefined;}
  const ext = filePath.split(".").pop().toLowerCase();
  const extToLang = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", sh: "bash", bash: "bash", zsh: "bash",
    html: "html", htm: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    xml: "xml", svg: "svg", md: "markdown", markdown: "markdown",
    sql: "sql", php: "php", rb: "ruby", swift: "swift",
    kt: "kotlin", lua: "lua", r: "r", scala: "scala",
    hs: "haskell", ex: "elixir", exs: "elixir", erl: "erlang",
    dockerfile: "dockerfile", makefile: "makefile",
    proto: "protobuf", graphql: "graphql",
    tf: "hcl", hcl: "hcl", ps1: "powershell",
  };
  return extToLang[ext];
}

export function getCompactReadLabel(filePath) {
  if (!filePath) {return undefined;}
  const name = filePath.split("/").pop() || filePath;
  if (name === "SKILL.md") {
    const parts = filePath.split("/");
    const parent = parts.length >= 2 ? parts[parts.length - 2] : name;
    return { kind: "skill", label: parent };
  }
  if (name === "AGENTS.md" || name === "AGENTS.MD" || name === "CLAUDE.md" || name === "CLAUDE.MD") {
    return { kind: "resource", label: filePath };
  }
  if (name === "README.md" || filePath.indexOf("docs/") !== -1 || filePath.indexOf("examples/") !== -1) {
    return { kind: "docs", label: filePath };
  }
  return undefined;
}

export function formatToolError(text, toolName) {
  if (!text) {return text;}
  if (text.indexOf("Validation failed for tool") !== -1) {
    const issues = [];
    const missingRe = /must have required propert(?:y|ies) (\w+)/g;
    let match;
    while ((match = missingRe.exec(text)) !== null) {
      issues.push("missing \u201C" + match[1] + "\u201D");
    }
    const extraRe = /must not have additional propert(?:y|ies)/g;
    if (extraRe.test(text)) {
      const extraMatch = text.match(/additional properties.*?(\w+)/g);
      if (!extraMatch) {issues.push("unexpected field(s)");}
    }
    const hint = issues.length > 0 ? " (" + issues.join(", ") + ")" : "";
    return "\u26A0 Argument structure mismatch" + hint + " \u2014 the agent will self-correct.";
  }
  if (/abort|aborted|cancell?ed/i.test(text)) {
    return "\u2717 Operation cancelled.";
  }
  if (/permission denied|EACCES|not permitted/i.test(text)) {
    return "\u26D4 Permission denied \u2014 cannot access the file.";
  }
  if (/no such file|ENOENT|not found/i.test(text) && text.indexOf("Validation") === -1) {
    return "\uD83D\uDD0D File not found \u2014 check the path.";
  }
  if (/timed?\s*out/i.test(text)) {
    return "\u23F0 Command timed out.";
  }
  return text;
}

// ═══ Tool Renderer Registry ═════════════════════════════════

export function registerToolRenderer(toolName, renderer) {
  state.toolRenderers[toolName] = renderer;
}

export function getToolRenderer(toolName) {
  return state.toolRenderers[toolName] || null;
}

// ═══ DOM Helpers ═══════════════════════════════════════════

export function morphRender(el, html) {
  if (!el || html === undefined || html === null) {return;}
  const temp = document.createElement("div");
  temp.innerHTML = html;
  window.morphdom(el, temp, { childrenOnly: true });
}

export function createMessageEl(role) {
  const el = document.createElement("div");
  el.className = "message " + role;
  el.innerHTML = '<div class="message-content"></div>';
  return el;
}

export function createThinkingBlock(content) {
  const el = document.createElement("div");
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
    '<button class="thinking-expand-btn">Show more</button>';
  const btn = el.querySelector(".thinking-expand-btn");
  const contentEl = el.querySelector(".thinking-content");

  btn.addEventListener("click", function () {
    const wasCollapsed = el.classList.contains("thinking-collapsed");
    if (wasCollapsed) {
      el.classList.remove("thinking-collapsed");
      btn.textContent = "Show less";
    } else {
      el.classList.add("thinking-collapsed");
      btn.textContent = "Show more";
      contentEl.scrollTop = 0;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  return el;
}

export function createToolBlock(toolName, toolCallId, status, args) {
  const block = document.createElement("div");
  block.className = "tool-block";
  block.id = "tool-" + toolCallId;
  block.setAttribute("data-status", status || "pending");

  let argsText = "";
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

export function hideWelcome() {
  if (state._inBatch) {return;}
  if (state.welcome) {
    state.welcome.remove();
    state.welcome = null;
  }
}

export function resetChat() {
  logEvent("resetChat", {
    bashBlocksN: Object.keys(state.bashBlocks).length,
    toolBlocksN: Object.keys(state.currentToolBlocks).length,
  });
  state.chatContainer.innerHTML =
    '<div id="welcome" class="welcome-message"><h2>Pi coding agent</h2></div>';
  state.welcome = document.getElementById("welcome");
  state.currentAssistantEl = null;
  state.currentThinkingEl = null;
  for (const k of Object.keys(state.currentToolBlocks)) {delete state.currentToolBlocks[k];}
  for (const k of Object.keys(state.assistantToolCallIds)) {delete state.assistantToolCallIds[k];}
  state.lastUserMessageContent = null;
  state.isStreaming = false;
  state.isCompacting = false;
  state.isRetrying = false;
  for (const k of Object.keys(state.bashBlocks)) {delete state.bashBlocks[k];}
  for (const k of Object.keys(state.bashOutputs)) {delete state.bashOutputs[k];}
  for (const k of Object.keys(state.truncationTexts)) {delete state.truncationTexts[k];}
  state.truncationIdx = 0;
  state.userMessageHistory.length = 0;
  // These functions are defined in handlers.js but we avoid circular deps
  // by using the global postMessage pattern. See handlers.js for implementation.
  updateStreamingState();
}

export function scrollToBottom() {
  if (!state.hasScrolledUp) {
    requestAnimationFrame(function () {
      state.chatContainer.scrollTop = state.chatContainer.scrollHeight;
    });
  }
}

export function updateStreamingState() {
  if (state.isStreaming || state.isCompacting || state.isRetrying) {
    state.sendButton.textContent = "Steer";
    state.sendButton.title = "Steer (interrupt current request)";
    state.steerDropdown.classList.remove("hidden");
    state.abortButton.classList.remove("hidden");
  } else {
    state.sendButton.textContent = "\u21B5";
    state.sendButton.title = "Submit (Enter)";
    state.steerDropdown.classList.add("hidden");
    state.abortButton.classList.add("hidden");
  }
}

// ═══ Markdown Rendering ════════════════════════════════════

export function renderMarkdown(text) {
  if (!text) {return "";}
  if (!state._markedAvailable) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  const html = marked.parse(text);
  return postProcessMarkedHTML(html);
}

/** Like renderMarkdown but safe for untrusted content (escapes raw HTML). */
export function renderMarkdownSafe(text) {
  if (!text) {return "";}
  if (!state._markedAvailable) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  // Escape &, <, > so content like "</div>" can't break the container.
  // Order: & first so existing entities aren't re-escaped.
  var safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = marked.parse(safe);
  return postProcessMarkedHTML(html);
}

function postProcessMarkedHTML(html) {
  return html.replace(
    /<pre><code(?: class="language-(\w*)")?>([\s\S]*?)<\/code><\/pre>/g,
    function (m, lang, code) {
      const decoded = code
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      return renderCodeBlockHTML(decoded, lang || "");
    },
  );
}

export function renderCodeBlockHTML(code, lang) {
  code = code.replace(/\r\n?/g, "\n");
  code = code.replace(/\n+$/, "");
  // Highlight the full block, then split into lines for line numbers.
  var highlighted = highlightCode(code, lang);
  var lines = highlighted.split("\n");
  const numberedContent = lines
    .map(function (line) {
      return '<span class="code-ln"></span>' + line;
    })
    .join("\n");
  const langLabel = lang
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

export function renderFileContent(content, lang) {
  if (!content) {return "";}
  content = content.replace(/\r\n?/g, "\n");
  content = content.replace(/\n+$/, "");
  if (!content) {return "";}
  var highlighted = highlightCode(content, lang);
  var lines = highlighted.split("\n");
  const langLabel = lang
    ? '<span class="code-lang-label">' + escapeHtml(lang) + "</span>"
    : "";
  const numbered = lines
    .map(function (line) {
      return '<span class="code-ln"></span>' + line;
    })
    .join("\n");
  return (
    '<div class="code-block-wrapper">' +
    '<div class="code-block-header">' +
    langLabel +
    '<button class="code-copy-btn" type="button">Copy</button></div>' +
    '<pre class="code-block" data-lang="' +
    escapeHtml(lang || "") +
    '"><code>' +
    numbered +
    "</code></pre></div>"
  );
}

// ═══ Block-level Rendering (for structured streaming) ══════

export function renderBlock(token) {
  let el;
  switch (token.type) {
    case "heading":
      el = document.createElement("h" + token.depth);
      el.innerHTML = renderInline(token.tokens);
      return el;
    case "paragraph":
      el = document.createElement("p");
      el.innerHTML = renderInline(token.tokens);
      return el;
    case "code": {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = renderCodeBlockHTML(token.text, token.lang || "");
      return wrapper.firstChild;
    }
    case "list":
      el = document.createElement(token.ordered ? "ol" : "ul");
      for (let i = 0; i < token.items.length; i++) {
        const li = document.createElement("li");
        li.innerHTML = renderInline(token.items[i].tokens);
        el.appendChild(li);
      }
      return el;
    case "table":
      return renderTableBlock(token);
    case "blockquote":
      el = document.createElement("blockquote");
      for (let j = 0; j < token.tokens.length; j++) {
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

function renderTableBlock(token) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (let h = 0; h < token.header.length; h++) {
    const th = document.createElement("th");
    th.style.textAlign = token.align[h] || "left";
    th.innerHTML = renderInline(token.header[h].tokens);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  if (token.rows.length > 0) {
    const tbody = document.createElement("tbody");
    for (let r = 0; r < token.rows.length; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < token.rows[r].length; c++) {
        const td = document.createElement("td");
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

export function renderInline(tokens) {
  if (!tokens || tokens.length === 0) {return "";}
  let html = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "text":
        html += escapeHtml(t.text);
        break;
      case "strong":
        html += "<strong>" + renderInline(t.tokens) + "</strong>";
        break;
      case "em":
        html += "<em>" + renderInline(t.tokens) + "</em>";
        break;
      case "codespan":
        html += "<code>" + escapeHtml(t.text) + "</code>";
        break;
      case "link":
        html +=
          '<a href="' +
          escapeHtml(t.href) +
          '">' +
          renderInline(t.tokens) +
          "</a>";
        break;
      case "del":
        html += "<del>" + renderInline(t.tokens) + "</del>";
        break;
      case "image":
        html +=
          '<img src="' +
          escapeHtml(t.href) +
          '" alt="' +
          escapeHtml(t.text) +
          '">';
        break;
      case "br":
        html += "<br>";
        break;
      case "html":
        html += t.text || t.raw || "";
        break;
      case "escape":
        html += escapeHtml(t.text);
        break;
      default:
        html += escapeHtml(t.raw || t.text || "");
    }
  }
  return html;
}

// ═══ Token-diff Streaming ═════════════════════════════════

/** Diff prev/new token lists and patch the DOM container efficiently. */
export function patchBlockList(container, prevTokens, newTokens) {
  if (!state._markedAvailable) {
    const raw = container.getAttribute("data-raw") || "";
    morphRender(container, renderMarkdown(raw));
    return;
  }
  while (container.children.length > newTokens.length) {
    container.removeChild(container.lastChild);
  }
  const commonLen = Math.min(prevTokens.length, newTokens.length);
  for (let i = 0; i < commonLen; i++) {
    const child = container.children[i];
    if (!child) {
      container.appendChild(renderBlock(newTokens[i]));
    } else if (
      prevTokens[i].raw !== newTokens[i].raw ||
      prevTokens[i].type !== newTokens[i].type
    ) {
      morphRender(child, renderBlockToHTML(newTokens[i]));
    }
  }
  for (let i = prevTokens.length; i < newTokens.length; i++) {
    container.appendChild(renderBlock(newTokens[i]));
  }
}

export function renderBlockToHTML(token) {
  const temp = document.createElement("div");
  temp.appendChild(renderBlock(token));
  return temp.innerHTML;
}

// ═══ Syntax Highlighting ══════════════════════════════════



// ═══ Code Block Handlers ══════════════════════════════════

export function setupCodeBlockHandlers() {
  // ── Click delegation for tool blocks, copy buttons, file paths ──
  state.chatContainer.addEventListener("click", function (e) {
    // Show-more button for truncated tool results
    const showMoreBtn = e.target.closest(".show-more-btn");
    if (showMoreBtn) {
      e.preventDefault();
      const truncEl = showMoreBtn.closest(".tool-result-truncated");
      if (!truncEl) {return;}
      const expanded = truncEl.getAttribute("data-expanded") === "1";
      const id = truncEl.id;
      const stored = state.truncationTexts[id];
      if (!stored) {return;}
      const previewEl = truncEl.querySelector(".tool-result-preview");
      if (!previewEl) {return;}
      if (expanded) {
        previewEl.innerHTML = renderMarkdownSafe(stored.preview);
        truncEl.setAttribute("data-expanded", "0");
        showMoreBtn.textContent =
          "\u25BC " + truncEl.getAttribute("data-hidden") + " more lines";
      } else {
        previewEl.innerHTML = renderMarkdownSafe(stored.full);
        truncEl.setAttribute("data-expanded", "1");
        showMoreBtn.textContent = "\u25B2 Show less";
      }
      return;
    }

    const btn = e.target.closest(".code-copy-btn");
    if (!btn) {
      const pathEl = e.target.closest(".tool-path");
      if (pathEl && pathEl.dataset.path) {
        e.preventDefault();
        // Use the global vscode API for file opening
        if (typeof window.__vscode !== "undefined") {
          window.__vscode.postMessage({ type: "openFile", path: pathEl.dataset.path });
        }
      }
      return;
    }
    e.preventDefault();
    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) {return;}
    const pre = wrapper.querySelector(".code-block");
    if (!pre) {return;}
    const text = pre.textContent || "";
    navigator.clipboard.writeText(text).then(
      function () {
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 2000);
      },
      function () {
        btn.textContent = "Failed";
        setTimeout(function () { btn.textContent = "Copy"; }, 2000);
      },
    );
  });
}

// ═══ Diff Rendering ═══════════════════════════════════════

export function renderDiffIfApplicable(text) {
  if (!text) {return renderMarkdown(text);}
  const hasDiff =
    /(?:^|\n)[+\-@]/.test(text) ||
    /(?:^|\n)---\s/.test(text) ||
    /(?:^|\n)\+\+\+\s/.test(text);
  if (!hasDiff) {return renderMarkdown(text);}
  return renderDiffMarkup(text);
}

export function renderDiffMarkup(diffText) {
  const lines = diffText.split("\n");
  const resultLines = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseDiffLine(line);
    if (!parsed) {
      resultLines.push(
        '<span class="diff-line-context">' + escapeHtml(line) + "</span>",
      );
      i++;
      continue;
    }
    if (parsed.prefix === "-") {
      const removedLines = [];
      while (i < lines.length) {
        const p2 = parseDiffLine(lines[i]);
        if (!p2 || p2.prefix !== "-") {break;}
        removedLines.push(p2);
        i++;
      }
      const addedLines = [];
      while (i < lines.length) {
        const p3 = parseDiffLine(lines[i]);
        if (!p3 || p3.prefix !== "+") {break;}
        addedLines.push(p3);
        i++;
      }
      if (removedLines.length === 1 && addedLines.length === 1) {
        const intra = diffWords(removedLines[0].content, addedLines[0].content);
        resultLines.push(
          '<span class="diff-line-removed">-' +
            removedLines[0].lineNum +
            " " +
            intra.removed +
            "</span>",
        );
        resultLines.push(
          '<span class="diff-line-added">+' +
            addedLines[0].lineNum +
            " " +
            intra.added +
            "</span>",
        );
      } else {
        for (let ri = 0; ri < removedLines.length; ri++) {
          resultLines.push(
            '<span class="diff-line-removed">-' +
              removedLines[ri].lineNum +
              " " +
              escapeHtml(removedLines[ri].content) +
              "</span>",
          );
        }
        for (let ai = 0; ai < addedLines.length; ai++) {
          resultLines.push(
            '<span class="diff-line-added">+' +
              addedLines[ai].lineNum +
              " " +
              escapeHtml(addedLines[ai].content) +
              "</span>",
          );
        }
      }
    } else if (parsed.prefix === "+") {
      resultLines.push(
        '<span class="diff-line-added">+' +
          parsed.lineNum +
          " " +
          escapeHtml(parsed.content) +
          "</span>",
      );
      i++;
    } else {
      resultLines.push(
        '<span class="diff-line-context"> ' +
          parsed.lineNum +
          " " +
          escapeHtml(parsed.content) +
          "</span>",
      );
      i++;
    }
  }
  return (
    '<pre style="white-space:pre;font-family:var(--vscode-editor-font-family);font-size:0.85em;line-height:1.55;overflow-x:auto;padding:8px 0;">' +
    resultLines.join("\n") +
    "</pre>"
  );
}

function parseDiffLine(line) {
  const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
  if (!match) {return null;}
  return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function diffWords(oldStr, newStr) {
  const minLen = Math.min(oldStr.length, newStr.length);
  let prefixLen = 0;
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {prefixLen++;}
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  )
    {suffixLen++;}

  const commonPrefix = escapeHtml(oldStr.slice(0, prefixLen));
  const commonSuffix = escapeHtml(oldStr.slice(oldStr.length - suffixLen));
  const removedMiddle = escapeHtml(oldStr.slice(prefixLen, oldStr.length - suffixLen));
  const addedMiddle = escapeHtml(newStr.slice(prefixLen, newStr.length - suffixLen));

  return {
    removed:
      commonPrefix +
      '<span class="diff-word-removed">' +
      removedMiddle +
      "</span>" +
      commonSuffix,
    added:
      commonPrefix +
      '<span class="diff-word-added">' +
      addedMiddle +
      "</span>" +
      commonSuffix,
  };
}

// ═══ Tool Result Rendering ════════════════════════════════

/** Render tool result markdown. Detects diffs, code blocks, and JSON. */
export function renderToolResult(text) {
  if (!text) {return "";}
  if (/^```/.test(text.trim())) {
    return renderMarkdown(text);
  }
  if (
    /(?:^|\n)[+\-@]/.test(text) ||
    /(?:^|\n)---\s/.test(text) ||
    /(?:^|\n)\+\+\+\s/.test(text)
  ) {
    return renderDiffMarkup(text);
  }
  const trimmed = text.trim();
  if (trimmed.indexOf("\n") !== -1 || trimmed.length > 120) {
    const lang = detectToolResultLang(trimmed);
    return renderMarkdown("```" + lang + "\n" + trimmed + "\n```");
  }
  // Short untrusted text — escape HTML so it can't break the container.
  return renderMarkdownSafe(text);
}

/** Guess the language of a tool result blob. */
function detectToolResultLang(text) {
  if (/^[\[\{]\s*["\w]/.test(text) && /[\]\}]\s*$/.test(text)) {return "json";}
  if (/<[a-z][\s\S]*>/i.test(text)) {return "html";}
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(text)) {return "sql";}
  if (/^[.#]?[\w-]+\s*\{/.test(text)) {return "css";}
  return "";
}

/** Render tool result with "show more" if content exceeds maxLines. */
export function renderToolResultTruncated(text: string, maxLines = 50): string {
  if (!text) {return "";}
  const lines = text.split("\n");
  if (lines.length <= maxLines) {return renderToolResult(text);}

  const previewLines = lines.slice(0, maxLines);
  const hiddenCount = lines.length - maxLines;
  const id = "trunc-" + state.truncationIdx++;

  state.truncationTexts[id] = {
    preview: previewLines.join("\n"),
    full: text,
  };

  return (
    '<div class="tool-result-truncated" id="' +
    id +
    '" data-hidden="' +
    hiddenCount +
    '" data-expanded="0">' +
    '<div class="tool-result-preview">' +
    renderMarkdown(previewLines.join("\n")) +
    "</div>" +
    '<button class="show-more-btn" type="button">' +
    "\u25BC " +
    hiddenCount +
    " more lines</button></div>"
  );
}
