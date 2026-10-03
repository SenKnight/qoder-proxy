import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  formatQoderHttpError,
  getQoderBaseUrl,
  getQoderChatURL,
  redactSecrets,
} from "../src/qoder/cosy.js";

const creds = { userID: "user-123", authToken: "jt-abc", name: "Test", email: "t@e.com", machineID: "machine-1" };

describe("buildAuthHeaders", () => {
  it("throws when identity is missing", () => {
    expect(() =>
      buildAuthHeaders(null, "https://api3.qoder.sh/algo/api/v2/model/list", { ...creds, userID: "" }),
    ).toThrow(/user id is empty/);
    expect(() =>
      buildAuthHeaders(null, "https://api3.qoder.sh/algo/api/v2/model/list", { ...creds, authToken: "" }),
    ).toThrow(/auth token is empty/);
  });

  it("produces a COSY Authorization and strips the /algo prefix from sigpath", () => {
    const url = "https://gateway.qoder.com.cn/algo/api/v2/model/list";
    const headers = buildAuthHeaders(null, url, creds);
    expect(headers.Authorization.startsWith("Bearer COSY.")).toBe(true);
    expect(headers["Cosy-Sigpath"]).toBe("/api/v2/model/list");
    expect(headers["Cosy-User"]).toBe("user-123");
    expect(headers["Cosy-Bodylength"]).toBe("0");
    expect(headers["Cosy-Bodyhash"]).toBe(crypto.createHash("md5").update("").digest("hex"));
  });

  it("hashes and measures the body bytes", () => {
    const body = Buffer.from("hello 世界", "utf8");
    const headers = buildAuthHeaders(body, "https://api3.qoder.sh/algo/api/v2/x", creds);
    expect(headers["Cosy-Bodyhash"]).toBe(crypto.createHash("md5").update(body).digest("hex"));
    expect(headers["Cosy-Bodylength"]).toBe(String(body.length));
  });
});

describe("endpoint resolution", () => {
  it("uses the global hosts by default", () => {
    expect(getQoderBaseUrl({ mode: "global" })).toBe("https://api3.qoder.sh/");
    expect(getQoderChatURL({ mode: "global" })).toContain(
      "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    );
  });

  it("derives VPC hosts for CN instances", () => {
    expect(getQoderBaseUrl({ mode: "cn", vpcInstance: "acme" })).toBe("https://acme-gateway.vpc.qoder.com.cn/");
  });

  it("uses public CN hosts when no instance is set", () => {
    const prev = process.env.QODER_CN_BASE_URL;
    delete process.env.QODER_CN_BASE_URL;
    try {
      expect(getQoderBaseUrl({ mode: "cn" })).toBe("https://gateway.qoder.com.cn/");
    } finally {
      if (prev !== undefined) process.env.QODER_CN_BASE_URL = prev;
    }
  });
});

describe("redaction and error formatting", () => {
  it("redacts tokens from arbitrary text", () => {
    const text = "failed with pt-12345 and Bearer jt-abcdef";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("pt-12345");
    expect(redacted).not.toContain("jt-abcdef");
  });

  it("adds CSRF guidance when a tenant dashboard host is hit", () => {
    const message = formatQoderHttpError("api", 403, "Forbidden", "CSRFInvalid", "https://acme.vpc.qoder.com.cn/api");
    expect(message).toContain("tenant dashboard host");
  });
});
