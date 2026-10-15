import { createServer as httpCreateServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { modelIdSuffix } from "../src/qoder/models.js";
import { createRelay, createRelayServer, type RelayContext } from "../src/server.js";

const CN_SUFFIX = modelIdSuffix("cn");

let upstream: Server;
let relay: Server;
let relayBase = "";
let lastChatBody = "";

function sseEnvelope(delta: object): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta }] }) })}\n\n`;
}

/** Reverse of the upstream WAF encoding, used to inspect the chat body in tests. */
function qoderDecodeBody(encoded: string): string {
  const customAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
  const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let rearranged = "";
  for (const c of encoded) {
    if (c === "$") rearranged += "=";
    else {
      const idx = customAlphabet.indexOf(c);
      rearranged += idx >= 0 ? stdAlphabet[idx] : c;
    }
  }
  const n = rearranged.length;
  const a = Math.floor(n / 3);
  const std = rearranged.slice(n - a) + rearranged.slice(a, n - a) + rearranged.slice(0, a);
  return Buffer.from(std, "base64").toString("utf8");
}

function start(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeAll(async () => {
  upstream = httpCreateServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/v1/jobToken/exchange") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "jt-test", refresh_token: "jrt-test", expires_in: 86_400_000 }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/userinfo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "user-1", email: "u@example.com", name: "Relay User" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/algo/api/v2/model/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          chat: [
            {
              key: "auto",
              enable: true,
              display_name: "Auto",
              is_reasoning: true,
              is_vl: true,
              max_output_tokens: 8192,
              max_input_tokens: 180000,
              thinking_config: {
                enabled: { is_default: true, efforts: { high: { is_default: true } } },
                disabled: { is_default: false },
              },
            },
            { key: "qmodel", enable: true, display_name: "Qwen3.7 Plus", is_vl: false, max_output_tokens: 4096 },
            { key: "disabled", enable: false, display_name: "Nope" },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/agent_chat_generation")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        lastChatBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (req.headers["x-model-key"] === "qmodel") {
          res.write(
            sseEnvelope({
              tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":' } }],
            }),
          );
          res.write(sseEnvelope({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }));
        } else {
          res.write(sseEnvelope({ reasoning_content: "thinking " }));
          res.write(sseEnvelope({ content: "Hello" }));
          res.write(sseEnvelope({ content: ", world" }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const upstreamBase = await start(upstream);
  process.env.QODER_CN_BASE_URL = `${upstreamBase}/`;
  process.env.QODER_CN_OPENAPI_URL = upstreamBase;

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    clientApiKey: "secret-key",
    pat: "pt-test",
    mode: "cn",
    defaultModel: "auto",
    modelCacheTtlMs: 60_000,
    requestTimeoutMs: 30_000,
    cosyDebug: false,
    embeddingsBaseUrl: "http://127.0.0.1:9/v1",
    embeddingsModel: "qwen3-embedding:0.6b",
    embeddingsApiKey: "",
    logLevel: "error",
  };
  const ctx: RelayContext = createRelay(config);
  relay = createRelayServer(ctx);
  relayBase = await start(relay);
});

afterAll(async () => {
  delete process.env.QODER_CN_BASE_URL;
  delete process.env.QODER_CN_OPENAPI_URL;
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("relay HTTP surface", () => {
  it("answers the health check without auth", async () => {
    const res = await fetch(`${relayBase}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string };
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("cn");
  });

  it("rejects requests without the client API key", async () => {
    const res = await fetch(`${relayBase}/v1/models`);
    expect(res.status).toBe(401);
  });

  it("advertises prettified display-name ids and auto, hiding raw wire keys", async () => {
    const res = await fetch(`${relayBase}/v1/models`, { headers: { Authorization: "Bearer secret-key" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain(`Auto${CN_SUFFIX}`);
    expect(ids).toContain(`Qwen 3.7 Plus${CN_SUFFIX}`);
    expect(ids).not.toContain(`qmodel${CN_SUFFIX}`);
    expect(ids).not.toContain(`disabled${CN_SUFFIX}`);
    expect(ids).toContain("qwen3-embedding:0.6b");
  });

  it("streams an OpenAI-compatible completion", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readAll(res);
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"reasoning_content":"thinking "');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":", world"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // The upstream body must be WAF-encoded (no raw JSON braces survive).
    expect(lastChatBody.includes('"messages"')).toBe(false);
  });

  it("forwards enable_thinking=false as the upstream parameter toggle", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        enable_thinking: false,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await readAll(res);
    const body = JSON.parse(qoderDecodeBody(lastChatBody)) as {
      parameters: { enable_thinking?: boolean; reasoning_effort?: string };
    };
    expect(body.parameters.enable_thinking).toBe(false);
    // An explicit disable also suppresses any reasoning_effort hint.
    expect(body.parameters.reasoning_effort).toBeUndefined();
  });

  it("forwards enable_thinking=true as the upstream parameter toggle", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        enable_thinking: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await readAll(res);
    const body = JSON.parse(qoderDecodeBody(lastChatBody)) as {
      parameters: { enable_thinking?: boolean };
    };
    expect(body.parameters.enable_thinking).toBe(true);
  });

  it("forwards enable_thinking for models without a thinking_config too", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qmodel",
        enable_thinking: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await readAll(res);
    const body = JSON.parse(qoderDecodeBody(lastChatBody)) as {
      parameters: { enable_thinking?: boolean };
    };
    expect(body.parameters.enable_thinking).toBe(false);
  });

  it("aggregates a non-streaming completion with usage", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string; reasoning_content?: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello, world");
    expect(body.choices[0]?.message.reasoning_content).toBe("thinking ");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it("reports usage when stream_options.include_usage is set", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await readAll(res);
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: {"))
      .map((frame) => JSON.parse(frame.slice(6)));
    const usageFrame = frames.find((frame) => frame?.usage);
    expect(usageFrame).toBeDefined();
    const usage = (usageFrame as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } })
      .usage;
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  it("maps upstream tool calls through an alias model", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `Qwen 3.7 Plus${CN_SUFFIX}`,
        messages: [{ role: "user", content: "weather in paris" }],
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          content: string | null;
        };
        finish_reason: string;
      }>;
    };
    const call = body.choices[0]?.message.tool_calls?.[0];
    expect(call?.function.name).toBe("get_weather");
    expect(call?.function.arguments).toBe('{"city":"Paris"}');
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("returns an error when messages are missing", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto" }),
    });
    expect(res.status).toBe(400);
  });
});
