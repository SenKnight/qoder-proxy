import { describe, expect, it } from "vitest";
import { lastUserText, transformMessages, transformTools } from "../src/qoder/transform.js";

describe("transformMessages", () => {
  it("hoists system and developer content into the system field", () => {
    const result = transformMessages([
      { role: "system", content: "You are helpful." },
      { role: "developer", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);
    expect(result.system).toBe("You are helpful.\n\nBe terse.");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps multimodal user parts and drops empty ones", () => {
    const result = transformMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("collapses text-only part arrays into a string", () => {
    const result = transformMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(result.messages[0]?.content).toBe("ab");
  });

  it("preserves assistant reasoning as <thinking> and maps tool calls", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: "done",
        reasoning_content: "let me think",
        tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: '{"q":"x"}' } }],
      },
    ]);
    const msg = result.messages[0];
    expect(msg?.role).toBe("assistant");
    expect(msg?.content).toBe("<thinking>let me think</thinking>\n\ndone");
    expect(msg?.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
  });

  it("maps tool results with their tool_call_id", () => {
    const result = transformMessages([{ role: "tool", tool_call_id: "call_1", content: "42" }]);
    expect(result.messages[0]).toEqual({ role: "tool", tool_call_id: "call_1", content: "42" });
  });
});

describe("transformTools", () => {
  it("returns undefined for an empty list and defaults parameters", () => {
    expect(transformTools([])).toBeUndefined();
    const tools = transformTools([{ type: "function", function: { name: "f" } }]);
    expect(tools?.[0]?.function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("lastUserText", () => {
  it("returns the most recent user text", () => {
    const { messages } = transformMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "image_url", image_url: { url: "x" } },
        ],
      },
    ]);
    expect(lastUserText(messages)).toBe("second");
  });
});
