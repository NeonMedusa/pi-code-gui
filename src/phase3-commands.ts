import * as vscode from "vscode";
import { PiService } from "./pi-service.js";

export function registerPhase3Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickModel", async () => {
      // Model listing is handled by pi binary internals.
      // For now, let the user type /model in chat.
      vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", "/model");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.cycleModel", async () => {
      try {
        await piService.cycleModel();
        vscode.window.showInformationMessage(`Model: ${piService.model?.id ?? "unknown"}`);
      } catch (e: any) { vscode.window.showErrorMessage(e.message); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickThinkingLevel", async () => {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const cur = piService.thinkingLevel;
      const items = levels.map(l => ({
        label: `${l === cur ? "$(check) " : ""}${l}`,
        description: describeLevel(l),
        level: l,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select thinking level (Shift+Tab)",
      });
      if (picked && typeof picked !== "string") {
        await piService.setThinkingLevel(picked.level);
        vscode.window.showInformationMessage(`Thinking: ${picked.level}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.cycleThinkingLevel", async () => {
      try {
        await piService.setThinkingLevel(
          nextLevel(piService.thinkingLevel),
        );
        vscode.window.showInformationMessage(`Thinking: ${piService.thinkingLevel}`);
      } catch (e: any) { vscode.window.showErrorMessage(e.message); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickFile", async () => {
      const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 200);
      const items = files.map(u => ({
        label: vscode.workspace.asRelativePath(u),
        uri: u,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Pick a file (@)",
      });
      if (picked && typeof picked !== "string") {
        vscode.commands.executeCommand(
          "pi-code-gui.referenceFile",
          vscode.workspace.asRelativePath(picked.uri),
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickCommand", async () => {
      const items = [
        { label: "/model", description: "Switch model" },
        { label: "/new", description: "New session" },
        { label: "/resume", description: "Resume session" },
        { label: "/fork", description: "Fork from message" },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Slash command (/)",
      });
      if (picked && typeof picked !== "string") {
        vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", picked.label);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickFork", async () => {
      vscode.window.showInformationMessage("Fork via /fork command in chat.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.exportSession", async () => {
      vscode.window.showInformationMessage("Export via /export command in chat.");
    }),
  );
}

function describeLevel(l: string): string {
  const m: Record<string, string> = {
    off: "None", minimal: "Minimal", low: "Brief",
    medium: "Balanced", high: "Extended", xhigh: "Maximum",
  };
  return m[l] ?? "";
}

function nextLevel(cur: string): string {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const i = levels.indexOf(cur);
  return levels[(i + 1) % levels.length];
}
