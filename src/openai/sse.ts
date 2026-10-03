import type { Usage } from "./types.js";

/** Serialize one Server-Sent Event line for an OpenAI streaming response. */
export function sseData(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

let counter = 0;

/** Generate an OpenAI-style completion id, e.g. `chatcmpl-1a2b3c4d`. */
export function completionId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.random().toString(36).slice(2, 10);
  return `chatcmpl-${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Standard SSE headers, plus no-cache / no-buffering hints for proxies. */
export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function emptyUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
