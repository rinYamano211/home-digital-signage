import type { DestinationStream } from "pino";
import type { EventEmitter } from "node:events";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { buildApp, registerRoutes } from "./app.js";
import { ConfigError, loadConfig } from "./config/loader.js";
import { createLogger } from "./logging/logger.js";
import { installShutdown } from "./shutdown.js";
import { ExclusiveLock } from "./storage/lock.js";
import {
  BackendStore,
  type RuntimeStoreAccess,
  type StartupStoreAccess,
} from "./storage/store.js";
import { readPublishedStates } from "./published-state-api.js";
import {
  createRuntimeSend,
  type RuntimeSend,
} from "./send/provider-send-gate.js";
import { StateScheduler } from "./scheduler/state-scheduler.js";
import {
  PRODUCTION_PROVIDERS,
  StateAcquisitionCoordinator,
} from "./acquisition/coordinator.js";
import { normalizedBootId, readOsBootId } from "./time/boot-id.js";
import type { StartupResult } from "./storage/startup-transaction.js";
import {
  classifyDatabaseError,
  type DatabaseStatus,
} from "./storage/errors.js";

function startupDatabaseStatus(result: StartupResult): DatabaseStatus {
  switch (result.outcome) {
    case "committed":
      return { state: "HEALTHY" };
    case "rejected":
      return { state: "BLOCKED", layer: "L3", reason: result.reason };
    case "unknown":
      return { state: "BLOCKED", layer: "L4", reason: result.reason };
    case "database_error":
      return {
        state:
          result.layer === "L1" || result.layer === "L2"
            ? "DEGRADED"
            : "BLOCKED",
        layer: result.layer,
        reason: result.reason,
      };
  }
}

interface StartupOptions {
  signals?: Pick<EventEmitter, "on" | "off">;
  finish?: (code: number) => void;
  initializeStore?: (
    lock: ExclusiveLock,
  ) => StartupStoreAccess | Promise<StartupStoreAccess>;
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
  let ownedStore: StartupStoreAccess | undefined;
  let runtime: RuntimeStoreAccess | null = null;
  let send: RuntimeSend | null = null;
  let scheduler: StateScheduler | null = null;
  let finishInitialization!: () => void;
  const initialized = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  app.addHook("onClose", async () => {
    await initialized;
    const store = ownedStore;
    ownedStore = undefined; // One close owner, including failure / Shutdown races.
    const monitoring = send;
    send = null;
    const acquisition = scheduler;
    scheduler = null;
    try {
      // No new Task, then wait for in-flight cycles before closing anything.
      await acquisition?.stop();
      runtime?.acquisitionControl.context.beginShutdown();
      monitoring?.stopMonitoring(); // Close the Gate and Recovery before the DB.
    } finally {
      store?.close();
    }
    if (store) logger.info({ event: "database_closed" }, "Database closed");
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
        try {
          ownedStore = await (
            options.initializeStore ?? BackendStore.openV3ForStartup
          )(lock);
        } catch (error) {
          status = classifyDatabaseError(error);
        }
        // The close hook already owns every returned Store, even if a Signal
        // arrived while Open was pending. It waits for initialization to finish.
        await yieldToSignals();
        if (!shutdown.requested && ownedStore) {
          logger.info(
            { event: "storage_startup_begin" },
            "Storage Startup beginning",
          );
          await yieldToSignals();
          if (!shutdown.requested) {
            lock.assertHeld(); // Lock loss is not a safe Connectivity-only start.
            let bootId: string | null = null;
            try {
              bootId = normalizedBootId(readOsBootId());
            } catch {
              /* fail closed below */
            }
            if (bootId === null) {
              status = {
                state: "BLOCKED",
                layer: "L3",
                reason: "os_boot_id_unverified",
              };
            } else if (!shutdown.requested) {
              // One synchronous attempt only. No Trust, Quota or HTTP authority
              // is exposed by the restricted Store, including after committed.
              status = startupDatabaseStatus(
                ownedStore.startup.execute({ bootId }),
              );
              if (status.state === "HEALTHY") {
                logger.info(
                  { event: "storage_startup_committed" },
                  "Storage Startup committed",
                );
                // DB read access only; no Trust, Quota or send authority.
                runtime = BackendStore.activateRuntime(ownedStore);
                // Trust/History monitoring only; no HTTP adapter yet (C-Impl-5C).
                send = runtime
                  ? createRuntimeSend(
                      ownedStore,
                      PRODUCTION_PROVIDERS.find((p) => p.quota)?.http,
                    )
                  : null;
                if (send) send.startMonitoring();
                else
                  logger.warn(
                    { event: "send_monitoring_unavailable" },
                    "Provider send monitoring unavailable",
                  );
                if (runtime) {
                  scheduler = new StateScheduler(
                    new StateAcquisitionCoordinator(
                      runtime,
                      send,
                      PRODUCTION_PROVIDERS,
                    ),
                    logger,
                  );
                  scheduler.start();
                }
              }
            }
            // Drain Signals queued during synchronous SQLite before any route
            // registration / Listen. Native code is not interrupted by JS.
            await yieldToSignals();
          }
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
    if (shutdown.requested) {
      await shutdown.shutdown();
      return;
    }
    registerRoutes(app, () => readPublishedStates(runtime));
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
