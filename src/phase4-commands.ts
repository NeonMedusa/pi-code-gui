import * as vscode from "vscode";
import type { PiService } from "./pi-service.js";

export function registerPhase4Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.login", async () => {
      const providers = [
        { label: "Anthropic", envVar: "ANTHROPIC_API_KEY", detail: "api.anthropic.com" },
        { label: "OpenAI", envVar: "OPENAI_API_KEY", detail: "api.openai.com" },
        { label: "Google Gemini", envVar: "GEMINI_API_KEY", detail: "aistudio.google.com" },
        { label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", detail: "api.deepseek.com" },
        { label: "Groq", envVar: "GROQ_API_KEY", detail: "console.groq.com" },
        { label: "Mistral", envVar: "MISTRAL_API_KEY", detail: "console.mistral.ai" },
        { label: "OpenRouter", envVar: "OPENROUTER_API_KEY", detail: "openrouter.ai" },
      ];

      const picked = await vscode.window.showQuickPick(providers, {
        placeHolder: "Select a provider",
        matchOnDescription: true,
      });
      if (!picked || typeof picked === "string") {return;}

      const key = await vscode.window.showInputBox({
        prompt: `Enter ${picked.label} API key (${picked.envVar})`,
        password: true,
        placeHolder: "sk-...",
        validateInput: (v) => (v.trim() ? undefined : "Key required"),
      });

      if (key) {
        const term = vscode.window.createTerminal("Pi Key");
        term.show();
        term.sendText(`export ${picked.envVar}=${key.trim()}`);
        vscode.window.showInformationMessage(
          `Key exported to terminal. Run pi to use it.`,
        );
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
