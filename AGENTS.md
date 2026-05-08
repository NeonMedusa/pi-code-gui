# Project Guidelines

## Repository Rules
- **Requires PRs** — no direct pushes to `main`. All changes must go through a pull request.
- Use `git push origin HEAD` to push your branch, then open a PR.

## Build / Test
- `pnpm run package` — type-check, lint, and build
- `npx @vscode/vsce package --no-dependencies` — create the .vsix
- `code --install-extension pi-code-gui-*.vsix --force` — install locally
