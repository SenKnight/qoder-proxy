import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, modelIdSuffix, QoderModelCatalog } from "../src/qoder/models.js";

function makeCatalog(): QoderModelCatalog {
  return new QoderModelCatalog(
    { mode: "global" },
    async () => ({ userID: "", authToken: "", name: "", email: "" }),
    false,
    60_000,
  );
}

describe("MODEL_ALIASES", () => {
  it("maps documented friendly names to wire keys", () => {
    expect(MODEL_ALIASES["qwen3.7-plus"]).toBe("qmodel");
    expect(MODEL_ALIASES["qwen3.7-max"]).toBe("qmodel_latest");
    expect(MODEL_ALIASES["deepseek-v4-pro"]).toBe("dmodel");
    expect(MODEL_ALIASES["glm-5.2"]).toBe("gm51model");
  });
});

describe("modelIdSuffix", () => {
  it("varies by region", () => {
    expect(modelIdSuffix("cn")).toBe(" · Qoder-CN");
    expect(modelIdSuffix("global")).toBe(" · Qoder");
  });
});

describe("QoderModelCatalog", () => {
  it("resolves bare and region-suffixed ids before the live catalog loads", () => {
    const catalog = makeCatalog();
    expect(catalog.resolveWireKey("qwen3.7-plus")).toBe("qmodel");
    expect(catalog.resolveWireKey("qwen3.7-plus · Qoder")).toBe("qmodel");
    expect(catalog.resolveWireKey("qwen3.7-plus · Qoder-CN")).toBe("qmodel");
    expect(catalog.resolveWireKey("auto")).toBe("auto");
    expect(catalog.resolveWireKey("auto · Qoder")).toBe("auto");
    expect(catalog.resolveWireKey("qmodel_latest")).toBe("qmodel_latest");
    expect(catalog.resolveWireKey("totally-unknown")).toBe("totally-unknown");
  });

  it("exposes a static fallback model list with the region suffix", () => {
    const catalog = makeCatalog();
    const list = catalog.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((m) => m.id === "auto · Qoder")).toBe(true);
    expect(list.some((m) => m.id === "auto · Qoder-CN")).toBe(false);
    // Raw upstream wire keys are not advertised, with or without the suffix.
    expect(list.some((m) => m.id === "qmodel · Qoder")).toBe(false);
    expect(list.some((m) => m.id === "qmodel")).toBe(false);
  });

  it("synthesizes an entry for a known static model", () => {
    const catalog = makeCatalog();
    const entry = catalog.getEntry("qmodel_latest");
    expect(entry?.key).toBe("qmodel_latest");
  });
});
