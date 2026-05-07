import * as vscode from "vscode";
import type { PiService } from "./pi-service.js";

export function registerPhase4Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.login", async () => {
      try {
        await piService.login();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Login failed: ${e.message ?? e}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.resumeSession", async () => {
      vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", "/resume");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.compact", async () => {
      vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", "/compact");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.toggleAutoCompaction", async () => {
      const enabled = await piService.toggleAutoCompaction();
      vscode.window.showInformationMessage(`Auto-compaction ${enabled ? "enabled" : "disabled"}.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.toggleAutoRetry", async () => {
      const enabled = await piService.toggleAutoRetry();
      vscode.window.showInformationMessage(`Auto-retry ${enabled ? "enabled" : "disabled"}.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.reloadContext", async () => {
      try {
        await piService.newSession();
        vscode.window.showInformationMessage("Context reloaded.");
      } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
  );
}
