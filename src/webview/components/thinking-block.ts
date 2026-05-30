// ── ThinkingBlock component ────────────────────────────────────
//
// Collapsible thinking content block.  Owns the collapse/expand
// toggle state, fixing the "expanded content, collapsed arrow" bug.
//
// Used in assistant message stream to show model thinking.
//
// Props:
//   content  — the current thinking text (empty = initial state)
//   done     — true when thinking has completed (hides spinner)

import type { Component } from "./types.js";
import { html } from "../render/html.js";

export interface ThinkingBlockProps {
  content: string;
  done?: boolean;
}

export class ThinkingBlock implements Component<ThinkingBlockProps> {
  readonly el: HTMLElement;

  private contentEl: HTMLElement;
  private headerEl: HTMLElement;
  private expandBtn: HTMLElement;
  private spinnerEl: HTMLElement;
  private lineCountEl: HTMLElement;
  private arrowEl: HTMLElement;

  private _collapsed = true;

  constructor(props: ThinkingBlockProps) {
    this.el = document.createElement("div");
    this.el.className = "thinking-block thinking-collapsed";
    this.el.innerHTML = html`
      <div class="thinking-header">
        <span class="thinking-icon">💡</span>
        <span class="thinking-label">Thinking</span>
        <span class="thinking-spinner"></span>
        <span class="thinking-line-count"></span>
        <span class="thinking-arrow">▼</span>
      </div>
      <div class="thinking-content"></div>
      <button class="thinking-expand-btn" style="display:none">Show more</button>`;

    this.contentEl = this.el.querySelector(".thinking-content")!;
    this.headerEl = this.el.querySelector(".thinking-header")!;
    this.expandBtn = this.el.querySelector(".thinking-expand-btn")!;
    this.spinnerEl = this.el.querySelector(".thinking-spinner")!;
    this.lineCountEl = this.el.querySelector(".thinking-line-count")!;
    this.arrowEl = this.el.querySelector(".thinking-arrow")!;

    // Wire toggle
    this.expandBtn.addEventListener("click", (e) => { e.stopPropagation(); this.toggle(); });
    this.headerEl.addEventListener("click", () => this.toggle());

    // Set initial content via textContent (safe, no HTML parse)
    this.setContent(props.content);
    this.updateDisplay(props.done);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: ThinkingBlockProps): void {
    this.setContent(props.content);
    this.updateDisplay(props.done);
  }

  destroy(): void {
    this.el.remove();
  }

  // ── internal ──────────────────────────────────────────

  private setContent(content: string): void {
    this.contentEl.textContent = content;
    const lines = content ? content.split("\n").length : 0;
    this.lineCountEl.textContent = lines > 0 ? `(${lines} lines)` : "";
  }

  private updateDisplay(done?: boolean): void {
    if (done) {
      this.spinnerEl.remove();
      // Done: auto-collapse
      this.el.classList.add("thinking-collapsed");
      this._collapsed = true;
      this.expandBtn.style.display = "none";
      this.arrowEl.textContent = "▼";
    } else if (this.contentEl.textContent.length > 0) {
      // Streaming with content: auto-expand
      this.el.classList.remove("thinking-collapsed");
      this._collapsed = false;
      this.arrowEl.textContent = "▲";
    }
  }

  private toggle(): void {
    this._collapsed = !this._collapsed;
    if (this._collapsed) {
      this.el.classList.add("thinking-collapsed");
      this.expandBtn.textContent = "Show more";
      this.contentEl.scrollTop = 0;
      this.arrowEl.textContent = "▼";
    } else {
      this.el.classList.remove("thinking-collapsed");
      this.expandBtn.textContent = "Show less";
      this.arrowEl.textContent = "▲";
    }
  }

  /** Auto-scroll the content area to the bottom (for streaming). */
  scrollToBottom(): void {
    this.contentEl.scrollTop = this.contentEl.scrollHeight;
  }

  /** Whether the thinking block is currently collapsed. */
  get collapsed(): boolean {
    return this._collapsed;
  }
}
