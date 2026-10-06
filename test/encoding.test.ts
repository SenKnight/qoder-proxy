import { describe, expect, it } from "vitest";
import { qoderEncodeBody } from "../src/qoder/encoding.js";

const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const customAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

/** The rotation is self-inverse: applying it twice restores the original. */
function rotate(text: string): string {
  const n = text.length;
  const a = Math.floor(n / 3);
  return text.slice(n - a) + text.slice(a, n - a) + text.slice(0, a);
}

/** Mirror of the server-side inverse, used only to validate the encoder. */
function qoderDecodeBody(encoded: string): Buffer {
  let base64 = "";
  for (const char of encoded) {
    if (char === "$") {
      base64 += "=";
      continue;
    }
    const idx = customAlphabet.indexOf(char);
    base64 += idx >= 0 ? stdAlphabet[idx] : char;
  }
  return Buffer.from(rotate(base64), "base64");
}

describe("qoderEncodeBody", () => {
  it("round-trips through the server-side inverse for varied inputs", () => {
    const samples = [
      "",
      "a",
      "ab",
      "abc",
      "hello world",
      JSON.stringify({ messages: [{ role: "user", content: "你好，世界 🌍" }] }),
      "A".repeat(4096),
      Buffer.from([0, 1, 2, 250, 255, 128]).toString("latin1"),
    ];
    for (const sample of samples) {
      const encoded = qoderEncodeBody(sample);
      expect(qoderDecodeBody(encoded)).toEqual(Buffer.from(sample));
    }
  });

  it("never leaves standard base64 characters except the '$' padding marker", () => {
    const encoded = qoderEncodeBody("The quick brown fox jumps over the lazy dog");
    expect(encoded).not.toMatch(/[+/]/);
    expect(encoded).toMatch(/^\$*[^=]*\$*$/u);
  });

  it("preserves the base64 length", () => {
    const input = "qoder proxy relay";
    const encoded = qoderEncodeBody(input);
    expect(encoded.length).toBe(Buffer.from(input).toString("base64").length);
  });
});
