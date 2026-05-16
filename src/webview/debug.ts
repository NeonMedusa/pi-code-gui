// ── Debug infrastructure ────────────────────────────────────
//
// Tracks every inbound message, DOM mutations, and internal
// state so we can answer "why did a block disappear?" without
// copy-pasting massive DOM trees.
//
// Exposes window.__piDebug for DevTools inspection and the
// /debug slash command.

import { state } from "./state.js";

// ── Debug state ───────────────────────────────────────────────
let debugEventLog = []; // [{ ts, type, dataKeys, callId, stackDepth }]
const debugMaxEvents = 500;
let debugDomLog = []; // [{ ts, action, elInfo }]
const debugMaxDomLog = 200;
let debugEnabled = true; // toggle via /debug on|off

// ── Queue event tracking ─────────────────────────────────────
let _queueEvents = [];

// ── MutationObserver ──────────────────────────────────────────
let debugObserver = null;

export function logEvent(type, data) {
  if (!debugEnabled) {return;}
  const entry = {
    ts: Date.now(),
    type,
    dataKeys: data ? Object.keys(data).slice(0, 10) : [],
    callId: data ? (data.toolCallId || data.entryId || "") : "",
    id: data ? (data.entryId || data.toolCallId || "") : "",
    fromMessage: data ? !!data.fromMessage : false,
    toolName: data ? (data.toolName || "") : "",
    stackDepth: new Error().stack ? new Error().stack.split("\n").length : 0,
  };
  debugEventLog.push(entry);
  if (debugEventLog.length > debugMaxEvents) {debugEventLog.shift();}
}

export function logDom(action, el) {
  if (!debugEnabled || !el || !el.tagName) {return;}
  const entry = {
    ts: Date.now(),
    action,
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: el.className || "",
    status: el.getAttribute ? el.getAttribute("data-status") : "",
    text: (el.textContent || "").slice(0, 80),
    parentId: el.parentElement
      ? el.parentElement.id || el.parentElement.className
      : "",
  };
  debugDomLog.push(entry);
  if (debugDomLog.length > debugMaxDomLog) {debugDomLog.shift();}
}

/** Snapshot all children of chatContainer for debugging. */
export function dumpChatStructure() {
  const children = [];
  const { chatContainer, bashBlocks, currentToolBlocks, bashOutputs } = state;

  if (!chatContainer) {return { totalChildren: 0, children: [] };}

  for (let i = 0; i < chatContainer.children.length; i++) {
    const c = chatContainer.children[i];
    let bashDetail = null;
    if (c.className && c.className.indexOf("bash-execution") !== -1) {
      const header = c.querySelector(".bash-header");
      const output = c.querySelector(".bash-output");
      const footer = c.querySelector(".bash-footer");
      bashDetail = {
        headerText: header ? header.textContent.slice(0, 120) : "MISSING",
        outputLen: output ? output.innerHTML.length : -1,
        outputText: output ? output.textContent.slice(0, 200) : "MISSING",
        footerText: footer ? footer.textContent : "MISSING",
        offsetHeight: c.offsetHeight,
        computedDisplay:
          c.style.display ||
          (typeof getComputedStyle !== "undefined"
            ? getComputedStyle(c).display
            : "?"),
        computedVisibility:
          typeof getComputedStyle !== "undefined"
            ? getComputedStyle(c).visibility
            : "?",
      };
    }
    children.push({
      idx: i,
      tag: c.tagName.toLowerCase(),
      id: c.id || "",
      classes: c.className || "",
      status: c.getAttribute ? c.getAttribute("data-status") : "",
      childCount: c.children.length,
      bashDetail,
    });
  }
  return {
    totalChildren: chatContainer.children.length,
    children,
    bashBlocksKeys: Object.keys(bashBlocks),
    currentToolBlocksKeys: Object.keys(currentToolBlocks),
    trackers: {
      bashBlocksCount: Object.keys(bashBlocks).length,
      currentToolBlocksCount: Object.keys(currentToolBlocks).length,
      bashOutputsCount: Object.keys(bashOutputs).length,
    },
  };
}

export function summary() {
  const s = dumpChatStructure();
  const el = debugEventLog.slice(-30);
  const dl = debugDomLog.slice(-30);

  const bKeys = new Set(Object.keys(state.bashBlocks));
  const tKeys = new Set(Object.keys(state.currentToolBlocks));
  const dupes = [];
  const orphanBash = [];
  const orphanTool = [];
  bKeys.forEach((k) => {
    if (tKeys.has(k)) {dupes.push(k);}
  });
  bKeys.forEach((k) => {
    if (!tKeys.has(k)) {orphanBash.push(k);}
  });
  tKeys.forEach((k) => {
    if (!bKeys.has(k)) {orphanTool.push(k);}
  });

  return {
    chat: s,
    dupes,
    orphanBash,
    orphanTool,
    lastEvents: el,
    lastDomChanges: dl,
  };
}

// ── Public debug API (attached to window for DevTools) ────────

window.__piDebug = {
  enabled(on) {
    debugEnabled = on;
    return debugEnabled;
  },
  dumpState: dumpChatStructure,
  eventLog(n) {
    return debugEventLog.slice(-(n || 50));
  },
  domLog(n) {
    return debugDomLog.slice(-(n || 50));
  },
  bashBlocks() {
    return Object.keys(state.bashBlocks).map((k) => ({
      id: k,
      status: state.bashBlocks[k].getAttribute
        ? state.bashBlocks[k].getAttribute("data-status")
        : "?",
      tag: state.bashBlocks[k].tagName,
    }));
  },
  toolBlocks() {
    return Object.keys(state.currentToolBlocks).map((k) => {
      const e = state.currentToolBlocks[k];
      const el = e.el || e;
      return {
        id: k,
        status: el.getAttribute ? el.getAttribute("data-status") : "?",
        tag: el.tagName,
        hasRenderer: !!e.renderer,
      };
    });
  },
  summary,
  _queueEvents,
};

// ── MutationObserver setup ───────────────────────────────────

export function initDebugObserver() {
  if (typeof MutationObserver === "undefined") {return;}
  debugObserver = new MutationObserver((mutations) => {
    if (!debugEnabled) {return;}
    mutations.forEach((m) => {
      for (let i = 0; i < m.addedNodes.length; i++) {
        logDom("added", m.addedNodes[i]);
      }
      for (let j = 0; j < m.removedNodes.length; j++) {
        logDom("removed", m.removedNodes[j]);
      }
    });
  });
  if (state.chatContainer) {
    debugObserver.observe(state.chatContainer, { childList: true });
  }
}

// Expose for debug access
export { debugEventLog, debugEnabled };
