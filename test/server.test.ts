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

  it("advertises suffixed aliases and auto, hiding raw wire keys", async () => {
    const res = await fetch(`${relayBase}/v1/models`, { headers: { Authorization: "Bearer secret-key" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain(`auto${CN_SUFFIX}`);
    expect(ids).toContain(`qwen3.7-plus${CN_SUFFIX}`);
    expect(ids).not.toContain(`qmodel${CN_SUFFIX}`);
    expect(ids).not.toContain(`disabled${CN_SUFFIX}`);
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
      usage: unknown;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello, world");
    expect(body.choices[0]?.message.reasoning_content).toBe("thinking ");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toBeDefined();
  });

  it("maps upstream tool calls through an alias model", async () => {
    const res = await fetch(`${relayBase}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `qwen3.7-plus${CN_SUFFIX}`,
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
