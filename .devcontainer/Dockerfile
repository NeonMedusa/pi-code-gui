# syntax=docker/dockerfile:1.7
#
# Dev container for pi-vscode-gui — VS Code extension development.
# Based on Microsoft's TypeScript + Node devcontainer image.
#
FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

ARG USERNAME=node

USER ${USERNAME}

# User-owned npm global prefix so `npm install -g` works without sudo.
ENV NPM_CONFIG_PREFIX=/home/${USERNAME}/.npm-global \
    PATH=/home/${USERNAME}/.npm-global/bin:${PATH}

RUN mkdir -p /home/${USERNAME}/.npm-global/bin

# Install the pnpm shim via corepack (the actual pnpm version is fetched lazily
# on first use, driven by the workspace's packageManager field — the workspace
# isn't mounted at build time, so we can't `corepack prepare --activate` here).
# --install-directory targets the user-writable npm prefix; without it corepack
# tries to symlink into /usr/local/bin and fails with EACCES under the node user.
# Also seed pi-coding-agent so the VS Code extension finds it immediately.
RUN corepack enable --install-directory /home/${USERNAME}/.npm-global/bin && \
    npm install -g @earendil-works/pi-coding-agent@latest

WORKDIR /workspaces
CMD ["sleep", "infinity"]
