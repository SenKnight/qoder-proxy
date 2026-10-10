import { createServer as httpCreateServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createRelay, createRelayServer, type RelayContext } from "../src/server.js";

let upstream: Server;
let relay: Server;
let relayBase = "";
const sockets = new Set<Socket>();

function frameString(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] }),
  })}\n\n`;
}

function frameObject(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: { choices: [{ delta, finish_reason: finishReason }] } })}\n\n`;
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

function chat(model: string, stream = false): Promise<Response> {
  return fetch(`${relayBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });
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
          chat: [{ key: "auto", enable: true, display_name: "Auto", is_reasoning: true, max_output_tokens: 8192 }],
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/agent_chat_generation")) {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const key = String(req.headers["x-model-key"] || "");
        if (key === "objmodel") {
          res.write(frameObject({ content: "obj-body" }, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (key === "lenmodel") {
          res.write(frameString({ content: "partial" }, "length"));
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (key === "stallmodel") {
          res.write(frameString({ content: "stalled" }, "stop"));
          res.write("data: [DONE]\n\n");
          const timer = setTimeout(() => {
            try {
              res.end();
            } catch {}
          }, 10_000);
          res.on("close", () => clearTimeout(timer));
        } else if (key === "usagemodel") {
          res.write(
            `data: ${JSON.stringify({
              statusCodeValue: 200,
              body: JSON.stringify({
                choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
              }),
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.write(frameString({ content: "hi" }, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const upstreamBase = await start(upstream);
  process.env.QODER_CN_BASE_URL = `${upstreamBase}/`;
  process.env.QODER_CN_OPENAPI_URL = upstreamBase;

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    clientApiKey: "",
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
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("upstream stream hardening", () => {
  it("does not mask upstream finish_reason=length as stop", async () => {
    const res = await chat("lenmodel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(body.choices[0]?.message.content).toBe("partial");
    expect(body.choices[0]?.finish_reason).toBe("length");
  });

  it("parses a frame whose body is already an object", async () => {
    const res = await chat("objmodel");
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("obj-body");
  });

  it("finishes promptly on [DONE] even when the upstream keeps the socket open", async () => {
    const started = Date.now();
    const res = await chat("stallmodel", true);
    const text = await readAll(res);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text).toContain("stalled");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("prefers upstream usage when the gateway reports it", async () => {
    const res = await chat("usagemodel");
    const body = (await res.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });
});
