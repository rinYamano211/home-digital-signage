import type { DestinationStream } from "pino";
import type { EventEmitter } from "node:events";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { buildApp, registerRoutes } from "./app.js";
import { ConfigError, loadConfig } from "./config/loader.js";
import { createLogger } from "./logging/logger.js";
import { installShutdown } from "./shutdown.js";
import { ExclusiveLock } from "./storage/lock.js";
import { BackendStore } from "./storage/store.js";
import {
  classifyDatabaseError,
  type DatabaseStatus,
} from "./storage/errors.js";

interface StartupOptions {
  signals?: Pick<EventEmitter, "on" | "off">;
  finish?: (code: number) => void;
  initializeStore?: (
    lock: ExclusiveLock,
  ) => BackendStore | Promise<BackendStore>;
}
export async function startBackend(
  env: Readonly<NodeJS.ProcessEnv>,
  destination?: DestinationStream,
  options: StartupOptions = {},
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
  const logger = createLogger(config.logLevel, destination);
  let lock: ExclusiveLock;
  try {
    lock = ExclusiveLock.inherited(config.dataDirectory);
  } catch {
    logger.error({ event: "lock_required" }, "Exclusive storage lock required");
    throw new Error("Exclusive storage lock required");
  }
  logger.info({ event: "startup_begin" }, "Backend starting");
  const app = buildApp(logger, false);
  let ownedStore: BackendStore | undefined;
  let finishInitialization!: () => void;
  const initialized = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  app.addHook("onClose", async () => {
    await initialized;
    ownedStore?.close();
    if (ownedStore)
      logger.info({ event: "database_closed" }, "Database closed");
  });
  const shutdown = installShutdown(
    app,
    logger,
    config.shutdownTimeoutMs,
    options.finish ??
      ((code) => {
        if (code !== 0) process.exit(code);
        process.exitCode = 0;
      }),
    options.signals ?? process,
  );
  let status: DatabaseStatus = {
    state: "DEGRADED",
    layer: "L2",
    reason: "not_initialized",
  };
  let stage = "database_initialization_failed";
  try {
    try {
      logger.info({ event: "database_initializing" }, "Initializing database");
      await yieldToSignals();
      if (!shutdown.requested) {
        let acquired: BackendStore | undefined;
        try {
          acquired = await (options.initializeStore ?? BackendStore.open)(lock);
          // Yield after synchronous SQLite work so queued signals precede Listen.
          await yieldToSignals();
          if (!shutdown.requested) {
            ownedStore = acquired; // Atomic ownership handoff: no await here.
            acquired = undefined;
            status = { state: "HEALTHY" };
          }
        } catch (error) {
          status = classifyDatabaseError(error);
        } finally {
          acquired?.close();
        }
      }
    } finally {
      finishInitialization();
    }
    if (shutdown.requested) {
      await shutdown.shutdown();
      return;
    }
    logger.info(
      { event: "database_status", ...status },
      "Database startup state",
    );
    registerRoutes(app);
    stage = "listen_failed";
    await app.listen({ host: config.host, port: config.port });
    if (shutdown.requested) {
      await shutdown.shutdown();
      return;
    }
    logger.info({ event: "startup_complete" }, "Backend listening");
    return { app, config, logger, status, shutdown };
  } catch {
    logger.error({ event: stage }, "Backend startup failed");
    await shutdown.shutdown(1);
    throw new Error("Backend startup failed");
  }
}
if (import.meta.main) {
  const environment = { ...process.env };
  try {
    await startBackend(environment);
  } catch {
    process.exitCode = 1;
  }
}
