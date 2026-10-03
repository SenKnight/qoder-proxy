import type { QoderMode } from "../config.js";
import { logger } from "../logger.js";
import {
  buildAuthHeaders,
  type CosyCredentials,
  getQoderModelListURL,
  logCosyRequest,
  logCosyResponse,
  type QoderRoute,
} from "./cosy.js";

/**
 * Dynamic Qoder model catalog.
 *
 * Mirrors pi-provider-qoder (src/models.ts): the live `/algo/api/v2/model/list`
 * response is the source of truth, cached with a TTL, with a small static
 * fallback so `/v1/models` still answers when the upstream call fails.
 */

export interface QoderThinkingConfig {
  disabled?: { is_default?: boolean; [key: string]: unknown };
  enabled?: {
    is_default?: boolean;
    efforts?: Record<string, { description?: string; is_default?: boolean; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_config?: Record<string, { token_count?: number }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: QoderThinkingConfig;
  source?: string;
  [key: string]: unknown;
}

/** Public model descriptor surfaced through `/v1/models`. */
export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  reasoning: boolean;
  supportsEffort: boolean;
  /** Upstream wire key used as `X-Model-Key` and inside `model_config`. */
  wireKey: string;
}

/**
 * Friendly alias → upstream wire key. Sourced from pi-provider-qoder README
 * appendix B plus compatibility aliases. Wire keys resolve to themselves.
 */
export const MODEL_ALIASES: Record<string, string> = {
  "qwen3.7-max": "qmodel_latest",
  "qwen3.7-plus": "qmodel",
  "qwen3.6-plus": "qmodel",
  "qwen3.6-flash": "q36fmodel",
  "deepseek-v4-pro": "dmodel",
  "deepseek-v4-flash": "dfmodel",
  "glm-5.2": "gm51model",
  "glm-5.1": "gm51model",
  "kimi-k2.6": "kmodel",
  "minimax-m2.7": "mmodel",
  "minimax-m3": "mmodel",
};

/**
 * Region-specific suffix appended to every advertised model id so a client that
 * talks to several relay-backed providers can tell this one apart (`auto`
 * included), e.g. `auto · Qoder-CN` on CN and `auto · Qoder` on Global.
 */
const MODEL_ID_SUFFIXES: Record<QoderMode, string> = {
  cn: " · Qoder-CN",
  global: " · Qoder",
};

/** Suffix used for a region. */
export function modelIdSuffix(mode: QoderMode): string {
  return MODEL_ID_SUFFIXES[mode] ?? MODEL_ID_SUFFIXES.global;
}

/** Drop any known region suffix so a suffixed id maps back to its bare alias. */
export function stripModelSuffix(id: string): string {
  for (const suffix of Object.values(MODEL_ID_SUFFIXES)) {
    if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
  }
  return id;
}

/** Advertised id for a bare alias / wire key in the given region. */
export function withModelSuffix(id: string, mode: QoderMode): string {
  return `${stripModelSuffix(id)}${modelIdSuffix(mode)}`;
}

/** Minimal static fallback if the live catalog is unavailable. */
const STATIC_FALLBACK: ModelDef[] = [
  {
    id: "auto",
    name: "Qoder Auto",
    contextWindow: 180_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: false,
    wireKey: "auto",
  },
  {
    id: "ultimate",
    name: "Qoder Ultimate",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: true,
    wireKey: "ultimate",
  },
  {
    id: "performance",
    name: "Qoder Performance",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: true,
    wireKey: "performance",
  },
  {
    id: "efficient",
    name: "Qoder Efficient",
    contextWindow: 180_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: false,
    supportsEffort: false,
    wireKey: "efficient",
  },
  {
    id: "lite",
    name: "Qoder Lite",
    contextWindow: 180_000,
    maxTokens: 32_768,
    vision: false,
    reasoning: false,
    supportsEffort: false,
    wireKey: "lite",
  },
  {
    id: "qmodel",
    name: "Qwen3.7 Plus",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: false,
    supportsEffort: false,
    wireKey: "qmodel",
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7 Max",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: false,
    supportsEffort: false,
    wireKey: "qmodel_latest",
  },
  {
    id: "dmodel",
    name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: true,
    wireKey: "dmodel",
  },
  {
    id: "dfmodel",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: true,
    wireKey: "dfmodel",
  },
  {
    id: "gm51model",
    name: "GLM 5.1",
    contextWindow: 180_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    supportsEffort: true,
    wireKey: "gm51model",
  },
  {
    id: "kmodel",
    name: "Kimi K2.6",
    contextWindow: 256_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: false,
    supportsEffort: false,
    wireKey: "kmodel",
  },
  {
    id: "mmodel",
    name: "MiniMax M3",
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    vision: true,
    reasoning: false,
    supportsEffort: false,
    wireKey: "mmodel",
  },
];

/**
 * Build the advertised catalog: friendly aliases plus the `auto` default, each
 * carrying the region suffix. Raw upstream wire keys are intentionally hidden
 * from `/v1/models`; a caller that already knows a wire key (with or without
 * the suffix) can still use it directly.
 */
function toAdvertised(defs: ModelDef[], mode: QoderMode): ModelDef[] {
  const byWireKey = new Map<string, ModelDef>();
  for (const def of defs) if (!byWireKey.has(def.wireKey)) byWireKey.set(def.wireKey, def);

  const advertised: ModelDef[] = [];
  const autoDef = byWireKey.get("auto") ?? (STATIC_FALLBACK[0] as ModelDef);
  advertised.push({ ...autoDef, id: withModelSuffix("auto", mode) });
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    const def = byWireKey.get(target);
    if (!def) continue;
    advertised.push({ ...def, id: withModelSuffix(alias, mode), name: `${def.name} (${alias})` });
  }
  return advertised;
}

function contextWindowOf(entry: QoderModelEntry): number {
  let ctxLen = entry.max_input_tokens || 180_000;
  if (entry.context_config && typeof entry.context_config === "object") {
    for (const configVal of Object.values(entry.context_config)) {
      if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
        if (configVal.token_count > ctxLen) ctxLen = configVal.token_count;
      }
    }
  }
  return ctxLen;
}

export interface QoderBearerSession extends CosyCredentials {}

export type SessionProvider = () => Promise<QoderBearerSession>;

export class QoderModelCatalog {
  private entries = new Map<string, QoderModelEntry>();
  private models: ModelDef[] = [];
  private updatedAt = 0;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly route: QoderRoute,
    private readonly getSession: SessionProvider,
    private readonly debug: boolean,
    private readonly ttlMs: number,
  ) {}

  /** Refresh the catalog when the cache is missing or older than the TTL. */
  async ensureFresh(): Promise<void> {
    if (this.models.length > 0 && Date.now() - this.updatedAt < this.ttlMs) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.doRefresh()
      .catch((error) => {
        logger.warn("model catalog refresh failed; keeping previous snapshot", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async doRefresh(): Promise<void> {
    const session = await this.getSession();
    const url = getQoderModelListURL(this.route);
    const headers = buildAuthHeaders(null, url, session);
    logCosyRequest(this.debug, "GET", url, headers);

    const response = await fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
    let preview: string | undefined;
    if (!response.ok) preview = await response.text().catch(() => "");
    logCosyResponse(this.debug, url, response, preview);
    if (!response.ok) throw new Error(`model/list failed: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = (data.chat || []).filter((entry) => entry.key && entry.enable);
    if (chatModels.length === 0) throw new Error("model/list returned no enabled models");

    const entries = new Map<string, QoderModelEntry>();
    const defs: ModelDef[] = [];

    for (const entry of chatModels) {
      const key = entry.key as string;
      entries.set(key, entry);
      defs.push({
        id: key,
        name: entry.display_name || key,
        contextWindow: contextWindowOf(entry),
        maxTokens: entry.max_output_tokens || 32_768,
        vision: !!entry.is_vl,
        reasoning: !!entry.is_reasoning || !!entry.thinking_config,
        supportsEffort: !!entry.thinking_config?.enabled?.efforts,
        wireKey: key,
      });
    }

    this.entries = entries;
    this.models = toAdvertised(defs, this.route.mode);
    this.updatedAt = Date.now();
    logger.info("model catalog refreshed", { advertised: this.models.length, upstream: entries.size });
  }

  /** Advertised models: friendly aliases plus `auto` (raw wire keys omitted). */
  list(): ModelDef[] {
    return this.models.length > 0 ? this.models : toAdvertised(STATIC_FALLBACK, this.route.mode);
  }

  /** Resolve an advertised id / friendly alias to the upstream wire key. */
  resolveWireKey(modelId: string): string {
    const id = stripModelSuffix(modelId ?? "");
    if (!id) return "auto";
    if (this.entries.has(id)) return id;
    const alias = MODEL_ALIASES[id];
    if (alias) return alias;
    return id;
  }

  /** Catalog entry (with thinking_config etc.) for a requested model id. */
  getEntry(modelId: string): QoderModelEntry | undefined {
    const wireKey = this.resolveWireKey(modelId);
    const entry = this.entries.get(wireKey);
    if (entry) return entry;
    const def = this.list().find((m) => m.id === modelId || m.wireKey === wireKey);
    if (!def) return undefined;
    return {
      key: def.wireKey,
      is_reasoning: def.reasoning,
      max_output_tokens: def.maxTokens,
      thinking_config: def.supportsEffort ? { enabled: { efforts: { high: { is_default: true } } } } : undefined,
      source: "system",
    };
  }
}
