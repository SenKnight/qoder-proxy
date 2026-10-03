import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { QoderMode } from "../config.js";
import { logger } from "../logger.js";

/**
 * COSY signing + Qoder endpoint resolution.
 *
 * Faithful port of pi-provider-qoder (src/cosy.ts). The chat / model-list
 * gateway requires a COSY signature; the OpenAPI host (PAT exchange, userinfo,
 * quota) only needs a Bearer job token.
 */

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const QoderIDEVersion = "1.0.0";
const QoderClientType = "5";
const QoderDataPolicy = "disagree";
const QoderLoginVersion = "v2";
const QoderMachineOS = "x86_64_windows";
const QoderMachineTypeMagic = "5";

export const QoderUserAgent = "qoder-transfer";

export interface QoderRoute {
  mode: QoderMode;
  vpcInstance?: string;
}

interface UserInfo {
  uid: string;
  security_oauth_token: string;
  name: string;
  aid: string;
  email: string;
}

interface CosyPayload {
  version: string;
  requestId: string;
  info: string;
  cosyVersion: string;
  ideVersion: string;
}

export interface CosyCredentials {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID?: string;
}

/** China VPC service host: `https://<instance>-<service>.vpc.qoder.com.cn`. */
function vpcServiceUrl(instance: string, service: "gateway" | "openapi"): string {
  return `https://${instance}-${service}.vpc.qoder.com.cn`;
}

export function getQoderBaseUrl(route: QoderRoute): string {
  if (route.mode === "cn") {
    if (route.vpcInstance) return `${vpcServiceUrl(route.vpcInstance, "gateway")}/`;
    const override = process.env.QODER_CN_BASE_URL;
    const url = override || "https://gateway.qoder.com.cn/";
    return url.endsWith("/") ? url : `${url}/`;
  }
  return "https://api3.qoder.sh/";
}

export function getQoderOpenApiUrl(route: QoderRoute): string {
  if (route.mode === "cn") {
    if (route.vpcInstance) return vpcServiceUrl(route.vpcInstance, "openapi");
    const override = process.env.QODER_CN_OPENAPI_URL;
    return (override || "https://openapi.qoder.com.cn").replace(/\/+$/, "");
  }
  return "https://openapi.qoder.sh";
}

export function getQoderModelListURL(route: QoderRoute): string {
  return `${getQoderBaseUrl(route)}algo/api/v2/model/list`;
}

export function getQoderChatURL(route: QoderRoute): string {
  return `${getQoderBaseUrl(route)}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function getQoderExchangeURL(route: QoderRoute): string {
  return `${getQoderOpenApiUrl(route)}/api/v1/jobToken/exchange`;
}

export function getQoderJobTokenRefreshURL(route: QoderRoute): string {
  return `${getQoderOpenApiUrl(route)}/api/v1/jobToken/refresh`;
}

export function getQoderUserInfoURL(route: QoderRoute): string {
  return `${getQoderOpenApiUrl(route)}/api/v1/userinfo`;
}

export function getQoderUsageURL(route: QoderRoute): string {
  return `${getQoderOpenApiUrl(route)}/api/v2/quota/usage`;
}

function rsaEncryptBase64(data: Buffer | string): string {
  const key = { key: qoderRSAPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING };
  const encrypted = crypto.publicEncrypt(key, typeof data === "string" ? Buffer.from(data) : data);
  return encrypted.toString("base64");
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) sigPath = sigPath.substring("/algo".length);
  return sigPath;
}

let cachedMachineId: string | undefined;

/** Machine id: env override → qoder auth → pi agent → generated (persisted). */
export function getMachineId(): string {
  const override = process.env.QODER_MACHINE_ID?.trim();
  if (override) return override;
  if (cachedMachineId) return cachedMachineId;

  const paths = [join(homedir(), ".qoder", ".auth", "machine_id"), join(homedir(), ".pi", "agent", "qoder-machine-id")];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const val = readFileSync(p, "utf8").trim();
        if (val) {
          cachedMachineId = val;
          return val;
        }
      } catch {}
    }
  }

  const newId = crypto.randomUUID();
  try {
    const savePath = join(homedir(), ".qoder-transfer", "machine-id");
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, newId, "utf8");
  } catch {}
  cachedMachineId = newId;
  return newId;
}

/** Build the full COSY signature header set for a gateway request. */
export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
): Record<string, string> {
  if (!creds.userID) throw new Error("cosy: user id is empty");
  if (!creds.authToken) throw new Error("cosy: auth token is empty");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  };

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();

  const cosyPayload: CosyPayload = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: QoderIDEVersion,
    ideVersion: "",
  };

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
  const sigPath = computeSigPath(requestURL);

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString("utf8") : body) : "";
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");

  const bodyHash = crypto
    .createHash("md5")
    .update(body || "")
    .digest("hex");
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";

  const machineID = creds.machineID || getMachineId();

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": QoderIDEVersion,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": QoderMachineTypeMagic,
    "Cosy-Machineos": QoderMachineOS,
    "Cosy-Clienttype": QoderClientType,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QoderDataPolicy,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QoderLoginVersion,
    "X-Request-Id": crypto.randomUUID(),
  };
}

/** Redact any pt-/jt-/jrt- style secret from a string before logging. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:pt|jt|jrt)-[A-Za-z0-9._~+/=-]+/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

export function logCosyRequest(
  debug: boolean,
  method: string,
  requestURL: string,
  headers: Record<string, string>,
): void {
  if (!debug) return;
  logger.debug("cosy request", {
    method,
    url: requestURL,
    cosyDate: headers["Cosy-Date"],
    cosySigpath: headers["Cosy-Sigpath"],
    cosyBodyhash: headers["Cosy-Bodyhash"],
    cosyBodylength: headers["Cosy-Bodylength"],
  });
}

export function logCosyResponse(debug: boolean, requestURL: string, response: Response, bodyPreview?: string): void {
  if (!debug) return;
  logger.debug("cosy response", {
    url: requestURL,
    status: response.status,
    statusText: response.statusText,
    ...(bodyPreview === undefined ? {} : { bodyPreview: redactSecrets(bodyPreview).slice(0, 200) }),
  });
}

function isQoderTenantDashboardHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const suffix = ".vpc.qoder.com.cn";
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return Boolean(prefix) && !prefix.includes(".") && !prefix.endsWith("-gateway") && !prefix.endsWith("-openapi");
}

/** Enrich Qoder HTTP failures with VPC/CSRF guidance without leaking secrets. */
export function formatQoderHttpError(
  kind: "api" | "pat-exchange",
  status: number,
  statusText: string,
  bodyText: string,
  requestURL?: string,
): string {
  const preview = redactSecrets(bodyText).replace(/\s+/g, " ").trim().slice(0, 200);
  const prefix =
    kind === "pat-exchange"
      ? `Qoder PAT exchange failed: ${status} ${statusText}`
      : `Qoder API request failed: ${status} ${statusText}`;
  const base = preview ? `${prefix}. Response: ${preview}` : prefix;

  let host = "";
  if (requestURL) {
    try {
      host = new URL(requestURL).hostname.toLowerCase();
    } catch {
      host = "";
    }
  }

  const hints: string[] = [];
  if (/CSRFInvalid/i.test(bodyText)) {
    if (host && isQoderTenantDashboardHost(host)) {
      hints.push(
        `Request hit the tenant dashboard host (${host}). Use the derived API hosts instead: https://<instance>-gateway.vpc.qoder.com.cn and https://<instance>-openapi.vpc.qoder.com.cn (set QODER_VPC_INSTANCE=<instance>).`,
      );
    } else {
      hints.push(
        "CSRFInvalid usually means the request reached web/session middleware instead of the VPC gateway/OpenAPI service. Set QODER_VPC_INSTANCE and retry with QODER_COSY_DEBUG=1.",
      );
    }
  }
  if (/open_access_token not found/i.test(bodyText)) {
    hints.push(
      "The VPC OpenAPI host could not resolve a tenant-side access record for this PAT. Create/use a PAT from the VPC tenant dashboard (https://<instance>.vpc.qoder.com.cn/account/integrations).",
    );
  }

  return hints.length > 0 ? `${base} Hint: ${hints.join(" ")}` : base;
}
