# PiService

> **Status:** evolving

PiService (`src/pi-service.ts`) is the core lifecycle manager that bridges the
Pi coding agent SDK (`@earendil-works/pi-coding-agent`) to VS Code. Every
`SessionWindow` owns one PiService instance. It handles SDK resolution, agent
session creation, event subscription/translation, model cycling, thinking level
management, and usage stat tracking.

## Why it exists

The Pi SDK is loaded dynamically at runtime from the user's global npm install
— it is not bundled with the extension. PiService encapsulates the full lifecycle:
finding the SDK on disk (`resolvePiPackagePath`), importing modules (`PiSdk`,
`PiAi`), configuring auth/model-registry/session-manager, building custom tools
(via `bridge-tools.ts`), creating the agent session, subscribing to events, and
cleaning up on disposal.

Without this abstraction, every command and view would need to manage SDK state
independently, leading to duplicated init logic and inconsistent error handling.

## Key responsibilities

- **SDK resolution** (`resolvePiPackagePath`) — searches global npm, nvm, and
  project-local `.pi/npm/` directories for the Pi SDK.
- **Install check** (`PiService.checkInstall`) — static method that verifies
  the SDK and its critical transitive dependencies (openai, @anthropic-ai/sdk)
  are actually installed.
- **Session init** (`initialize`) — 11-step async sequence: resolve SDK, load
  modules, setup auth/registry, pick model, build tools, create session manager,
  restore model/thinking from session file, create agent session, subscribe to
  events, bind extensions, send initial message history.
- **Event emission** (`onEvent` / `emit`) — observer pattern: listeners (webview
  panel, extension commands) subscribe to typed `PiServiceEvent` emissions.
- **User actions** — `sendPrompt`, `abort`, `cycleModel`, `setThinkingLevel`,
  `setEffort`, `login`, `logout`, `toggleAutoCompaction`, `toggleAutoRetry`.
- **Interactive pickers** — `pickModel()` and `pickThinkingLevel()` provide
  unified QuickPick dialogs (with ★ default / ✓ current indicators and
  save-as-default prompts). These replaced duplicated implementations that
  previously lived in `extension.ts` and `webview-panel.ts`. `pickModel()`
  also surfaces SDK-reported pricing and context window in the `detail` field via
  `PiService.formatModelDetail()`.
- **Session listing** (`PiService.listSessions`, `PiService.deleteSessionFile`) —
  static methods for the Past Sessions tree view.

## Related

- [Session Window](session-window.md) — the SessionWindow that owns PiService
- [Event Translation](event-translation.md) — how SDK events become PiServiceEvent types
- [SDK Resolution & Init](../operations/sdk-resolution.md) — detailed walkthrough of the init sequence

> **Last updated:** 2025-05-15 — added pickModel/pickThinkingLevel, de-duplicated pickers, added model pricing
