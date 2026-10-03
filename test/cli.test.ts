import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, parseArgs } from "../src/cli.js";
import { loadConfig } from "../src/config.js";

describe("parseArgs", () => {
  it("parses long flags with a space-separated value", () => {
    const { overrides } = parseArgs(["--pat", "pt-abc", "--port", "9000"]);
    expect(overrides.pat).toBe("pt-abc");
    expect(overrides.port).toBe(9000);
  });

  it("parses long flags with an inline value", () => {
    const { overrides } = parseArgs(["--pat=pt-xyz", "--host=0.0.0.0"]);
    expect(overrides.pat).toBe("pt-xyz");
    expect(overrides.host).toBe("0.0.0.0");
  });

  it("parses short flags", () => {
    expect(parseArgs(["-p", "1234"]).overrides.port).toBe(1234);
  });

  it("recognises help and version", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("treats --cosy-debug as a boolean flag", () => {
    expect(parseArgs(["--cosy-debug"]).overrides.cosyDebug).toBe(true);
    expect(parseArgs(["--no-cosy-debug"]).overrides.cosyDebug).toBe(false);
    expect(parseArgs(["--cosy-debug=false"]).overrides.cosyDebug).toBe(false);
  });

  it("parses mode and log level", () => {
    expect(parseArgs(["--mode", "cn"]).overrides.mode).toBe("cn");
    expect(parseArgs(["--mode=global"]).overrides.mode).toBe("global");
    expect(parseArgs(["--log-level", "debug"]).overrides.logLevel).toBe("debug");
  });

  it("throws on unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow(CliError);
  });

  it("throws on missing values", () => {
    expect(() => parseArgs(["--pat"])).toThrow(CliError);
    expect(() => parseArgs(["--pat", "--port", "1"])).toThrow(CliError);
  });

  it("throws on invalid numbers", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(CliError);
    expect(() => parseArgs(["--port", "0"])).toThrow(CliError);
  });

  it("throws on invalid mode and log level", () => {
    expect(() => parseArgs(["--mode", "cnn"])).toThrow(CliError);
    expect(() => parseArgs(["--log-level", "verbose"])).toThrow(CliError);
  });
});

describe("loadConfig precedence", () => {
  const KEYS = [
    "QODER_PAT",
    "QODER_MODE",
    "QODER_VPC_INSTANCE",
    "RELAY_API_KEY",
    "QODER_DEFAULT_MODEL",
    "QODER_COSY_DEBUG",
    "PORT",
    "HOST",
    "LOG_LEVEL",
  ];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("lets CLI overrides win over environment variables", () => {
    process.env.QODER_PAT = "pt-env";
    process.env.PORT = "1000";
    const config = loadConfig({ pat: "pt-cli", port: 2000 });
    expect(config.pat).toBe("pt-cli");
    expect(config.port).toBe(2000);
  });

  it("falls back to environment variables when no override is given", () => {
    process.env.QODER_PAT = "pt-env";
    process.env.RELAY_API_KEY = "key-env";
    const config = loadConfig();
    expect(config.pat).toBe("pt-env");
    expect(config.clientApiKey).toBe("key-env");
  });

  it("applies built-in defaults when nothing is set", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.defaultModel).toBe("auto");
    expect(config.logLevel).toBe("info");
    expect(config.cosyDebug).toBe(false);
  });

  it("honours CLI mode and VPC instance", () => {
    const config = loadConfig({ mode: "cn", vpcInstance: "xxx-of-enterprise" });
    expect(config.mode).toBe("cn");
    expect(config.vpcInstance).toBe("xxx-of-enterprise");
  });
});
