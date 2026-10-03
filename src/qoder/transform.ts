import type { ChatMessage, ContentPart, MessageContent, ToolDef } from "../openai/types.js";

/** OpenAI-style message sent to the Qoder API. */
export interface QoderMessage {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id?: string; type: "function"; function: { name?: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface QoderTool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface TransformedConversation {
  system: string;
  messages: QoderMessage[];
  tools?: QoderTool[];
}

function contentToText(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

function normalizeUserContent(content: MessageContent | undefined): string | ContentPart[] | null {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const hasImage = content.some((part) => part?.type === "image_url");
  if (!hasImage) return contentToText(content);
  return content.filter((part): part is ContentPart => part?.type === "text" || part?.type === "image_url");
}

export function transformTools(tools?: ToolDef[]): QoderTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const mapped: QoderTool[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (!fn?.name) continue;
    mapped.push({
      type: "function",
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Convert an OpenAI chat request's messages into the Qoder shape:
 * system/developer content is hoisted into the top-level `system` field, and
 * the remaining turns map role-for-role. Assistant `reasoning_content` is
 * preserved as inline `<thinking>` tags (Qoder's convention).
 */
export function transformMessages(messages: ChatMessage[]): TransformedConversation {
  const systemParts: string[] = [];
  const out: QoderMessage[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToText(msg.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: normalizeUserContent(msg.content) });
      continue;
    }

    if (msg.role === "assistant") {
      let content = contentToText(msg.content);
      if (msg.reasoning_content) content = `<thinking>${msg.reasoning_content}</thinking>\n\n${content}`;
      const mapped: QoderMessage = { role: "assistant", content };
      const toolCalls = (msg.tool_calls || [])
        .filter((call) => call?.function?.name)
        .map((call, index) => ({
          id: call.id || `call_${index}`,
          type: "function" as const,
          function: {
            name: call.function?.name,
            arguments:
              typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
          },
        }));
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      out.push(mapped);
      continue;
    }

    if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: msg.tool_call_id || "",
        content: contentToText(msg.content),
      });
    }
  }

  return { system: systemParts.join("\n\n"), messages: out, tools: undefined };
}

/** Text of the last user turn (fallback text when content is multimodal). */
export function lastUserText(messages: QoderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    }
  }
  return "";
}
