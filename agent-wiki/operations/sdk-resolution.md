# SDK Resolution & Initialization

> **Status:** evolving

SDK Resolution & Initialization (`src/pi-service.ts` — `resolvePiPackagePath()`,
`PiService.checkInstall()`, and `PiService.initialize()`) is the startup sequence
that locates the Pi coding agent SDK on disk and creates an operational agent
session. It is the most complex code path in the extension — failure at any
of 11 steps must be communicated cleanly to the user.

## Why it exists

The Pi SDK (`@earendil-works/pi-coding-agent`) is not bundled with the
extension. It lives in the user's global npm install, an nvm-managed Node
version, or a project-local `.pi/npm/` directory. The extension must find it,
verify its integrity, load its modules, and construct a full agent session
before any chat interaction can begin.

## The 11-step init sequence

1. **Resolve SDK path** — `resolvePiPackagePath()` searches candidates:
   project-local `.pi/npm/`, global npm (`~/.npm-global/`, `~/.local/`),
   nvm versions directories, Windows `%APPDATA%/npm`. Returns the first
   directory containing a `package.json`.

2. **Load SDK modules** — Dynamic `import()` of `dist/index.js` (PiSdk)
   and `node_modules/@earendil-works/pi-ai/dist/index.js` (PiAi). Catches
   missing dependency errors (openai, @anthropic-ai/sdk) with specific fix
   instructions.

3. **Load Typebox** — Dynamic import of `typebox/build/index.mjs` for
   `defineTool()` type schemas.

4. **Auth & model registry** — Create `AuthStorage`, apply runtime API key
   overrides from VS Code settings, create `ModelRegistry` and `SettingsManager`.

5. **Pick a model** — Try `modelRegistry.getAvailable()` first (respects API
   keys), fall back to `modelRegistry.find()` and `AI.getModel()` for built-in
   models. Apply user's default model from VS Code settings if configured.
   Apply context budget override.

6. **ResourceLoader** — Build custom system prompt with VS Code context,
   inject virtual context files (`/virtual/vscode-guidelines.md`,
   `/virtual/project-stack-typescript.md`), register custom slash commands
   (`/fix-diagnostics`, `/explain-code`, `/refactor`). Reload to discover
   skills and prompts.

7. **Build tools** — Combine SDK's `createCodingTools()` with bridge tools
   from `createBridgeTools()`.

8. **Session manager** — `SessionManager.open()` for explicit path,
   `SessionManager.create()` for fresh sessions, or
   `SessionManager.continueRecent()` for restore. Applies custom `sessionDir`
   from VS Code settings.

9. **Restore model/thinking** — Walk session entries in reverse to find the
   last `model_change` and `thinking_level_change` entries. Resolve model
   against registry.

10. **Create agent session** — `SDK.createAgentSession()` with all
    configuration: model, thinking level, auth, registry, tools, resource
    loader, settings manager, session manager, scoped models.

11. **Bind extensions & emit history** — Subscribe to agent events, bind
    extension UI context, emit initial message history (with batch-start/end
    wrappers), report status, emit scoped models and settings.

## Error handling

Each step returns `{ success: false, error: "..." }` on failure. The caller
(`initSessionInBackground` in `extension.ts`) posts error messages to the
webview, shows VS Code error notifications with action buttons (Install Pi,
Retry, Learn More), and updates the tree view to reflect the failure state.

## Related

- [PiService](../architecture/pi-service.md) — owns this initialization sequence
- [Session Window](../architecture/session-window.md) — calls initSessionInBackground
- [Build Pipeline](build-pipeline.md) — how the extension itself is built

> **Last updated:** 2026-05-15 — initial documentation
