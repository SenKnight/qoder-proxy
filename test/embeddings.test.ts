import { createServer as httpCreateServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createRelay, createRelayServer, type RelayContext } from "../src/server.js";

let upstream: Server;
let relay: Server;
let relayBase = "";

let lastEmbeddingsBody: Record<string, unknown> | undefined;
let lastEmbeddingsAuth: string | undefined;
let upstreamStatus = 200;

function start(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  upstream = httpCreateServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        lastEmbeddingsAuth = req.headers.authorization;
        lastEmbeddingsBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (upstreamStatus !== 200) {
          res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "model 'nope' not found", type: "invalid_request_error" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
            model: "qwen3-embedding:0.6b",
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const upstreamBase = await start(upstream);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    clientApiKey: "secret-key",
    pat: "pt-test",
    mode: "global",
    defaultModel: "auto",
    modelCacheTtlMs: 60_000,
    requestTimeoutMs: 30_000,
    cosyDebug: false,
    embeddingsBaseUrl: `${upstreamBase}/v1`,
    embeddingsModel: "qwen3-embedding:0.6b",
    embeddingsApiKey: "embed-secret",
    logLevel: "error",
  };
  const ctx: RelayContext = createRelay(config);
  relay = createRelayServer(ctx);
  relayBase = await start(relay);
});

afterAll(async () => {
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function postEmbeddings(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${relayBase}/v1/embeddings`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("embeddings passthrough", () => {
  it("rejects requests without the client API key", async () => {
    const res = await fetch(`${relayBase}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the embeddings model in the model catalog", async () => {
    const res = await fetch(`${relayBase}/v1/models`, { headers: { Authorization: "Bearer secret-key" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
    expect(body.object).toBe("list");
    const entry = body.data.find((model) => model.id === "qwen3-embedding:0.6b");
    expect(entry).toBeDefined();
    expect(entry?.owned_by).toBe("embeddings");
  });

  it("forwards a single input and returns the upstream payload verbatim", async () => {
    upstreamStatus = 200;
    const res = await postEmbeddings({ input: "hello world" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("list");
    expect(body.model).toBe("qwen3-embedding:0.6b");
    expect(body.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.usage.total_tokens).toBe(3);
  });

  it("always sends the configured upstream model, ignoring the client's", async () => {
    upstreamStatus = 200;
    await postEmbeddings({ model: "text-embedding-3-small", input: "hi" });
    expect(lastEmbeddingsBody?.model).toBe("qwen3-embedding:0.6b");
    expect(lastEmbeddingsBody?.input).toBe("hi");
  });

  it("passes array input, dimensions and encoding_format through", async () => {
    upstreamStatus = 200;
    await postEmbeddings({ input: ["a", "b"], dimensions: 256, encoding_format: "float", user: "u1" });
    expect(lastEmbeddingsBody?.input).toEqual(["a", "b"]);
    expect(lastEmbeddingsBody?.dimensions).toBe(256);
    expect(lastEmbeddingsBody?.encoding_format).toBe("float");
    expect(lastEmbeddingsBody?.user).toBe("u1");
  });

  it("attaches the configured upstream bearer token", async () => {
    upstreamStatus = 200;
    await postEmbeddings({ input: "x" });
    expect(lastEmbeddingsAuth).toBe("Bearer embed-secret");
  });

  it("requires input", async () => {
    const res = await postEmbeddings({ model: "qwen3-embedding:0.6b" });
    expect(res.status).toBe(400);
  });

  it("maps an upstream error to the client", async () => {
    upstreamStatus = 404;
    const res = await postEmbeddings({ input: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("not found");
    upstreamStatus = 200;
  });
});
