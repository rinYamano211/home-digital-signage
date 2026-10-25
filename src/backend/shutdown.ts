import type { EventEmitter } from "node:events";
import type { Logger } from "pino";

type Closeable = { close(): Promise<unknown> };

export function installShutdown(
  app: Closeable,
  logger: Logger,
  timeoutMs: number,
  finish: (code: number) => void,
  signals: Pick<EventEmitter, "on" | "off">,
) {
  let pending: Promise<void> | undefined;
  const dispose = () => {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  };
  const shutdown = (exitCode: 0 | 1 = 0): Promise<void> => {
    if (pending) return pending;
    pending = new Promise<void>((resolve) => {
      let completed = false;
      const complete = (code: number, event: string) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        dispose();
        if (code === 0) logger.info({ event }, "Backend stopped");
        else logger.error({ event }, "Backend shutdown failed");
        finish(code);
        resolve();
      };
      // PR-A deadline starts when JS handles the shutdown request. A synchronous
      // SQLite call blocks both signal delivery and this timer; this is not a
      // wall-clock interrupt of native code. Once runnable, timeout exits 1
      // (safe-side forced stop), even if graceful Connection close is unfinished.
      // Keep the deadline alive while closing, then always clear it.
      const timer = setTimeout(
        () => complete(1, "shutdown_timeout"),
        timeoutMs,
      );
      Promise.resolve()
        .then(() => app.close())
        .then(
          () =>
            complete(
              exitCode,
              exitCode === 0 ? "shutdown_complete" : "startup_failed",
            ),
          () => complete(1, "shutdown_failed"),
        );
    });
    return pending;
  };
  function onSignal() {
    void shutdown();
  }
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  return {
    shutdown,
    dispose,
    get requested() {
      return pending !== undefined;
    },
  };
}
