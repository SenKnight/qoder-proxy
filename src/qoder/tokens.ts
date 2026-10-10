import type { TransformedConversation } from "./transform.js";

/**
 * Local token accounting for OpenAI-style `usage`.
 *
 * The upstream Qoder gateway does not report usage, so the relay estimates
 * prompt and completion tokens from the text it actually sends and receives.
 * The heuristic mirrors common practice for mixed CJK/Latin text: each CJK or
 * wide character counts as one token, and other spans count ~4 UTF-8 bytes per
 * token. It is an estimate (exact counting needs a per-model tokenizer), but
 * tracks real traffic rather than returning zeros.
 */

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals / punctuation
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana / Katakana
    (code >= 0x3130 && code <= 0x318f) || // Hangul compatibility jamo
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth / halfwidth forms
    (code >= 0x20000 && code <= 0x2ffff) // CJK extensions B+
  );
}

/** Estimate the token count of a text run (CJK chars ≈ 1, ASCII ≈ 4 bytes). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiBytes = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isWideChar(code)) {
      wide += 1;
    } else if (code < 0x80) {
      asciiBytes += 1;
    } else {
      // Other Unicode (emoji, accents, symbols): count one token per char.
      wide += 1;
    }
  }
  return wide + Math.ceil(asciiBytes / 4);
}

/** Rough cost of one image part (OpenAI low-detail images are 85 tokens). */
const IMAGE_TOKENS = 85;

/** Fixed per-message overhead (role marker and separators in the prompt). */
const MESSAGE_OVERHEAD = 4;

/**
 * Estimate prompt tokens from the conversation actually sent upstream:
 * system text, every message (content, tool-call names/arguments, tool ids)
 * and the tool definitions, plus a small per-message overhead.
 */
export function estimatePromptTokens(conversation: TransformedConversation): number {
  let tokens = 0;
  if (conversation.system) tokens += estimateTokens(conversation.system) + 2;

  for (const msg of conversation.messages) {
    tokens += MESSAGE_OVERHEAD;
    if (typeof msg.content === "string") {
      tokens += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text") tokens += estimateTokens(part.text);
        else if (part?.type === "image_url") tokens += IMAGE_TOKENS;
      }
    }
    for (const call of msg.tool_calls ?? []) {
      tokens += estimateTokens(call.function?.name ?? "") + estimateTokens(call.function?.arguments ?? "");
    }
    if (msg.tool_call_id) tokens += estimateTokens(msg.tool_call_id);
  }

  for (const tool of conversation.tools ?? []) {
    tokens += estimateTokens(JSON.stringify(tool));
  }
  return tokens;
}
