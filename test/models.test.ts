import { describe, expect, it } from "vitest";
import { modelIdSuffix, prettifyModelName, QoderModelCatalog } from "../src/qoder/models.js";

function makeCatalog(): QoderModelCatalog {
  return new QoderModelCatalog(
    { mode: "global" },
    async () => ({ userID: "", authToken: "", name: "", email: "" }),
    false,
    60_000,
  );
}

describe("prettifyModelName", () => {
  it("humanizes upstream display names like pi-provider-qoder", () => {
    expect(prettifyModelName("Qwen3.7-Plus")).toBe("Qwen 3.7-Plus");
    expect(prettifyModelName("DeepSeek V4-Pro")).toBe("DeepSeek V4 Pro");
    expect(prettifyModelName("DeepSeek-V4-Pro")).toBe("DeepSeek-V4-Pro");
    expect(prettifyModelName("GLM-5.3")).toBe("GLM-5.3");
  });
});

describe("modelIdSuffix", () => {
  it("varies by region", () => {
    expect(modelIdSuffix("cn")).toBe(" · Qoder-CN");
    expect(modelIdSuffix("global")).toBe(" · Qoder");
  });
});

describe("QoderModelCatalog", () => {
  it("resolves display-name ids, bare labels, and raw wire keys before the live catalog loads", () => {
    const catalog = makeCatalog();
    expect(catalog.resolveWireKey("Qwen 3.7 Plus · Qoder")).toBe("qmodel");
    expect(catalog.resolveWireKey("Qwen 3.7 Plus · Qoder-CN")).toBe("qmodel");
    expect(catalog.resolveWireKey("Qwen 3.7 Plus")).toBe("qmodel");
    expect(catalog.resolveWireKey("auto")).toBe("auto");
    expect(catalog.resolveWireKey("Auto · Qoder")).toBe("auto");
    expect(catalog.resolveWireKey("qmodel_latest")).toBe("qmodel_latest");
    expect(catalog.resolveWireKey("totally-unknown")).toBe("totally-unknown");
  });

  it("advertises prettified display-name ids with the region suffix", () => {
    const catalog = makeCatalog();
    const list = catalog.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((m) => m.id === "Auto · Qoder")).toBe(true);
    expect(list.some((m) => m.id === "Qwen 3.7 Plus · Qoder")).toBe(true);
    expect(list.some((m) => m.id === "Auto · Qoder-CN")).toBe(false);
    // Raw upstream wire keys are not advertised, with or without the suffix.
    expect(list.some((m) => m.id === "qmodel · Qoder")).toBe(false);
    expect(list.some((m) => m.id === "qmodel")).toBe(false);
  });

  it("synthesizes an entry for a known static model", () => {
    const catalog = makeCatalog();
    const entry = catalog.getEntry("qmodel");
    expect(entry?.key).toBe("qmodel");
  });
});
