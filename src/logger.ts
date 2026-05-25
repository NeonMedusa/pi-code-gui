import type * as vscode from "vscode";

/** Shared logger that writes to both console and the Pi Code Gui Output Channel. */

let _channel: vscode.LogOutputChannel | null = null;

export function initLogger(channel: vscode.LogOutputChannel): void {
  _channel = channel;
}

export function piLog(message: string): void {
  console.log(`[pi-gui] ${message}`);
  _channel?.info(message);
}

export function piWarn(message: string): void {
  console.warn(`[pi-gui] ${message}`);
  _channel?.warn(message);
}
