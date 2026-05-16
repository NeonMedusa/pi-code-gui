# Webview Modularization & TypeScript Rewrite Plan

> **Status:** stable — all 5 steps completed

This is the 5-step plan that refactored the Pi Code Gui webview from 3
monolithic vanilla JS files (4,431 lines) into 6 TypeScript ES modules,
bundled by esbuild to a single `media/bundle.js`.

## Final architecture

```
src/webview/                    ← TypeScript source, bundled by esbuild
├── main.ts                     ← Entry: acquireVsCodeApi, init, scroll tracking
├── global.d.ts                 ← Type declarations for VS Code API and globals
├── state.ts                    ← All shared state (auto-inits DOM refs)
├── debug.ts                    ← Debug logging, MutationObserver, /debug API
├── render/
│   └── engine.ts               ← All 30+ rendering functions (markdown, syntax
│                                   highlight, diff, code blocks, DOM helpers)
├── tools/
│   └── index.ts                ← Write/edit/read/bash tool renderers + dispatchers
└── handlers/
    └── index.ts                ← Message router + all event handlers + UI wiring

src/shared/
└── protocol.ts                 ← 38 typed data interfaces + 2 discriminated unions
                                  (ExtensionToWebview, WebviewToExtension)

media/
├── entry.js                    ← 3-line shim: imports morphdom + marked + main.ts
├── bundle.js                   ← Single esbuild output (gitignored)
├── bundle.js.map               ← Source map (gitignored)
├── lib/morphdom.js             ← External lib (global)
└── marked.min.js               ← External lib (global)
```

## Step 1: Add esbuild webview bundling ✓

Bundled existing scripts into one file via esbuild. Added `media/entry.js`
as import-order shim, updated `webview-panel.ts` to load `bundle.js` instead
of 5 separate `<script>` tags.

**Files changed:**
- `esbuild.webview.js` (new)
- `media/entry.js` (new)
- `src/webview-panel.ts` — load `bundle.js`
- `package.json` — add webview watch/build scripts
- `.gitignore` — add `bundle.js` and `.map`

## Step 2: Extract shared protocol types ✓

Defined every message that flows between extension and webview as TypeScript
discriminated unions in `src/shared/protocol.ts`. Both sides import from here.

**Files changed:**
- `src/shared/protocol.ts` (new) — 38 data interfaces + `ExtensionToWebview` and `WebviewToExtension`
- `src/types.ts` — re-export shared types

## Step 3: Split into ES modules ✓

Moved from `media/` to `src/webview/`, split 3 monolithic files into 6 focused
ES modules. Used `.js` originally, later renamed to `.ts` in Step 4.

**Files created:**
- `src/webview/state.js` → `.ts`
- `src/webview/debug.js` → `.ts`
- `src/webview/render/engine.js` → `.ts`
- `src/webview/tools/index.js` → `.ts`
- `src/webview/handlers/index.js` → `.ts`
- `src/webview/main.js` → `.ts`

**Files removed:**
- `media/core.js` — moved to `state.ts` + `debug.ts` + `engine.ts`
- `media/tools.js` — moved to `tools/index.ts`
- `media/app.js` — moved to `handlers/index.ts`

## Step 4: Convert to TypeScript ✓

Renamed `.js` → `.ts`, added type annotations, created `tsconfig.webview.json`
with DOM target. Added `src/webview/global.d.ts` for external globals and
custom HTMLElement properties. Excluded `src/webview` from main `tsconfig.json`
to avoid DOM/Node type conflicts.

**Files changed:**
- `tsconfig.webview.json` (new)
- `src/webview/global.d.ts` (new)
- `tsconfig.json` — exclude `src/webview`
- All 6 modules — renamed `.js` → `.ts` with type annotations

## Step 5: Type-safe extension ↔ webview bridge ✓

`webview-panel.ts`'s `postMessage()` is now typed as
`ExtensionToWebview | WebviewToExtension`. The shared types are imported
from `src/shared/protocol.ts`. `PiServiceEvent` still uses `data?: any`
with a cast to `ExtensionToWebview` — full migration of `PiServiceEvent`
to the discriminated union is a follow-up.

**Files changed:**
- `src/webview-panel.ts` — typed `postMessage()`
- `src/types.ts` — re-export `ExtensionToWebview` and `WebviewToExtension`

## Before / After

| Metric | Before | After |
|--------|--------|-------|
| Source files | 3 IIFE files in `media/` | 6 TS modules in `src/webview/` |
| Total lines | 4,431 | ~3,800 |
| Build step | None (plain scripts) | esbuild → single `bundle.js` |
| Type safety | None (`data?: any`) | Discriminated unions for all 46 message types |
| Script tags in HTML | 5 | 1 |
| Module system | Global `window.__pi` | ES `import`/`export` |
| Message protocol | Undocumented | `src/shared/protocol.ts` |

## Related

- [Webview Frontend](webview-frontend.md) — implementation details of each module
- [Webview Panel](webview-panel.md) — extension-host side that loads the bundle
- [PiService](pi-service.md) — SDK event bridge

> **Last updated:** 2026-05-16 — all 5 steps completed
