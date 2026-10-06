import { createServer as httpCreateServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createRelay, createRelayServer, type RelayContext } from "../src/server.js";

const P = "\uFF5C";
const open = (name: string, attrs = ""): string => `<${P}DSML${P}${name}${attrs}>`;
const close = (name: string): string => `</${P}DSML${P}${name}>`;

function dsmlReasoning(): string {
  return [
    "Let me read the file.",
    open("tool_calls"),
    open("invoke", ' name="read_file"'),
    `${open("parameter", ' name="path" string="true"')}README.md${close("parameter")}`,
    close("invoke"),
    close("tool_calls"),
  ].join("\n");
}

let upstream: Server;
let relay: Server;
let relayBase = "";
const sockets = new Set<Socket>();

function frame(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] }),
  })}\n\n`;
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
        // Mirror a model that leaks its tool call as DSML text inside reasoning
        // instead of emitting structured tool_calls deltas.
        res.write(frame({ reasoning_content: dsmlReasoning() }, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
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

interface ChatBody {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
}

describe("DSML recovery through the relay", () => {
  it("turns DSML reasoning markup into structured tool_calls (non-streaming)", async () => {
    const res = await chat("dsmlmodel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatBody;
    const choice = body.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ path: "README.md" });
    expect(choice?.message.reasoning_content ?? "").not.toContain("DSML");
    expect(choice?.message.content ?? "").not.toContain("DSML");
  });

  it("streams a tool_calls delta without leaking the DSML text", async () => {
    const res = await chat("dsmlmodel", true);
    const text = await readAll(res);
    expect(text).toContain('"tool_calls"');
    expect(text).toContain("read_file");
    expect(text).not.toContain("DSML");
  });
});
