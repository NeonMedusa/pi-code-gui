import type { Component } from "./types.js";
import { html } from "../render/html.js";

export interface ToolBlockProps {
  toolName: string;
  toolCallId: string;
  entryId?: string;
  filePath?: string;
  status?: "pending" | "running" | "done" | "error";
  pathExtra?: string;
}

export class ToolBlock implements Component<ToolBlockProps> {
  readonly el: HTMLElement;

  private headerEl: HTMLElement;
  private nameEl: HTMLElement;
  private pathEl: HTMLElement | null = null;
  private statusEl: HTMLElement;
  private bodyEl: HTMLElement;
  private contentEl: HTMLElement;
  private resultEl: HTMLElement;
  private arrowEl: HTMLElement;

  private _filePath: string | null = null;
  private _collapsed = false;

  constructor(props: ToolBlockProps) {
    this.el = document.createElement("div");
    this.el.className = "tool-block";
    this.el.id = props.entryId
      ? "entry-" + props.entryId
      : "tool-" + props.toolCallId;
    this.el.setAttribute("data-tool-call-id", props.toolCallId);
    if (props.entryId) { this.el.setAttribute("data-entry-id", props.entryId); }
    this.el.setAttribute("data-status", props.status || "pending");

    const fp = props.filePath || "";
    this._filePath = fp;
    const pathDisplay = shortPath(fp) || "...";

    const toolsIcon: Record<string, string> = { write: "✏️", read: "📖", edit: "🔧" };
    const icon = toolsIcon[props.toolName] || "🛠️";

    this.el.innerHTML = html`
      <div class="tool-block-inner">
        <div class="tool-header">
          <span class="tool-header-icon">${icon}</span>
          <span class="tool-name">${props.toolName}</span>
          <span class="tool-path" data-path="${fp}" title="Click to open file">${pathDisplay}${props.pathExtra || ""}</span>
          <span class="tool-status ${props.status || "pending"}">${props.status || "pending"}</span>
          <span class="tool-arrow">▼</span>
        </div>
        <div class="tool-body">
          <div class="tool-content"></div>
          <div class="tool-result"></div>
        </div>
      </div>`;

    this.headerEl = this.el.querySelector(".tool-header")!;
    this.nameEl = this.el.querySelector(".tool-name")!;
    this.pathEl = this.el.querySelector(".tool-path");
    this.statusEl = this.el.querySelector(".tool-status")!;
    this.bodyEl = this.el.querySelector(".tool-body")!;
    this.contentEl = this.el.querySelector(".tool-content")!;
    this.resultEl = this.el.querySelector(".tool-result")!;
    this.arrowEl = this.el.querySelector(".tool-arrow")!;

    // Wire toggle
    this.headerEl.addEventListener("click", (e) => {
      // Don't toggle when clicking the file path (it has its own action)
      if ((e.target as HTMLElement).classList.contains("tool-path")) { return; }
      this.toggle();
    });

    // Wire file path click → open in VS Code
    if (this.pathEl) {
      this.pathEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._filePath) {
          window.__vscode.postMessage({ type: "openFile", path: this._filePath });
        }
      });
    }
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: ToolBlockProps): void {
    if (props.status) {
      this.el.setAttribute("data-status", props.status);
      this.statusEl.textContent = props.status;
      this.statusEl.className = "tool-status " + props.status;

      // Auto-collapse when done (unless per-tool default is expanded)
      if (props.status === "done" || props.status === "error") {
        var keepExpanded = (window.__blockDefaults as any)?.[props.toolName] === "expanded";
        if (keepExpanded) {
          this._collapsed = false;
          this.bodyEl.style.display = "";
          this.arrowEl.textContent = "▲";
        } else {
          this._collapsed = true;
          this.bodyEl.style.display = "none";
          this.arrowEl.textContent = "▼";
        }
      }
    }
    if (props.filePath !== undefined) {
      this._filePath = props.filePath;
      if (this.pathEl) {
        this.pathEl.textContent = shortPath(props.filePath) || "...";
        this.pathEl.setAttribute("data-path", props.filePath || "");
      }
    }
    if (props.pathExtra !== undefined && this.pathEl) {
      const fp = this._filePath || "...";
      this.pathEl.textContent = shortPath(fp) + props.pathExtra;
    }
    if (props.entryId) {
      this.el.id = "entry-" + props.entryId;
      this.el.setAttribute("data-entry-id", props.entryId);
    }
  }

  destroy(): void {
    this.el.remove();
  }

  // ── Collapse/expand ─────────────────────────────────

  set streaming(val: boolean) {
    if (val) {
      this._collapsed = false;
      this.bodyEl.style.display = "";
      this.arrowEl.textContent = "▲";
    }
  }

  private toggle(): void {
    this._collapsed = !this._collapsed;
    this.bodyEl.style.display = this._collapsed ? "none" : "";
    this.arrowEl.textContent = this._collapsed ? "▼" : "▲";
  }

  // ── Public accessors ─────────────────────────────────

  getContentEl(): HTMLElement {
    return this.contentEl;
  }

  getResultEl(): HTMLElement {
    return this.resultEl;
  }

  getHeaderEl(): HTMLElement {
    return this.headerEl;
  }

  getPathEl(): HTMLElement | null {
    return this.pathEl;
  }

  getStatusEl(): HTMLElement {
    return this.statusEl;
  }
}

/** Extract filename from a full path */
function shortPath(path: string): string {
  if (!path) { return ""; }
  var normalized = path.replace(/\\/g, "/");
  var parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}
