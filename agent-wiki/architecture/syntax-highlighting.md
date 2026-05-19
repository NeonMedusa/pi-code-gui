# Syntax Highlighting

> **Status:** stable

Syntax highlighting lives in `src/webview/render/engine.ts` (the `renderFileContent`
and `renderCodeBlockHTML` functions) and `src/webview/highlight.ts` (the highlight.js
setup module). All four code-display paths — assistant message code blocks, write
tool, read tool, and edit tool previews — now use the same safe highlighter.

## Why highlight.js replaced the hand-rolled approach

The original highlighter was ~210 lines of hand-rolled regexes across 9 language
functions (`highlightJS`, `highlightPython`, `highlightRust`, `highlightHTML`,
`highlightCSS`, `highlightShell`, `highlightJSON`, `highlightJava`, `highlightGo`).
It applied regexes sequentially on `escapeHtml`'d text, which caused:

- **CSS token leakage**: Keywords inside already-wrapped strings produced nested
  `<span>` elements that the browser HTML parser consumed incorrectly, leaking
  `class="tok-str">` as visible text.
- **No safety guarantee**: Nothing prevented regex match corruption from
  malforming the output HTML.
- **Limited language coverage**: Only 9 languages. No YAML, Markdown, XML, etc.

## Architecture

**`src/webview/highlight.ts`** — Tree-shakeable highlight.js setup:

```typescript
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
// ... 11 more language imports

hljs.registerLanguage("javascript", javascript);
// ... 11 more registrations + aliases

export function highlightCode(code: string, lang: string): string;
```

The `langMap` normalizes our `getLangFromPath` results (e.g. `"js"` → `"javascript"`)
to highlight.js language names. Unsupported languages fall back to `escapeHtml`.

**`render/engine.ts`** — Two rendering functions both call `highlightCode`:

- `renderCodeBlockHTML` — used by assistant message code blocks (via
  `postProcessMarkedHTML`). Highlights the full code, splits by line for number
  spans.
- `renderFileContent` — used by write/read tool blocks. Same highlighting, with
  a full `<div class="code-block-wrapper">` including language header and copy
  button.

**No more line-by-line wrapping**: The `<span class="code-text">` per-line wrapper
was removed. Syntax tokens are direct children of `<code>`, eliminating the
nested-span HTML parsing edge case that was the root cause of CSS token leakage.

## CSS token mapping

The old `.tok-*` classes (10 rules) were replaced with `.hljs-*` classes (~25
rules), all mapped to `var(--vscode-symbolIcon-*)` CSS custom properties with
hardcoded fallback colors. This preserves VS Code theme compatibility.

## Bundle impact

highlight.js core + 12 languages: ~36KB gzipped added to the webview bundle.
The hand-rolled highlighters (~5KB) were removed. Net: +31KB.

## Related

- [Webview Frontend](webview-frontend.md) — renders the highlighted output
- [Tool Block Rendering](tool-block-rendering.md) — write/read/edit tools consume
  `renderFileContent`
- [Build Pipeline](../operations/build-pipeline.md) — esbuild bundles highlight.js

> **Last updated:** 2026-05-19 — initial documentation of highlight.js integration
