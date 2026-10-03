import crypto from "node:crypto";
import { logger } from "../logger.js";
import type { ChatMessage, ToolDef } from "../openai/types.js";
import type { QoderAuth } from "./auth.js";
import {
  buildAuthHeaders,
  formatQoderHttpError,
  getQoderChatURL,
  logCosyRequest,
  logCosyResponse,
  type QoderRoute,
} from "./cosy.js";
import { qoderEncodeBody } from "./encoding.js";
import type { QoderModelCatalog, QoderModelEntry } from "./models.js";
import { lastUserText, type QoderMessage, transformMessages, transformTools } from "./transform.js";

export interface ChatDeps {
  route: QoderRoute;
  auth: QoderAuth;
  catalog: QoderModelCatalog;
  debug: boolean;
  /** Caps total request duration (ms). 0 disables the internal timeout. */
  timeoutMs: number;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export type QoderFinishReason = "stop" | "tool_calls" | "length";

/** Normalized streaming events emitted by the Qoder adapter. */
export type QoderEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "finish"; reason: QoderFinishReason };

interface ToolCallState {
  id: string;
  name: string;
}

interface QoderToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface QoderResponseDelta {
  reasoning_content?: string;
  content?: string;
  tool_calls?: QoderToolCallDelta[];
}

interface QoderSseEnvelope {
  statusCodeValue?: number;
  body?: string;
}

interface QoderSseBody {
  choices?: Array<{ delta?: QoderResponseDelta }>;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (signal && timeout) return AbortSignal.any([signal, timeout]);
  return signal ?? timeout;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableRecordId(model: string, messages: QoderMessage[], tools: unknown, maxTokens: number): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update(`\0${model}`);
  for (const msg of messages) {
    hash.update(`\0${msg.role}`);
    if (msg.content) hash.update(`\0${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
  }
  if (tools) hash.update(`\0${JSON.stringify(tools)}`);
  hash.update(`\0mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

function resolveEffort(entry: QoderModelEntry | undefined, requested?: string): string | undefined {
  if (!requested) return undefined;
  const efforts = entry?.thinking_config?.enabled?.efforts;
  if (efforts?.[requested]) return requested;
  return undefined;
}

function applyEffort(entry: QoderModelEntry | undefined, effort: string | undefined): QoderModelEntry | undefined {
  if (!entry || !effort) return entry;
  const configured = entry.thinking_config?.enabled?.efforts;
  if (!configured?.[effort]) return entry;
  const efforts = Object.fromEntries(
    Object.entries(configured).map(([name, config]) => [name, { ...config, is_default: name === effort }]),
  );
  return {
    ...entry,
    is_reasoning: true,
    thinking_config: {
      ...entry.thinking_config,
      disabled: { ...entry.thinking_config?.disabled, is_default: false },
      enabled: { ...entry.thinking_config?.enabled, is_default: true, efforts },
    },
  };
}

function buildRequestBody(
  session: { userID: string },
  wireKey: string,
  modelConfig: QoderModelEntry,
  conversation: { system: string; messages: QoderMessage[]; tools?: unknown },
  params: ChatParams,
): Record<string, unknown> {
  const normalized = conversation.messages;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutput = modelConfig.max_output_tokens || 32_768;
  let maxTokens = maxOutput > 0 ? maxOutput : 32_768;
  if (params.maxTokens && params.maxTokens < maxTokens) maxTokens = params.maxTokens;

  const lastText = lastUserText(normalized);
  const sessionID = stableHash("qoder-session", session.userID, wireKey);
  const recordID = stableRecordId(wireKey, normalized, conversation.tools, maxTokens);
  const effort = resolveEffort(modelConfig, params.reasoningEffort);

  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: conversation.system,
    messages: normalized,
    tools: conversation.tools || [],
    parameters: {
      max_tokens: maxTokens,
      ...(effort ? { reasoning_effort: effort } : {}),
    },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: wireKey, is_reasoning: isReasoning },
        originalContent: lastText,
      },
      features: [],
      text: lastText,
    },
    model_config: modelConfig,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: lastText.substring(0, 30),
      begin_at: Date.now(),
    },
  };
}

async function* parseStream(response: Response, modelKey: string, debug: boolean): AsyncGenerator<QoderEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder returned no response body");
  const decoder = new TextDecoder();
  let buffer = "";

  const toolCalls = new Map<number, ToolCallState>();
  let producedContent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === "[DONE]") continue;

      let envelope: QoderSseEnvelope;
      try {
        envelope = JSON.parse(dataStr) as QoderSseEnvelope;
      } catch {
        continue;
      }
      if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
        throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body ?? ""}`);
      }
      const innerStr = envelope.body;
      if (!innerStr || innerStr === "[DONE]") continue;

      let inner: QoderSseBody;
      try {
        inner = JSON.parse(String(innerStr)) as QoderSseBody;
      } catch {
        continue;
      }

      const delta = inner.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        producedContent = true;
        yield { type: "reasoning", text: delta.reasoning_content };
      }
      if (delta.content) {
        producedContent = true;
        yield { type: "text", text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let state = toolCalls.get(index);
          if (!state) {
            state = { id: tc.id || "", name: tc.function?.name || "" };
            toolCalls.set(index, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          producedContent = true;
          yield {
            type: "tool_call",
            index,
            ...(state.id ? { id: state.id } : {}),
            ...(tc.function?.name ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments ? { argumentsDelta: tc.function.arguments } : {}),
          };
        }
      }
    }
  }

  if (debug) logger.debug("stream complete", { model: modelKey, toolCalls: toolCalls.size });
  if (!producedContent) throw new Error("Qoder upstream completed without assistant content");
  yield { type: "finish", reason: toolCalls.size > 0 ? "tool_calls" : "stop" };
}

async function openChatStream(deps: ChatDeps, params: ChatParams): Promise<Response> {
  const session = await deps.auth.getSession();
  const wireKey = deps.catalog.resolveWireKey(params.model);
  const catalogEntry = deps.catalog.getEntry(params.model);
  const effort = resolveEffort(catalogEntry, params.reasoningEffort);
  const conversation = transformMessages(params.messages);
  conversation.tools = transformTools(params.tools);

  const modelConfig: QoderModelEntry = {
    ...(catalogEntry ?? { is_reasoning: false, max_output_tokens: 32_768, source: "system" }),
    key: wireKey,
  };
  const configuredConfig = effort ? applyEffort(modelConfig, effort) : modelConfig;

  const reqBody = buildRequestBody(session, wireKey, configuredConfig as QoderModelEntry, conversation, params);
  const bodyBytes = Buffer.from(JSON.stringify(reqBody), "utf8");
  const encoded = Buffer.from(qoderEncodeBody(bodyBytes), "utf8");
  const chatURL = getQoderChatURL(deps.route);

  const headers = buildAuthHeaders(encoded, chatURL, {
    userID: session.userID,
    authToken: session.access,
    name: session.name,
    email: session.email,
    machineID: session.machineID,
  });
  logCosyRequest(deps.debug, "POST", chatURL, headers);

  const response = await fetch(chatURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": wireKey,
      "X-Model-Source": modelConfig.source || "system",
      ...headers,
    },
    body: encoded,
    signal: combineSignal(params.signal, deps.timeoutMs),
  });
  await logCosyResponse(deps.debug, chatURL, response);
  return response;
}

/**
 * Stream a chat completion from Qoder, emitting normalized events.
 *
 * A 401/403 opens one automatic retry after forcing a fresh access token, so a
 * job token that expired mid-flight does not fail the client request.
 */
export async function* streamQoderChat(deps: ChatDeps, params: ChatParams): AsyncGenerator<QoderEvent> {
  let response = await openChatStream(deps, params);

  if (response.status === 401 || response.status === 403) {
    const errText = await response.text().catch(() => "");
    logger.warn("chat rejected, renewing credentials", { status: response.status });
    await deps.auth.forceRenew();
    response = await openChatStream(deps, params);
    if (response.status === 401 || response.status === 403) {
      const retryText = await response.text().catch(() => "");
      throw new Error(
        formatQoderHttpError(
          "api",
          response.status,
          response.statusText,
          retryText || errText,
          getQoderChatURL(deps.route),
        ),
      );
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      formatQoderHttpError("api", response.status, response.statusText, errText, getQoderChatURL(deps.route)),
    );
  }

  yield* parseStream(response, deps.catalog.resolveWireKey(params.model), deps.debug);
}
