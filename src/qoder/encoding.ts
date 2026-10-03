/**
 * Qoder WAF request-body encoding (`Encode=1`).
 *
 * The server expects chat bodies to be transformed with a shuffled Base64 plus
 * an alphabet substitution. The server reverses it using a = floor(n / 3).
 * Ported verbatim from pi-provider-qoder (src/qoder-encoding.ts).
 */
const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged[i];
    if (c === "=") {
      out += "$";
    } else {
      const idx = qoderStdAlphabet.indexOf(c);
      out += idx >= 0 ? qoderCustomAlphabet[idx] : c;
    }
  }
  return out;
}
