import * as vscode from "vscode";
import { PiService } from "./pi-service.js";

/** Register a command safely — ignore if already registered. */
function safeRegister(context: vscode.ExtensionContext, command: string, callback: (...args: any[]) => any) {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (e: any) {
    // Command already registered by activate() — fine, skip.
    console.log(`[pi-gui] Command "${command}" already registered, skipping phase-3 duplicate.`);
  }
}

export function registerPhase3Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  safeRegister(context, "pi-code-gui.pickModel", async () => {
    // Model listing is handled by pi binary internals.
    // For now, let the user type /model in chat.
    vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", "/model");
  });

  safeRegister(context, "pi-code-gui.cycleModel", async () => {
    try {
      await piService.cycleModel();
      vscode.window.showInformationMessage(`Model: ${piService.model?.id ?? "unknown"}`);
    } catch (e: any) { vscode.window.showErrorMessage(e.message); }
  });

  safeRegister(context, "pi-code-gui.pickThinkingLevel", async () => {
    await piService.pickThinkingLevel();
  });

  safeRegister(context, "pi-code-gui.cycleThinkingLevel", async () => {
    try {
      await piService.setThinkingLevel(
        nextLevel(piService.thinkingLevel),
      );
      vscode.window.showInformationMessage(`Thinking: ${piService.thinkingLevel}`);
    } catch (e: any) { vscode.window.showErrorMessage(e.message); }
  });

  safeRegister(context, "pi-code-gui.pickFile", async () => {
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
  });

  safeRegister(context, "pi-code-gui.pickCommand", async () => {
    // Get the full slash-command list from PiService (extension commands,
    // builtin SDK commands, and prompt templates), grouped by source.
    const allCommands = piService.getAllSlashCommands();

    // Build grouped quick-pick items with source labels
    const items: vscode.QuickPickItem[] = [];
    const grouped: Record<string, Array<{ cmd: string; desc: string }>> = {};
    for (const c of allCommands) {
      const group = c.source || "other";
      if (!grouped[group]) { grouped[group] = []; }
      grouped[group].push(c);
    }

    // Order: builtin first, then extensions, then others
    const groupOrder = ["builtin"];
    for (const g of Object.keys(grouped).sort()) {
      if (g !== "builtin") { groupOrder.push(g); }
    }

    for (const group of groupOrder) {
      const cmds = grouped[group];
      if (!cmds || cmds.length === 0) { continue; }
      items.push({
        label: `\u2014 ${group} \u2014`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const c of cmds) {
        items.push({
          label: c.cmd,
          description: c.desc || `(${group})`,
        });
      }
    }

    if (items.length === 0) {
      // Fallback: hardcoded list when session not yet initialized
      items.push(
        { label: "/model", description: "Switch model" },
        { label: "/new", description: "Start new session" },
        { label: "/resume", description: "Resume a previous session" },
        { label: "/fork", description: "Fork session from message" },
      );
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Slash command (/)",
      matchOnDescription: true,
    });
    if (picked && typeof picked !== "string" && picked.kind !== vscode.QuickPickItemKind.Separator) {
      vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", picked.label);
    }
  });

  safeRegister(context, "pi-code-gui.pickFork", async () => {
    vscode.window.showInformationMessage("Fork via /fork command in chat.");
  });

  safeRegister(context, "pi-code-gui.exportSession", async () => {
    vscode.window.showInformationMessage("Export via /export command in chat.");
  });
}

function nextLevel(cur: string): string {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const i = levels.indexOf(cur);
  return levels[(i + 1) % levels.length];
}
