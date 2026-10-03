import type { LogLevel } from "./logger.js";

export type QoderMode = "global" | "cn";

export interface Config {
  host: string;
  port: number;
  /** Client API key AI agents must present. Empty disables auth. */
  clientApiKey: string;
  /** Upstream Qoder Personal Access Token (pt-...). */
  pat: string;
  mode: QoderMode;
  /** China enterprise VPC instance name (without the vpc.qoder.com.cn suffix). */
  vpcInstance?: string;
  defaultModel: string;
  modelCacheTtlMs: number;
  requestTimeoutMs: number;
  cosyDebug: boolean;
  logLevel: LogLevel;
}

/**
 * Values supplied on the command line. Every field is optional; when present it
 * wins over the corresponding environment variable (CLI > env > default).
 */
export interface ConfigOverrides {
  pat?: string;
  mode?: QoderMode;
  vpcInstance?: string;
  host?: string;
  port?: number;
  clientApiKey?: string;
  defaultModel?: string;
  modelCacheTtlMs?: number;
  requestTimeoutMs?: number;
  cosyDebug?: boolean;
  logLevel?: LogLevel;
}

const CN_MODES = new Set(["cn", "china", "qodercn", "qoder-cn"]);
const GLOBAL_MODES = new Set(["global", "intl", "international", "qoder"]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function envStr(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

function envInt(fallback: number, ...names: string[]): number {
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function envBool(...names: string[]): boolean {
  const value = envStr(...names).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Returns the first non-empty override, otherwise the first non-empty env var.
function pickStr(override: string | undefined, ...names: string[]): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  return envStr(...names);
}

function normalizeLogLevel(value: string): LogLevel {
  const level = value.trim().toLowerCase() as LogLevel;
  return LOG_LEVELS.has(level) ? level : "info";
}

function resolveMode(overrides: ConfigOverrides, pat: string, cnPatPresent: boolean): QoderMode {
  if (overrides.mode) return overrides.mode;
  const explicit = envStr("QODER_MODE", "QODER_REGION", "QODER_BACKEND").toLowerCase();
  if (CN_MODES.has(explicit)) return "cn";
  if (GLOBAL_MODES.has(explicit)) return "global";
  // A pt- PAT provided through a CN-specific variable implies China.
  if (cnPatPresent && pat) return "cn";
  return "global";
}

function resolvePat(overrides: ConfigOverrides): { pat: string; cnPatPresent: boolean } {
  if (overrides.pat !== undefined && overrides.pat.trim() !== "") {
    return { pat: overrides.pat.trim(), cnPatPresent: false };
  }
  const global = envStr("QODER_PAT", "QODER_PERSONAL_ACCESS_TOKEN");
  const cn = envStr("QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN");
  if (global) return { pat: global, cnPatPresent: false };
  if (cn) return { pat: cn, cnPatPresent: true };
  const apiKey = envStr("QODER_API_KEY");
  if (apiKey.startsWith("pt-")) return { pat: apiKey, cnPatPresent: false };
  return { pat: "", cnPatPresent: false };
}

function normalizeVpcInstance(value: string): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim().toLowerCase();
  try {
    candidate = new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname;
  } catch {
    return undefined;
  }
  const suffix = ".vpc.qoder.com.cn";
  if (candidate.endsWith(suffix)) {
    candidate = candidate.slice(0, -suffix.length);
    if (candidate.endsWith("-gateway") || candidate.endsWith("-openapi")) candidate = candidate.slice(0, -8);
  } else if (candidate.includes(".")) {
    return undefined;
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate) ? candidate : undefined;
}

/**
 * Build the effective configuration. Precedence for every field is
 * command-line override > environment variable > built-in default.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const { pat, cnPatPresent } = resolvePat(overrides);
  const mode = resolveMode(overrides, pat, cnPatPresent);
  const vpcInstance = normalizeVpcInstance(
    pickStr(
      overrides.vpcInstance,
      "QODER_VPC_INSTANCE",
      "QODER_VPC_ENDPOINT",
      "QODERCN_VPC_ENDPOINT",
      "QODERCN_CLI_VPC_ENDPOINT",
      "QODER_CN_BASE_URL",
      "QODER_CN_OPENAPI_URL",
    ),
  );

  return {
    host: pickStr(overrides.host, "HOST", "QODER_RELAY_HOST") || "127.0.0.1",
    port: overrides.port ?? envInt(8787, "PORT", "QODER_RELAY_PORT"),
    clientApiKey: pickStr(overrides.clientApiKey, "RELAY_API_KEY", "QODER_RELAY_API_KEY", "QODER_RELAY_TOKEN"),
    pat,
    mode,
    ...(vpcInstance ? { vpcInstance } : {}),
    defaultModel: pickStr(overrides.defaultModel, "QODER_DEFAULT_MODEL") || "auto",
    modelCacheTtlMs: overrides.modelCacheTtlMs ?? envInt(3_600_000, "QODER_MODEL_CACHE_TTL_MS"),
    requestTimeoutMs: overrides.requestTimeoutMs ?? envInt(600_000, "QODER_REQUEST_TIMEOUT_MS"),
    cosyDebug: overrides.cosyDebug ?? envBool("QODER_COSY_DEBUG"),
    logLevel: normalizeLogLevel(overrides.logLevel ?? envStr("LOG_LEVEL")),
  };
}
