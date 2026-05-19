/** Image content for prompt attachments */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

/** Webview message for prompt with optional images */
export interface PromptMessage {
  type: "prompt";
  text: string;
  images?: ImageContent[];
}

// Re-export shared protocol types and schemas.
// PiServiceEvent is now derived from the Zod schema (source of truth).
export {
  type ExtensionToWebview,
  type WebviewToExtension,
  type PiServiceEvent,
  validateExtensionToWebview,
  validateWebviewToExtension,
  isExtensionToWebview,
} from "./shared/protocol.js";

export type { ValidationResult, ValidationError } from "./shared/protocol.js";
