# Build Pipeline

> **Status:** evolving

The Build Pipeline (`esbuild.js`, `tsconfig.json`, `eslint.config.mjs`,
`.vscode-test.mjs`, and npm scripts in `package.json`) compiles, type-checks,
lints, tests, and packages the Pi Code Gui VS Code extension. The pipeline
produces a single `dist/extension.js` bundle plus static media assets.

## Why it exists

VS Code extensions are distributed as `.vsix` packages containing JavaScript
that runs in the extension host. The build pipeline must: bundle TypeScript
source into a single file (VS Code extensions can't use native ESM with
multiple files), exclude the `vscode` module (provided by the host), strip
source files from the package (they're not needed at runtime), and produce
both development and production builds.

## Build tools

**esbuild** (`esbuild.js`):
- Entry point: `src/extension.ts`
- Output: `dist/extension.js` (single ESM bundle)
- External: `vscode` (provided by extension host)
- Dev mode: unbundled with sourcemaps
- Production mode (`--production`): minified, no sourcemaps
- Watch mode (`--watch`): rebuilds on file changes
- Custom plugin logs build start/end and formats errors with file locations

**TypeScript** (`tsconfig.json`):
- Module: Node16, Target: ES2022
- Strict mode enabled, skipLibCheck for SDK types
- `tsc --noEmit` only — type checking, no transpilation (esbuild handles that)
- Source root: `src/`

**ESLint** (`eslint.config.mjs`):
- typescript-eslint parser and plugin
- Rules: naming convention (import), curly, eqeqeq, no-throw-literal, semi
- Targets: `**/*.ts`

**Tests** (`.vscode-test.mjs`):
- `@vscode/test-cli` configuration
- Test files: `out/test/**/*.test.js` (compiled from `src/test/`)
- Uses `@vscode/test-electron` for CI (portable VS Code download)

## npm scripts

| Script | Steps | Use |
|--------|-------|-----|
| `compile` | check-types → lint → esbuild | Dev build |
| `watch` | esbuild (watch) + tsc (watch) in parallel | Dev loop |
| `package` | check-types → lint → esbuild --production | Production build |
| `pretest` | compile-tests → compile → lint | Before tests |
| `test` | vscode-test | Run tests |
| `vsix` | package → vsce package --no-dependencies | Create .vsix |
| `publish` | vsce publish | Manual marketplace publish |

## CI/CD

GitHub Actions (`.github/workflows/publish.yml`):
- Triggered on GitHub Release (`published`)
- Gated behind `marketplace` environment with required reviewers
- Two parallel jobs: `publish-vsce` (VS Code Marketplace via Azure credential)
  and `publish-ovsx` (Open VSX via PAT)
- Both run: checkout → setup Node 22 → pnpm install → pretest → publish

## VSIX contents

Controlled by `.vscodeignore`: excludes source, configs, lockfiles, dev
container files, and `.pi/`. Ships only `dist/`, `media/`, `package.json`,
`README.md`, `CHANGELOG.md`, `LICENSE`, and icon files.

## Related

- [SDK Resolution & Init](sdk-resolution.md) — how the extension finds and loads Pi SDK at runtime

> **Last updated:** 2026-05-15 — initial documentation
