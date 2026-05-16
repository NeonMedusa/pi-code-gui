// ── Global type declarations for the webview ─────────────────

// VS Code API (provided by the webview host)
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// External libraries loaded as globals
declare var marked: {
  parse(text: string): string;
  lexer(text: string): Array<{ type: string; raw: string; [key: string]: unknown }>;
  setOptions(opts: Record<string, unknown>): void;
};
declare var morphdom: (
  from: Node,
  to: Node,
  opts?: { childrenOnly?: boolean },
) => void;

// Custom properties on Window
interface Window {
  __piDebug: {
    enabled(on: boolean): boolean;
    dumpState(): unknown;
    eventLog(n?: number): unknown[];
    domLog(n?: number): unknown[];
    bashBlocks(): unknown[];
    toolBlocks(): unknown[];
    summary(): unknown;
    _queueEvents?: unknown[];
  };
  __piRegisterToolRenderer?: (name: string, renderer: unknown) => void;
  __piRegisterMessageRenderer?: (
    type: string,
    renderer: (data: unknown, ...args: unknown[]) => void,
  ) => void;
  __vscode: ReturnType<typeof acquireVsCodeApi>;
}

// Allow custom properties on HTMLElement
interface HTMLElement {
  _writeState?: { content: string; lang?: string; rawPath?: string };
  _writePending?: string;
  _writeRafId?: number;
  _editEdits?: unknown[];
  _readState?: { rawPath: string; lang?: string; compact?: unknown };
  _readCollapseState?: {
    previewText: string;
    fullText: string;
    lang?: string;
    remaining: number;
    totalLines: number;
    expanded: boolean;
  };
  _spinnerInterval?: ReturnType<typeof setInterval>;
  _countdownInterval?: ReturnType<typeof setInterval>;
}
