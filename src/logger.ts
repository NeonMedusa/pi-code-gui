import * as vscode from "vscode";

/** Shared logger that writes to both console and the Pi Code Gui Output Channel. */

let _channel: vscode.LogOutputChannel | null = null;

export function initLogger(channel: vscode.LogOutputChannel) {
  _channel = channel;
}

export function piLog(message: string) {
  console.log(`[pi-gui] ${message}`);
  _channel?.info(message);
}

export function piWarn(message: string) {
  console.warn(`[pi-gui] ${message}`);
  _channel?.warn(message);
}
