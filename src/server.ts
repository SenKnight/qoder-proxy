import { timingSafeEqual } from "node:crypto";
import { createServer as httpCreateServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { completionId, emptyUsage, SSE_DONE, sseData, sseHeaders } from "./openai/sse.js";
import type {
  ApiErrorBody,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  FinishReason,
  ModelInfo,
  ModelListResponse,
} from "./openai/types.js";
import { QoderAuth } from "./qoder/auth.js";
import { streamQoderChat } from "./qoder/chat.js";
import type { QoderRoute } from "./qoder/cosy.js";
import { QoderModelCatalog } from "./qoder/models.js";
import { VERSION } from "./version.js";

export interface RelayContext {
  config: Config;
  route: QoderRoute;
  auth: QoderAuth;
  catalog: QoderModelCatalog;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** An error carrying an explicit HTTP status for the client. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function createRelay(config: Config): RelayContext {
  setLogLevel(config.logLevel);
  const route: QoderRoute = config.vpcInstance
    ? { mode: config.mode, vpcInstance: config.vpcInstance }
    : { mode: config.mode };
  const auth = new QoderAuth(config.pat, route);
  const catalog = new QoderModelCatalog(
    route,
    async () => {
      const session = await auth.getSession();
      return {
        userID: session.userID,
        authToken: session.access,
        name: session.name,
        email: session.email,
        machineID: session.machineID,
      };
    },
    config.cosyDebug,
    config.modelCacheTtlMs,
  );
  return { config, route, auth, catalog };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  const body: ApiErrorBody = { error: { message, type, param: null, code: null } };
  sendJson(res, status, body);
}

/** Write to the response, ignoring writes to an already-closed connection. */
function safeWrite(res: ServerResponse, data: string): void {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(data);
  } catch {}
}

function safeEnd(res: ServerResponse): void {
  try {
    if (!res.writableEnded) res.end();
  } catch {}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function isAuthorized(config: Config, req: IncomingMessage): boolean {
  if (!config.clientApiKey) return true;
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const provided = bearer || (req.headers["x-api-key"] as string | undefined) || "";
  const expected = config.clientApiKey;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function toModelInfo(config: Config, def: ReturnType<RelayContext["catalog"]["list"]>[number]): ModelInfo {
  return {
    id: def.id,
    object: "model",
    created: 0,
    owned_by: config.mode === "cn" ? "qoder-cn" : "qoder",
    context_window: def.contextWindow,
    max_output_tokens: def.maxTokens,
    vision: def.vision,
    reasoning: def.reasoning,
  };
}

function normalizeRequest(config: Config, body: unknown): ChatCompletionRequest {
  if (!body || typeof body !== "object") throw new HttpError(400, "Request body must be a JSON object");
  const req = body as ChatCompletionRequest;
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array");
  }
  if (!req.model) req.model = config.defaultModel;
  return req;
}

function chunkFor(
  id: string,
  model: string,
  created: number,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: FinishReason,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Aggregate a non-streaming completion from the Qoder event stream. */
async function collectCompletion(
  ctx: RelayContext,
  req: ChatCompletionRequest,
  id: string,
  model: string,
  created: number,
  signal: AbortSignal,
): Promise<ChatCompletion> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish: FinishReason = "stop";

  for await (const event of streamQoderChat(
    {
      route: ctx.route,
      auth: ctx.auth,
      catalog: ctx.catalog,
      debug: ctx.config.cosyDebug,
      timeoutMs: ctx.config.requestTimeoutMs,
    },
    {
      model,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.max_tokens || req.max_completion_tokens
        ? { maxTokens: req.max_tokens || req.max_completion_tokens }
        : {}),
      ...(req.reasoning_effort ? { reasoningEffort: req.reasoning_effort } : {}),
      signal,
    },
  )) {
    if (event.type === "text") contentParts.push(event.text);
    else if (event.type === "reasoning") reasoningParts.push(event.text);
    else if (event.type === "tool_call") {
      const state = toolCalls.get(event.index) || { id: event.id || "", name: event.name || "", arguments: "" };
      if (event.id) state.id = event.id;
      if (event.name) state.name = event.name;
      if (event.argumentsDelta) state.arguments += event.argumentsDelta;
      toolCalls.set(event.index, state);
    } else if (event.type === "finish") finish = event.reason;
  }

  const message: ChatCompletionMessage = {
    role: "assistant",
    content: contentParts.length > 0 ? contentParts.join("") : toolCalls.size === 0 ? "" : null,
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: emptyUsage(),
  };
}

async function handleStreaming(
  ctx: RelayContext,
  req: ChatCompletionRequest,
  res: ServerResponse,
  id: string,
  model: string,
  created: number,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(200, {
    ...sseHeaders(),
    ...corsHeaders(),
  });
  safeWrite(res, sseData(chunkFor(id, model, created, { role: "assistant", content: "" }, null)));

  const toolCalls = new Map<number, { id: string; name: string }>();
  let finish: FinishReason = "stop";

  try {
    for await (const event of streamQoderChat(
      {
        route: ctx.route,
        auth: ctx.auth,
        catalog: ctx.catalog,
        debug: ctx.config.cosyDebug,
        timeoutMs: ctx.config.requestTimeoutMs,
      },
      {
        model,
        messages: req.messages,
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.max_tokens || req.max_completion_tokens
          ? { maxTokens: req.max_tokens || req.max_completion_tokens }
          : {}),
        ...(req.reasoning_effort ? { reasoningEffort: req.reasoning_effort } : {}),
        signal,
      },
    )) {
      if (event.type === "text") {
        safeWrite(res, sseData(chunkFor(id, model, created, { content: event.text }, null)));
      } else if (event.type === "reasoning") {
        safeWrite(res, sseData(chunkFor(id, model, created, { reasoning_content: event.text }, null)));
      } else if (event.type === "tool_call") {
        const state = toolCalls.get(event.index) || { id: "", name: "" };
        if (event.id) state.id = event.id;
        if (event.name) state.name = event.name;
        toolCalls.set(event.index, state);
        const callDelta: NonNullable<
          NonNullable<ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]>[number]
        > = {
          index: event.index,
          type: "function",
        };
        if (state.id) callDelta.id = state.id;
        const fn: { name?: string; arguments?: string } = {};
        if (event.name) fn.name = event.name;
        if (event.argumentsDelta) fn.arguments = event.argumentsDelta;
        if (fn.name !== undefined || fn.arguments !== undefined) callDelta.function = fn;
        safeWrite(res, sseData(chunkFor(id, model, created, { tool_calls: [callDelta] }, null)));
      } else if (event.type === "finish") {
        finish = event.reason;
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("stream failed", { error: message });
      safeWrite(res, sseData({ error: { message, type: "upstream_error", code: null, param: null } }));
    }
    safeWrite(res, SSE_DONE);
    safeEnd(res);
    return;
  }

  safeWrite(res, sseData(chunkFor(id, model, created, {}, finish)));
  if (req.stream_options?.include_usage) {
    const usageChunk: ChatCompletionChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: emptyUsage(),
    };
    safeWrite(res, sseData(usageChunk));
  }
  safeWrite(res, SSE_DONE);
  safeEnd(res);
}

async function handleChatCompletions(ctx: RelayContext, body: unknown, res: ServerResponse): Promise<void> {
  const chatReq = normalizeRequest(ctx.config, body);
  const model = chatReq.model as string;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  });

  // Make sure the model catalog is warm so thinking/effort config is correct.
  await ctx.catalog.ensureFresh();

  if (chatReq.stream) {
    await handleStreaming(ctx, chatReq, res, id, model, created, controller.signal);
    return;
  }

  const completion = await collectCompletion(ctx, chatReq, id, model, created, controller.signal);
  sendJson(res, 200, completion);
}

async function route(ctx: RelayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    sendJson(res, 200, {
      status: "ok",
      service: "qoder-proxy",
      version: VERSION,
      mode: ctx.config.mode,
      auth_required: Boolean(ctx.config.clientApiKey),
      default_model: ctx.config.defaultModel,
    });
    return;
  }

  if (!isAuthorized(ctx.config, req)) {
    sendError(res, 401, "Invalid API key", "authentication_error");
    return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    await ctx.catalog.ensureFresh();
    const list: ModelListResponse = {
      object: "list",
      data: ctx.catalog.list().map((def) => toModelInfo(ctx.config, def)),
    };
    sendJson(res, 200, list);
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/completions")) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : "Invalid request body");
      return;
    }
    await handleChatCompletions(ctx, body, res);
    return;
  }

  sendError(res, 404, `Unknown route: ${req.method} ${path}`);
}

export function createRelayServer(ctx: RelayContext): Server {
  return httpCreateServer((req, res) => {
    route(ctx, req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpError) {
        if (!res.headersSent) sendError(res, error.status, message, error.type);
        else if (!res.writableEnded) res.end();
        return;
      }
      logger.error("request failed", { error: message });
      if (!res.headersSent) sendError(res, 500, message, "server_error");
      else if (!res.writableEnded) res.end();
    });
  });
}
