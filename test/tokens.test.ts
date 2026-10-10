import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/openai/types.js";
import { estimatePromptTokens, estimateTokens } from "../src/qoder/tokens.js";
import { transformMessages, transformTools } from "../src/qoder/transform.js";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts ASCII text at roughly 4 bytes per token", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a")).toBe(1);
  });

  it("counts CJK characters one token each", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("mixes CJK and ASCII segments", () => {
    expect(estimateTokens("你好 world")).toBe(4);
  });

  it("counts non-ASCII symbols as one token each", () => {
    expect(estimateTokens("🚀")).toBe(1);
  });
});

describe("estimatePromptTokens", () => {
  const toConversation = (messages: ChatMessage[]) => {
    const conversation = transformMessages(messages);
    conversation.tools = undefined;
    return conversation;
  };

  it("includes system text and per-message overhead", () => {
    const conversation = toConversation([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ]);
    const tokens = estimatePromptTokens(conversation);
    // system text (4) + 2 + user overhead (4) + user text (2)
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(12);
  });

  it("counts tool definitions and tool-call history", () => {
    const conversation = toConversation([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ]);
    conversation.tools = transformTools([
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    ]);
    const tokens = estimatePromptTokens(conversation);
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts image parts with a fixed per-image estimate", () => {
    const withoutImage = estimatePromptTokens(toConversation([{ role: "user", content: "hi" }]));
    const withImage = estimatePromptTokens(
      toConversation([
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]),
    );
    expect(withImage).toBe(withoutImage + 85);
  });
});
