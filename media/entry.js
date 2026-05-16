// Thin entry point for esbuild webview bundling.
// Imports the two external libs (which attach to window) and the main app.

import "./lib/morphdom.js";
import "./marked.min.js";
import "../src/webview/main.js";
