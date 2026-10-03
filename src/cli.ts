import type { ConfigOverrides, QoderMode } from "./config.js";
import type { LogLevel } from "./logger.js";

/** Raised for malformed command-line input. Surfaced with the usage text. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface ParsedArgs {
  /** Values supplied on the command line; take precedence over env vars. */
  overrides: ConfigOverrides;
  help: boolean;
  version: boolean;
}

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export const USAGE = `qoder-transfer — 以 OpenAI 兼容 API 暴露 Qoder 大模型

用法：
  qoder-transfer [选项]

选项：
  --pat <token>             Qoder 个人访问令牌（pt-...）                 [env: QODER_PAT]
  --mode <global|cn>        区域，省略时自动推断                          [env: QODER_MODE]
  --vpc <instance>          CN 企业 VPC 实例名                            [env: QODER_VPC_INSTANCE]
  --host <addr>             监听地址（默认 127.0.0.1）                    [env: HOST]
  -p, --port <port>         监听端口（默认 8787）                         [env: PORT]
  --api-key <key>           客户端访问密钥，留空则不校验                  [env: RELAY_API_KEY]
  --default-model <id>      请求未带 model 时的默认模型（默认 auto）      [env: QODER_DEFAULT_MODEL]
  --model-cache-ttl <ms>    模型目录缓存时间（默认 3600000）              [env: QODER_MODEL_CACHE_TTL_MS]
  --request-timeout <ms>    上游请求超时（默认 600000）                   [env: QODER_REQUEST_TIMEOUT_MS]
  --cosy-debug              打印非敏感 COSY 诊断信息                      [env: QODER_COSY_DEBUG]
  --log-level <level>       debug | info | warn | error（默认 info）      [env: LOG_LEVEL]
  -h, --help                显示帮助并退出
  -v, --version             显示版本并退出

优先级：命令行参数 > 环境变量 > 默认值。

安全提示：通过 --pat 传递令牌可能被同机其它用户经进程列表（ps）看到，
多用户 / 共享环境下建议改用 QODER_PAT 环境变量。`;

function parseBoolFlag(flag: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  throw new CliError(`Invalid boolean for ${flag}: ${raw}`);
}

function parseIntFlag(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new CliError(`Invalid number for ${flag}: ${raw}`);
  return value;
}

function parseMode(flag: string, raw: string): QoderMode {
  const value = raw.trim().toLowerCase();
  if (value === "global" || value === "cn") return value;
  throw new CliError(`Invalid value for ${flag}: ${raw} (expected global or cn)`);
}

function parseLogLevel(flag: string, raw: string): LogLevel {
  const value = raw.trim().toLowerCase() as LogLevel;
  if (LOG_LEVELS.has(value)) return value;
  throw new CliError(`Invalid value for ${flag}: ${raw} (expected debug, info, warn or error)`);
}

/**
 * Parse `argv` (already stripped of the node executable and script path).
 * Supports `--flag value`, `--flag=value`, and `--no-<flag>` for booleans.
 * Throws {@link CliError} on unknown flags, missing values or bad formats.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const overrides: ConfigOverrides = {};
  let help = false;
  let version = false;

  const readValue = (flag: string, index: number, inline: string | undefined): string => {
    if (inline !== undefined) {
      if (inline === "") throw new CliError(`Missing value for ${flag}`);
      return inline;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) throw new CliError(`Missing value for ${flag}`);
    return next;
  };

  // Consumes the following token when the value was not inlined with `=`.
  const advance = (inline: string | undefined): number => (inline === undefined ? 1 : 0);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") throw new CliError(`Unexpected argument: ${arg}`);

    let name = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }

    switch (name) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      case "--pat":
        overrides.pat = readValue(name, i, inline);
        i += advance(inline);
        break;
      case "--mode":
        overrides.mode = parseMode(name, readValue(name, i, inline));
        i += advance(inline);
        break;
      case "--vpc":
        overrides.vpcInstance = readValue(name, i, inline);
        i += advance(inline);
        break;
      case "--host":
        overrides.host = readValue(name, i, inline);
        i += advance(inline);
        break;
      case "-p":
      case "--port":
        overrides.port = parseIntFlag(name, readValue(name, i, inline));
        i += advance(inline);
        break;
      case "--api-key":
        overrides.clientApiKey = readValue(name, i, inline);
        i += advance(inline);
        break;
      case "--default-model":
        overrides.defaultModel = readValue(name, i, inline);
        i += advance(inline);
        break;
      case "--model-cache-ttl":
        overrides.modelCacheTtlMs = parseIntFlag(name, readValue(name, i, inline));
        i += advance(inline);
        break;
      case "--request-timeout":
        overrides.requestTimeoutMs = parseIntFlag(name, readValue(name, i, inline));
        i += advance(inline);
        break;
      case "--cosy-debug":
        overrides.cosyDebug = inline === undefined ? true : parseBoolFlag(name, inline);
        break;
      case "--no-cosy-debug":
        overrides.cosyDebug = false;
        break;
      case "--log-level":
        overrides.logLevel = parseLogLevel(name, readValue(name, i, inline));
        i += advance(inline);
        break;
      default:
        throw new CliError(`Unknown option: ${name}`);
    }
  }

  return { overrides, help, version };
}
