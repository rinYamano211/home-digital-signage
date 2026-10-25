import type { DestinationStream } from "pino";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/loader.js";
import { createLogger } from "./logging/logger.js";
import { installShutdown } from "./shutdown.js";

export async function startBackend(
  env: Readonly<NodeJS.ProcessEnv>,
  destination?: DestinationStream,
) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    createLogger("info", destination).error(
      { event: "config_invalid" },
      "Invalid backend configuration",
    );
    throw new ConfigError();
  }
  // PR-A has no domain requiring a credential, so no Secret is loaded here.
  const logger = createLogger(config.logLevel, destination);
  logger.info({ event: "startup_begin" }, "Backend starting");
  const app = buildApp(logger);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    logger.error({ event: "listen_failed" }, "Backend listen failed");
    await app.close().catch(() => undefined);
    throw new Error("Backend startup failed");
  }
  logger.info({ event: "startup_complete" }, "Backend listening");
  return { app, config, logger };
}

if (import.meta.main) {
  // The only process.env read in application code: take a startup snapshot.
  const environment = { ...process.env };
  try {
    const { app, config, logger } = await startBackend(environment);
    installShutdown(
      app,
      logger,
      config.shutdownTimeoutMs,
      (code) => {
        if (code !== 0) process.exit(code); // Bound hung resources after failure.
        process.exitCode = 0;
      },
      process,
    );
  } catch {
    // The startup boundary has already logged a sanitized error.
    process.exitCode = 1;
  }
}
