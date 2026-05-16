# Wiki Log

Append-only chronological record of all wiki operations. Every entry
starts with `## [YYYY-MM-DD] <action> | <description>`. Actions:
`ingest` (new page), `update` (existing page changed), `lint` (quality
pass performed), `archive` (page moved to archive).

## [2026-05-16] archive | Webview Rewrite Plan moved to archive/ (all 5 steps completed)
## [2026-05-16] stale | Removed WEBVIEW_REWRITE_TODO.md (tracking complete)
## [2026-05-16] lint | Fixed all 65 ESLint warnings in src/webview — 0 warnings remain
## [2026-05-16] update | Webview Panel + Frontend — CSS extracted to media/style.css, @layer organization, native nesting
## [2026-05-16] update | Webview Panel — updated for single-bundle loading via esbuild, typed postMessage bridge
## [2026-05-16] update | Webview Rewrite Plan — marked all 5 steps complete, final architecture documented
## [2026-05-16] stale | Removed media/app.js, media/core.js, media/tools.js (migrated to src/webview/)
## [2026-05-16] ingest | Webview Rewrite Plan — 5-step modularization + TS migration, TODO tracking file
## [2026-05-15] ingest | Bootstrap — wiki structure initialized from Pi template (discipline pages, index, log, archive)
## [2026-05-15] ingest | Architecture — Session Window (`architecture/session-window.md`)
## [2026-05-15] ingest | Architecture — PiService (`architecture/pi-service.md`)
## [2026-05-15] update | PiService — added pickModel/pickThinkingLevel, de-duplicated pickers from extension.ts and webview-panel.ts, added model pricing display
## [2026-05-15] ingest | Architecture — Webview Panel (`architecture/webview-panel.md`)
## [2026-05-15] ingest | Architecture — Bridge Tools (`architecture/bridge-tools.md`)
## [2026-05-15] ingest | Architecture — Event Translation (`architecture/event-translation.md`)
## [2026-05-15] ingest | Architecture — Extension UI Bridge (`architecture/extension-ui-bridge.md`)
## [2026-05-15] ingest | Architecture — Webview Frontend (`architecture/webview-frontend.md`)
## [2026-05-15] ingest | Architecture — Tree Views (`architecture/tree-views.md`)
## [2026-05-15] ingest | Operations — SDK Resolution & Init (`operations/sdk-resolution.md`)
## [2026-05-15] ingest | Operations — Build Pipeline (`operations/build-pipeline.md`)
## [2026-05-15] update | AGENTS.md bootstrap — filled project overview, dev workflow, tool discipline, storage rules, quick reference
## [2026-05-15] update | TDD discipline — filled project test conventions (locations, commands, preflight)
