/** Subset of the OpenAI Chat Completions schema used by the relay. */

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type ContentPart = TextPart | ImagePart;
export type MessageContent = string | ContentPart[] | null;

export interface ToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role: ChatRole;
  content?: MessageContent;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek-style reasoning passthrough on assistant messages. */
  reasoning_content?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  tools?: ToolDef[];
  tool_choice?: unknown;
  stop?: string | string[] | null;
  n?: number;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
}

export const ZERO_USAGE = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: FinishReason;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: FinishReason;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Non-standard, harmless extras consumed by some clients. */
  context_window: number;
  max_output_tokens: number;
  vision: boolean;
  reasoning: boolean;
}

export interface ModelListResponse {
  object: "list";
  data: ModelInfo[];
}

export interface ApiErrorBody {
  error: { message: string; type: string; param?: string | null; code?: string | null };
}
