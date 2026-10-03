import { CliError, type ParsedArgs, parseArgs, USAGE } from "./cli.js";
import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { createRelay, createRelayServer } from "./server.js";
import { VERSION } from "./version.js";

function parseOrExit(argv: string[]): ParsedArgs {
  try {
    return parseArgs(argv);
  } catch (error) {
    const message = error instanceof CliError ? error.message : String(error);
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const { overrides, help, version } = parseOrExit(process.argv.slice(2));

  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig(overrides);
  setLogLevel(config.logLevel);

  if (overrides.pat) {
    logger.warn(
      "PAT supplied via --pat may be visible to other users in the process list (ps); prefer the QODER_PAT environment variable",
    );
  }

  if (!config.pat) {
    logger.error(
      "No Qoder Personal Access Token. Pass --pat <pt-...> or set QODER_PAT / QODERCN_PAT in the environment.",
    );
    process.exit(1);
  }

  const ctx = createRelay(config);
  const server = createRelayServer(ctx);

  // Warm the model catalog in the background; failures fall back to static models.
  ctx.catalog.ensureFresh().catch(() => {});

  server.listen(config.port, config.host, () => {
    logger.info("qoder-transfer listening", {
      url: `http://${config.host}:${config.port}`,
      mode: config.mode,
      vpc: config.vpcInstance ?? "public",
      auth: config.clientApiKey ? "required" : "disabled",
      defaultModel: config.defaultModel,
    });
    logger.info("routes", { models: "GET /v1/models", chat: "POST /v1/chat/completions", health: "GET /health" });
  });

  server.on("error", (error) => {
    logger.error("server error", { error: error.message });
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    logger.info(`shutting down (${signal})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
